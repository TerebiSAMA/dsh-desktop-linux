#!/usr/bin/env node
// dsh-lan-proxy: byte-level reverse proxy that re-issues dsh's HMAC-signed
// browser cookie against a chosen LAN authority.
//
// Why: dsh only binds 127.0.0.1 (and the shipped npm bundle hard-blocks
// 0.0.0.0 even with DSH_ALLOW_PUBLIC_BIND). This proxy binds 0.0.0.0 on
// any LAN-facing port, forwards every request to 127.0.0.1:3080 with a
// fixed Host header, and reuses the cookie dsh mints on first contact.
//
// Configuration (env):
//   DSH_LAN_HOST        LAN-visible IP the proxy advertises (e.g. 192.168.x.x)
//   DSH_LAN_PORT        LAN-visible port (default 5080)
//   DSH_UPSTREAM        dsh upstream (default http://127.0.0.1:3080)
//   DSH_TOKEN_FILE      file containing DSH_TOKEN=<token> (re-read on stale)
//   DSH_COOKIE_TTL_MS   cookie reuse window; re-prime after this
//   DSH_ALLOWED_REMOTE  comma-separated whitelist of allowed remote IPs
//                       (loopback always allowed; empty = allow all)

const http = require('node:http');
const fs = require('node:fs');
const zlib = require('node:zlib');

// Comma-separated whitelist of allowed remote addresses; loopback
// (127.0.0.0/8 and ::1) is always permitted. Empty list = allow all remote.
const ALLOWED_REMOTE = (process.env.DSH_ALLOWED_REMOTE || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Optional second source: a newline-separated IP list written by the
// `dsh-client-ui-lan-allowlist` web plugin (the user edits it in the
// dsh GUI Settings → LAN access). Loopback still always allowed.
const ALLOW_FILE = process.env.DSH_ALLOW_FILE || '';
let ALLOWED_REMOTE_FILE = [];
function reloadAllowFile() {
  if (!ALLOW_FILE) { ALLOWED_REMOTE_FILE = []; return; }
  try {
    const raw = fs.readFileSync(ALLOW_FILE, 'utf8');
    ALLOWED_REMOTE_FILE = raw.split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  } catch (err) {
    // ENOENT just means the user hasn't saved anything yet — silent.
    if (err.code !== 'ENOENT') {
      console.error(`[proxy] failed to read ${ALLOW_FILE}: ${err.message}`);
    }
    ALLOWED_REMOTE_FILE = [];
  }
}
reloadAllowFile();

function isLoopback(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

function remoteIpAllowed(ip) {
  if (isLoopback(ip)) return true;
  if (ALLOWED_REMOTE.includes(ip)) return true;
  if (ALLOWED_REMOTE_FILE.includes(ip)) return true;
  // Empty both = allow all remote (legacy behaviour, documented in README).
  if (ALLOWED_REMOTE.length === 0 && ALLOWED_REMOTE_FILE.length === 0) return true;
  return false;
}

// Fill in via the systemd unit (Environment=DSH_LAN_HOST=...) or an .env file.
// LAN_HOST is the IP other machines on your network will visit.
const LAN_HOST    = process.env.DSH_LAN_HOST    || '127.0.0.1';
const LAN_PORT    = Number(process.env.DSH_LAN_PORT || 5080);
const UPSTREAM    = process.env.DSH_UPSTREAM    || 'http://127.0.0.1:3080';
const TOKEN_FILE  = process.env.DSH_TOKEN_FILE  || '';
const COOKIE_TTL  = Number(process.env.DSH_COOKIE_TTL_MS || 10 * 60 * 1000);
const AUTH_HOST_HEADER = `${LAN_HOST}:${LAN_PORT}`;

let cachedCookie = null;
let cachedCookieIssuedAt = 0;
let cachedCookieExpiresAt = 0;
let cachedTokenFingerprint = '';

function readToken() {
  if (!TOKEN_FILE) return process.env.DSH_TOKEN || '';
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^DSH_TOKEN=(.+)$/);
      if (m) return m[1].trim();
    }
  } catch (err) {
    console.error(`[proxy] failed to read ${TOKEN_FILE}: ${err.message}`);
  }
  return process.env.DSH_TOKEN || '';
}

