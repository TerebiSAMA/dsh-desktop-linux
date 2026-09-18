#!/usr/bin/env python3
"""
生成三套托盘图标（蓝/黑/白）×（base/done/ask/ask-faint/fail）×（22/44）。

输出文件写到 ../assets/，覆盖同名文件（base 用 tray.png，其他保持 tray-*.png）。
皮肤切换由 main.js 通过命名约定 (tray-<skin>-<state>.png) 实现。

设计：
  - 纯鲸鱼剪影（无背景色块）：从 assets/icon.png（桌面图标，透明底黑鲸鱼）取形状，
    按皮肤染成鲸鱼本体颜色（蓝/黑/白）。
  - 灯条：鲸鱼下方底部加粗横条（22px 用 2px 高，@2x 4px，宽 70% 居中），
    base 灰色常驻灯槽，done/ask/fail 绿/黄/红。
  - 呼吸：pulse1..6 绿条 alpha 平滑渐变，main.js 以 150ms 间隔循环播放。
"""
from __future__ import annotations
import os, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parent.parent / 'assets'

# 皮肤配色：鲸鱼本体的颜色（无背景）
# blue = DSH 蓝、black = 深黑灰、white = 近白（浅色任务栏上选它）
SKINS = {
    'blue': (77, 107, 254),
    'black': (33, 38, 45),
    'white': (245, 247, 250),
}
STATES = ['base', 'done', 'ask', 'ask-faint', 'fail']
# 灯条颜色：base 灰槽（常驻，略透明）、done 绿、ask 黄、ask-faint 淡黄、fail 红
STATE_BAR = {
    'base': (148, 156, 170, 150),
    'done': (46, 160, 67, 255),
    'ask': (227, 179, 21, 255),
    'ask-faint': (227, 179, 21, 110),
    'fail': (218, 54, 51, 255),
}
# 呼吸帧：60 帧 @ 1000ms 周期（60fps），绿条 alpha 按正弦平滑呼吸（暗→亮→暗）。
# 比之前 6 帧更流畅；1000ms 周期比原先 900ms 慢约 10%。
PULSE_COUNT = 60
def pulse_alphas():
    import math
    n = PULSE_COUNT
    out = []
    for i in range(n):
        v = 0.5 - 0.5 * math.cos(2 * math.pi * i / n)  # 0..1 正弦
        out.append(round(60 + 195 * v))  # 60（暗）→ 255（亮）→ 60，首尾闭合
    return out
PULSE_ALPHAS = pulse_alphas()

FONT_CANDIDATES = [
    '/usr/share/fonts/google-noto-sans-mono-cjk-vf-fonts/NotoSansMonoCJK-VF.ttc',
    '/usr/share/fonts/google-noto-cjk-fonts/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
]

# 鲸鱼 mask 缓存：{size: Image}
_WHALE_CACHE = {}


def find_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def whale_mask(size: int) -> Image.Image | None:
    """从 assets/icon.png（DeepSeek 鲸鱼应用图标）提取形状，缩放到 size×size 的 alpha mask。"""
    if size in _WHALE_CACHE:
        return _WHALE_CACHE[size]
    src = ASSETS / 'icon.png'
    if not src.exists():
        return None
    try:
        icon = Image.open(src).convert('RGBA')
    except Exception:
        return None
    # 图标是 1024×1024；取 alpha 通道，放大 4 倍超采样缩到目标尺寸保持边缘平滑
    alpha = icon.getchannel('A')
    big = alpha.resize((size * 4, size * 4), Image.LANCZOS)
    mask = big.resize((size, size), Image.LANCZOS)
    _WHALE_CACHE[size] = mask
    return mask


def make_icon(size: int, skin: str, state: str) -> Image.Image:
    color = SKINS[skin]
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 纯鲸鱼剪影：无背景色块，直接按皮肤色填充鲸鱼形状
    mask = whale_mask(size)
    if mask is not None:
        solid = Image.new('RGBA', (size, size), color)
        overlay = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        overlay.paste(solid, (0, 0), mask)
        img.alpha_composite(overlay)
    else:
        # 回退：无 icon.png 时画 "D"
        font_size = int(size * 0.62)
        font = find_font(font_size)
        text = 'D'
        bbox = d.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = (size - tw) // 2 - bbox[0]
        ty = (size - th) // 2 - bbox[1] - max(1, size // 22)
        d.text((tx, ty), text, font=font, fill=color)

    # 灯条：鲸鱼下方底部，加粗（22px→2px，@2x→4px），宽 70% 居中。
    # base 灰色常驻灯槽；pulse1..60 绿条 alpha 正弦渐变（60fps 呼吸）。
    bar_h = 2 if size <= 22 else 4
    bar_w = int(size * 0.7)
    x0 = (size - bar_w) // 2
    y0 = size - 1 - bar_h  # 底部
    if state in STATE_BAR:
        d.rectangle([(x0, y0), (x0 + bar_w, y0 + bar_h)], fill=STATE_BAR[state])
    elif state.startswith('pulse'):
        idx = int(state[5:]) - 1  # pulse1..pulse60
        alpha = PULSE_ALPHAS[idx % len(PULSE_ALPHAS)]
        color_bar = STATE_BAR['done'][:3] + (alpha,)
        d.rectangle([(x0, y0), (x0 + bar_w, y0 + bar_h)], fill=color_bar)

    return img


def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    # 兼容旧命名：base 用 tray.png（无 skin 前缀），其他保持原文件名。
    # 这样默认（蓝皮肤）资源还在原路径上，main.js 不改也能跑。
    generated = 0
    all_states = STATES + [f'pulse{i}' for i in range(1, len(PULSE_ALPHAS) + 1)]
    for skin in SKINS:
        for state in all_states:
            for size in (22, 44):
                img = make_icon(size, skin, state)
                suffix = '' if size == 22 else '@2x'
                if skin == 'blue' and state == 'base':
                    name = f'tray{suffix}.png'
                elif skin == 'blue':
                    name = f'tray-{state}{suffix}.png'
                else:
                    name = f'tray-{skin}-{state}{suffix}.png'
                img.save(ASSETS / name)
                generated += 1
    print(f'generated {generated} icons into {ASSETS}')
    return 0


if __name__ == '__main__':
    sys.exit(main())