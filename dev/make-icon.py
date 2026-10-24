"""生成插件管家的图标资源（assets/icon-180.png、assets/icon-512.png）。

纯 Pillow 绘制，无外部素材：深色圆角底 + 四行「开关」暗示插件列表，
前三行开、最后一行关，用绿色/灰色区分。
用法：python dev/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"

SS = 4  # 超采样倍数
BASE = 512
S = BASE * SS

BG_TOP = (27, 31, 39)
BG_BOTTOM = (38, 44, 56)
GLYPH = (120, 130, 148)
ON = (74, 222, 128)
OFF = (78, 85, 99)
KNOB = (245, 247, 250)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main() -> None:
    img = Image.new("RGB", (S, S), BG_TOP)
    d = ImageDraw.Draw(img)

    # 竖向渐变背景
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / (S - 1)))

    # 四行开关
    rows = 4
    row_h = 56 * SS
    gap = 40 * SS
    total = rows * row_h + (rows - 1) * gap
    y = (S - total) // 2
    glyph_w = 44 * SS
    pill_w, pill_h = 132 * SS, 56 * SS
    pill_x = 512 * SS - 96 * SS - pill_w

    for i in range(rows):
        cy = y + row_h // 2
        # 左侧小方块（代表插件条目）
        gx = 96 * SS
        d.rounded_rectangle(
            [gx, cy - glyph_w // 2, gx + glyph_w, cy + glyph_w // 2],
            radius=12 * SS,
            fill=GLYPH,
        )
        # 右侧胶囊开关
        is_on = i < rows - 1
        color = ON if is_on else OFF
        d.rounded_rectangle(
            [pill_x, cy - pill_h // 2, pill_x + pill_w, cy + pill_h // 2],
            radius=pill_h // 2,
            fill=color,
        )
        knob_r = 20 * SS
        knob_x = pill_x + pill_w - pill_h // 2 if is_on else pill_x + pill_h // 2
        d.ellipse(
            [knob_x - knob_r, cy - knob_r, knob_x + knob_r, cy + knob_r],
            fill=KNOB,
        )
        y += row_h + gap

    # 圆角遮罩
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=112 * SS, fill=255)
    out = Image.new("RGB", (S, S), (0, 0, 0))
    out.paste(img, (0, 0), mask)

    OUT.mkdir(parents=True, exist_ok=True)
    for size in (180, 512):
        out.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
        print("wrote", (OUT / f"icon-{size}.png").relative_to(ROOT))


if __name__ == "__main__":
    main()