async function primeCookie(token) {
  const url = new URL(UPSTREAM + '/');
  url.searchParams.set('token', token);
  console.log(`[proxy] priming cookie via ${url.href} (Host: ${AUTH_HOST_HEADER})`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3080,
      method: 'GET',
      path: url.pathname + url.search,
      headers: {
        host: AUTH_HOST_HEADER,
        'user-agent': 'dsh-lan-proxy/1.0',
        accept: '*/*',
      },
    }, (res) => {
      const setCookies = res.headers['set-cookie'] || [];
      const auth = setCookies.length > 0 ? setCookies[0].split(';')[0] : null;
      res.resume();
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 303) {
          if (!auth) return reject(new Error(`no cookie in Set-Cookie (status=${res.statusCode})`));
          resolve(auth);
        } else {
          reject(new Error(`upstream status=${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureCookie() {
  // Detect rotation: if token changed since last prime, force re-prime.
  const tok = readToken();
  const fp = tok.slice(0, 8) + '|' + tok.length;
  const now = Date.now();
  if (cachedCookie && fp === cachedTokenFingerprint && now < cachedCookieExpiresAt - 30_000) {
    return cachedCookie;
  }
  try {
    const cookie = await primeCookie(tok);
    cachedCookie = cookie;
    cachedCookieIssuedAt = now;
    cachedCookieExpiresAt = now + COOKIE_TTL;
    cachedTokenFingerprint = fp;
    console.log(`[proxy] cookie primed (token ${fp}, ttl ${Math.round(COOKIE_TTL/60_000)}min)`);
    return cookie;
  } catch (err) {
    cachedCookie = null;
    throw err;
  }
}

const HOP_BY_HOP = new Set([
  'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding',
]);
// WebSocket upgrade responses MUST retain `Connection` and `Upgrade`
// headers so the browser recognises 101 Switching Protocols.

function copyHeaders(src, dst) {
  for (const [name, value] of Object.entries(src)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'set-cookie') continue;       // dsh sends Set-Cookie on every redirect; we own cookies.
    if (lower === 'content-encoding') continue; // we decode bodies ourselves; signal identity
    if (lower === 'content-length') continue;   // body size changes after decode
    if (lower === 'location') {
      try {
        const loc = new URL(value, UPSTREAM);
        // Re-root any redirect that targets the upstream back onto our authority.
        if (loc.host === '127.0.0.1:3080') {
          dst.location = `${loc.protocol}//${AUTH_HOST_HEADER}${loc.pathname}${loc.search}${loc.hash}`;
          continue;
        }
      } catch { /* fallthrough */ }
    }
    dst[name] = value;
  }
}

function decompressStream(encoding, stream) {
  switch ((encoding || '').toLowerCase()) {
    case 'gzip':
      return stream.pipe(zlib.createGunzip());
    case 'deflate':
      return stream.pipe(zlib.createInflate());
    case 'br':
      return stream.pipe(zlib.createBrotliDecompress());
    default:
      return stream;
  }
}

async function proxyRequest(clientReq, clientRes) {
  let cookie;
  try { cookie = await ensureCookie(); }
  catch (err) {
    console.error('[proxy] cookie priming failed:', err.message);
    clientRes.writeHead(502, { 'content-type': 'text/plain' });
    clientRes.end(`dsh-lan-proxy: upstream auth unavailable (${err.message})`);
    return;
  }

  const u = new URL(clientReq.url, `http://${AUTH_HOST_HEADER}`);
  const pathQuery = (u.pathname || '/') + (u.search || '');

  const headers = { ...clientReq.headers };
  headers.host = AUTH_HOST_HEADER;
  headers.cookie = cookie;
  // Rewrite Origin / Referer to the LAN authority so dsh's
  // "host fence" sees Origin === host (otherwise it rejects as
  // cross-origin with 403).
  if (typeof headers.origin === 'string') {
    try {
      const o = new URL(headers.origin);
      o.host = AUTH_HOST_HEADER;
      o.protocol = 'http:';
      headers.origin = o.toString().replace(/\/$/, '');
    } catch { /* leave unchanged */ }
  }
  if (typeof headers.referer === 'string') {
    try {
      const r = new URL(headers.referer);
      r.host = AUTH_HOST_HEADER;
      r.protocol = 'http:';
      headers.referer = r.toString();
    } catch { /* leave unchanged */ }
  }

  const upReq = http.request({
    hostname: '127.0.0.1',
    port: 3080,
    method: clientReq.method,
    path: pathQuery,
    headers,
  }, (upRes) => {
    if (upRes.statusCode === 401) {
      upRes.resume();
      cachedCookie = null;
      console.warn('[proxy] upstream 401, forcing re-priming');
      // Try one more time after invalidating cache.
      proxyRequest(clientReq, clientRes);
      return;
    }
    const outHeaders = {};
    copyHeaders(upRes.headers, outHeaders);
    clientRes.writeHead(upRes.statusCode || 502, outHeaders);
    const decoded = decompressStream(upRes.headers['content-encoding'], upRes);
    decoded.on('error', (err) => {
      console.error('[proxy] decompress error:', err.message);
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end(`dsh-lan-proxy: decompress error: ${err.message}`);
    });
    decoded.pipe(clientRes);
  });
  upReq.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message);
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(`dsh-lan-proxy: upstream error: ${err.message}`);
  });
  clientReq.pipe(upReq);
}

