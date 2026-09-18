window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-lan-allowlist",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 在设置对话框的右侧内容区末尾追加一个"LAN 访问 — IP 白名单"分区。
		// 通过 dshDesktop.lanAllowlist IPC 把用户输入写入
		// ~/.dsh/profiles/web/dsh-lan-proxy-allow.txt；代理每 2s 会自己 watch
		// 这个文件，无需手动重启也能在 2s 内生效。"重启代理"按钮是可选加速。

		const NS = "lanAllowlist";
		const inject = [];

		// 注入 CSS（分区样式 + 表单控件）。用 dsw-* 风格贴近 dsh 自身设计。
		const CSS = `
.la-section {
  border-top: 1px solid var(--dsw-alias-line-2, rgba(127,127,127,0.18));
  margin-top: 24px;
  padding: 24px 8px 8px;
}
.la-section h2 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 500;
}
.la-section p.la-desc {
  margin: 0 0 14px;
  opacity: 0.75;
  font-size: 13px;
  line-height: 1.5;
}
.la-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 140px;
  resize: vertical;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-line-2, rgba(127,127,127,0.25));
  background: var(--dsw-alias-bg-input, transparent);
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.45;
}
.la-textarea:focus {
  outline: 2px solid var(--dsw-alias-line-focus, rgba(120,160,255,0.6));
  outline-offset: -1px;
}
.la-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.la-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-line-2, rgba(127,127,127,0.3));
  background: var(--dsw-alias-bg-2, rgba(127,127,127,0.08));
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
.la-btn:hover { background: var(--dsw-alias-bg-hover, rgba(127,127,127,0.16)); }
.la-btn.la-primary {
  background: var(--dsw-alias-accent, #4d6bfe);
  border-color: transparent;
  color: #fff;
}
.la-btn.la-primary:hover { filter: brightness(1.08); }
.la-status {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.8;
  min-height: 16px;
}
.la-status.la-ok { color: #2e9b3f; }
.la-status.la-err { color: #c0392b; }
.la-path {
  display: block;
  margin-top: 12px;
  padding: 6px 8px;
  background: rgba(127,127,127,0.08);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
}
`;

		function injectStyle() {
			if (document.getElementById('la-style')) return;
			const s = document.createElement('style');
			s.id = 'la-style';
			s.setAttribute('data-source', 'dsh-client-ui-lan-allowlist');
			s.textContent = CSS;
			document.documentElement.appendChild(s);
		}

		function buildSection() {
			const root = document.createElement('div');
			root.className = 'la-section';
			root.setAttribute('data-source', 'dsh-client-ui-lan-allowlist');
			root.innerHTML = `
				<h2>LAN 访问 — IP 白名单</h2>
				<p class="la-desc">每行一个 IPv4 / IPv6 地址（# 开头为注释）。保存后代理 2 秒内自动重读；点"重启代理"立即生效。</p>
				<textarea class="la-textarea" placeholder="例如：&#10;192.168.x.y&#10;# 192.168.x.z&#10;10.0.0.0/24"></textarea>
				<div class="la-actions">
					<button class="la-btn la-primary" data-act="save">保存</button>
					<button class="la-btn" data-act="reload">重新加载</button>
					<button class="la-btn" data-act="restart">重启代理</button>
				</div>
				<div class="la-status"></div>
				<code class="la-path" title="白名单文件路径"></code>
			`;
			return root;
		}

		async function loadInto(section) {
			const ta = section.querySelector('textarea');
			const pathEl = section.querySelector('.la-path');
			const status = section.querySelector('.la-status');
			status.textContent = '加载中…';
			status.className = 'la-status';
			try {
				const r = await window.dshDesktop.lanAllowlist.read();
				if (!r.ok) throw new Error(r.error || 'read failed');
				ta.value = r.content || '';
				pathEl.textContent = '文件: ' + (r.path || '~/.dsh/profiles/web/dsh-lan-proxy-allow.txt');
				status.textContent = r.content ? '已加载（' + r.content.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length + ' 条目）' : '空文件（保存任意 IP 启用白名单）';
			} catch (e) {
				status.textContent = '加载失败: ' + e.message;
				status.className = 'la-status la-err';
			}
		}

		async function saveFrom(section) {
			const ta = section.querySelector('textarea');
			const status = section.querySelector('.la-status');
			status.textContent = '保存中…';
			status.className = 'la-status';
			try {
				const r = await window.dshDesktop.lanAllowlist.write({ content: ta.value });
				if (!r.ok) throw new Error(r.error || 'write failed');
				const entries = ta.value.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
				status.textContent = '已保存 ' + entries.length + ' 条目；代理 ≤2s 内自动重读。';
				status.className = 'la-status la-ok';
			} catch (e) {
				status.textContent = '保存失败: ' + e.message;
				status.className = 'la-status la-err';
			}
		}

		async function restartProxy(section) {
			const status = section.querySelector('.la-status');
			status.textContent = '重启代理…';
			status.className = 'la-status';
			try {
				const r = await window.dshDesktop.restartLanProxy();
				if (!r.ok) throw new Error(r.error || 'restart failed');
				status.textContent = '已重启。';
				status.className = 'la-status la-ok';
			} catch (e) {
				status.textContent = '重启失败: ' + e.message + '（可手动：systemctl --user restart dsh-lan-proxy.service）';
				status.className = 'la-status la-err';
			}
		}

		function attachHandlers(section) {
			section.querySelector('[data-act="save"]').addEventListener('click', () => saveFrom(section));
			section.querySelector('[data-act="reload"]').addEventListener('click', () => loadInto(section));
			section.querySelector('[data-act="restart"]').addEventListener('click', () => restartProxy(section));
		}

		function tryInjectInto(content) {
			if (content.querySelector('[data-source="dsh-client-ui-lan-allowlist"]')) return;
			const section = buildSection();
			attachHandlers(section);
			content.appendChild(section);
			loadInto(section);
		}

		function apply(ctx) {
			ctx.effect(() => {
				injectStyle();
				const mo = new MutationObserver(() => {
					if (!window.dshDesktop) return;
					const overlays = document.querySelectorAll('.VOzbGW_overlay');
					overlays.forEach((overlay) => {
						const content = overlay.querySelector('.VOzbGW_content');
						if (content) tryInjectInto(content);
					});
				});
				mo.observe(document.documentElement, { subtree: true, childList: true });
				return () => { mo.disconnect(); };
			}, "ui-lan-allowlist: settings section");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
