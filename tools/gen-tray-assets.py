#!/usr/bin/env python3
"""
生成三套托盘图标（蓝/黑/白）×（base/done/ask/ask-faint/fail）×（22/44）。

输出文件写到 ../assets/，覆盖同名文件（base 用 tray.png，其他保持 tray-*.png）。
皮肤切换由 main.js 通过命名约定 (tray-<skin>-<state>.png) 实现。

设计：
  - 圆角矩形 22×22 占比 100%（@2x 是 44×44）
  - 字体：Noto Sans Mono CJK，渲染字符 "D"
  - 状态条：顶部 1px（@2x 2px）的彩色横条
"""
from __future__ import annotations
import os, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parent.parent / 'assets'

# 皮肤配色：(bg, fg, name)
# bg: 圆角矩形底色; fg: "D" 前景色; 状态条颜色硬编码（绿/黄/红）
SKINS = {
    'blue': {'bg': (77, 107, 254, 255),  'fg': (255, 255, 255, 255)},
    'black': {'bg': (33, 38, 45, 255),    'fg': (240, 246, 252, 255)},
    'white': {'bg': (245, 247, 250, 255), 'fg': (13, 17, 23, 255)},
}
STATES = ['base', 'done', 'ask', 'ask-faint', 'fail']
STATE_BAR = {
    'done': (46, 160, 67, 255),     # 绿
    'ask': (227, 179, 21, 255),     # 黄（亮）
    'ask-faint': (227, 179, 21, 110),  # 黄（淡）
    'fail': (218, 54, 51, 255),     # 红
}

FONT_CANDIDATES = [
    '/usr/share/fonts/google-noto-sans-mono-cjk-vf-fonts/NotoSansMonoCJK-VF.ttc',
    '/usr/share/fonts/google-noto-cjk-fonts/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
]


def find_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make_icon(size: int, skin: str, state: str) -> Image.Image:
    pal = SKINS[skin]
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角矩形
    r = max(2, size // 5)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=r, fill=pal['bg'])

    # 中央字符 "D"
    font_size = int(size * 0.62)
    font = find_font(font_size)
    text = 'D'
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = (size - th) // 2 - bbox[1] - max(1, size // 22)  # 视觉居中微调
    d.text((tx, ty), text, font=font, fill=pal['fg'])

    # 状态条：顶部 1px（@2x 2px）横条，宽度收窄到 60% 居中
    if state in STATE_BAR:
        bar_h = 1 if size <= 22 else 2
        bar_w = int(size * 0.6)
        x0 = (size - bar_w) // 2
        d.rectangle([(x0, 1), (x0 + bar_w, 1 + bar_h)], fill=STATE_BAR[state])

    return img


def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    # 兼容旧命名：base 用 tray.png（无 skin 前缀），其他保持原文件名。
    # 这样默认（蓝皮肤）资源还在原路径上，main.js 不改也能跑。
    generated = 0
    for skin in SKINS:
        for state in STATES:
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