const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!remoteIpAllowed(ip)) {
    console.warn(`[proxy] denied ${ip} ${req.method} ${req.url}`);
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  proxyRequest(req, res).catch((err) => {
    console.error('[proxy] unhandled error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end('dsh-lan-proxy: internal error');
  });
});

server.on('upgrade', (clientReq, clientSocket, clientHead) => {
  const ip = clientReq.socket.remoteAddress || '';
  if (!remoteIpAllowed(ip)) {
    console.warn(`[proxy] denied ws upgrade from ${ip}`);
    const statusLine = `HTTP/1.1 403 Forbidden\r\ncontent-length: 9\r\nconnection: close\r\n\r\nforbidden`;
    clientSocket.write(statusLine);
    clientSocket.destroy();
    return;
  }
  ensureCookie().then((cookie) => {
    const u = new URL(clientReq.url, `http://${AUTH_HOST_HEADER}`);
    const headers = { ...clientReq.headers };
    headers.host = AUTH_HOST_HEADER;
    headers.cookie = cookie;
    const upReq = http.request({
      hostname: '127.0.0.1',
      port: 3080,
      method: 'GET',
      path: u.pathname + (u.search || ''),
      headers,
    });
    // If upstream rejects the upgrade with a non-101 response, forward it
    // back so the browser sees the real status instead of hanging.
    upReq.on('response', (upRes) => {
      console.warn(`[proxy] ws upstream rejected with HTTP ${upRes.statusCode}`);
      const statusLine = `HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage}`;
      const out = [statusLine];
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out.push(`${k}: ${v}`);
      }
      out.push('', '');
      clientSocket.write(out.join('\r\n'));
      upRes.pipe(clientSocket);
      upRes.on('end', () => clientSocket.end());
    });
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      const statusLine = `HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage}`;
      const out = [statusLine];
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) out.push(`${k}: ${v}`);
      }
      out.push('', '');
      clientSocket.write(out.join('\r\n'));
      if (upHead) clientSocket.write(Buffer.concat([clientHead, upHead]));
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    });
    upReq.on('error', (err) => {
      console.error('[proxy] ws upstream error:', err.message);
      clientSocket.destroy();
    });
    if (clientHead) upReq.write(clientHead);
    upReq.end();
  }).catch((err) => {
    console.error('[proxy] ws auth priming failed:', err.message);
    clientSocket.destroy();
  });
});

server.listen(LAN_PORT, '0.0.0.0', () => {
  console.log(`[proxy] dsh-lan-proxy listening on 0.0.0.0:${LAN_PORT}`);
  console.log(`[proxy] upstream=${UPSTREAM}, authority=${AUTH_HOST_HEADER}`);
  console.log(`[proxy] token source: ${TOKEN_FILE || 'env DSH_TOKEN'}`);
  if (ALLOW_FILE) {
    console.log(`[proxy] allow file: ${ALLOW_FILE} (${ALLOWED_REMOTE_FILE.length} entries, watching for changes)`);
  }
  const staticList = ALLOWED_REMOTE.length ? ALLOWED_REMOTE.join(', ') : '(none)';
  console.log(`[proxy] remote whitelist: loopback${ALLOWED_REMOTE.length ? ' + ' + staticList : ' + (file)'}`);
  if (TOKEN_FILE) {
    fs.watchFile(TOKEN_FILE, { interval: 2000 }, () => {
      console.log('[proxy] token file changed; will re-prime on next request');
      cachedCookie = null;
      cachedCookieExpiresAt = 0;
    });
  }
  if (ALLOW_FILE) {
    fs.watchFile(ALLOW_FILE, { interval: 2000 }, () => {
      reloadAllowFile();
      console.log(`[proxy] allow file changed; new whitelist = ${ALLOWED_REMOTE_FILE.join(', ') || '(empty)'}`);
    });
  }
  ensureCookie().catch((err) => {
    console.error('[proxy] initial cookie prime failed:', err.message);
  });
});
