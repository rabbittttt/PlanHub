"""Export the approved freeform open P from one shared vector definition.

The mark keeps a straight vertical stem, an asymmetric open bowl and a small
pale-blue facet at their junction. SVG and PNG/ICO share these paths. Pillow is
only a development-time exporter, never a front-end/runtime requirement.
Run from this project: ../.venv/Scripts/python.exe scripts/export-planning-icon.py
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "portal" / "assets"
BACKGROUND = "#FFFFFF"
PRIMARY = "#005AC3"
STEM = "#1A9BF9"
FOLD = "#B3E2FE"
INNER_EDGE = "#0382DE"

# Native vector reconstruction of the user's approved refinement of concept 3
# (2026-11-04). Source-space coordinates preserve the chosen freeform outline;
# the transform removes the generated preview margin, not any part of the P.
# The lower stem stays between x=250 and x=418, with a flat end.
# Its bottom extends by 84 source units to give the P a longer upright.
P_OUTLINE = [
    ("M", 250, 553),
    ("C", 250, 377, 487, 228, 769, 228),
    ("C", 956, 228, 1090, 315, 1090, 436),
    ("C", 1090, 586, 924, 700, 730, 742),
    ("C", 655, 758, 568, 757, 517, 736),
    ("C", 503, 732, 504, 725, 521, 721),
    ("C", 722, 689, 888, 612, 888, 507),
    ("C", 888, 437, 752, 393, 624, 393),
    ("C", 513, 393, 451, 424, 418, 463),
    ("C", 386, 501, 388, 569, 403, 631),
    ("C", 409, 658, 418, 690, 418, 722),
    ("L", 418, 1104),
    ("C", 418, 1114, 413, 1119, 404, 1119),
    ("L", 265, 1119),
    ("C", 255, 1119, 250, 1114, 250, 1104),
    ("Z",),
]
P_STEM = [
    ("M", 250, 553),
    ("C", 276, 477, 421, 400, 598, 393),
    ("C", 473, 413, 395, 470, 393, 551),
    ("C", 390, 605, 417, 662, 418, 702),
    ("L", 418, 1104),
    ("C", 418, 1114, 413, 1119, 404, 1119),
    ("L", 265, 1119),
    ("C", 255, 1119, 250, 1114, 250, 1104),
    ("Z",),
]
P_INNER_EDGE = [
    ("M", 598, 393),
    ("C", 470, 420, 392, 470, 392, 553),
    ("C", 391, 598, 404, 632, 412, 668),
    ("C", 399, 622, 390, 594, 387, 559),
    ("C", 378, 478, 440, 419, 598, 393),
    ("Z",),
]
P_FOLD = [
    ("M", 250, 553),
    ("C", 250, 468, 378, 403, 598, 393),
    ("C", 482, 405, 322, 473, 250, 553),
    ("Z",),
]


def icon_coordinates(commands: list[tuple]) -> list[tuple]:
    """Fit the approved outline into a 64-unit tile with balanced margins."""
    result = []
    for command in commands:
        values = [command[0]]
        for index, value in enumerate(command[1:]):
            origin, offset = (250, 8) if index % 2 == 0 else (228, 6.6)
            values.append(round((value - origin) * 48 / 840 + offset, 4))
        result.append(tuple(values))
    return result


PATHS = [(icon_coordinates(commands), fill) for commands, fill in [
    (P_OUTLINE, PRIMARY), (P_STEM, STEM),
    (P_INNER_EDGE, INNER_EDGE), (P_FOLD, FOLD),
]]


def svg_source() -> str:
    result = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" role="img" aria-labelledby="planning-title planning-description">',
        '  <title id="planning-title">\u8ba1\u5212\u90e8\u81ea\u7531\u5f00\u53e3 P \u56fe\u6807</title>',
        '  <desc id="planning-description">\u767d\u8272\u5706\u89d2\u5e95\u4e0a\u7684\u84dd\u8272 P\uff0c\u76f4\u7ad6\u8fde\u63a5\u4e0d\u5bf9\u79f0\u5f00\u53e3\u5706\u8179\uff0c\u8854\u63a5\u5904\u5e26\u6709\u6d45\u84dd\u6298\u9762\u3002</desc>',
        f'  <rect width="64" height="64" rx="10" fill="{BACKGROUND}"/>',
    ]
    for commands, fill in PATHS:
        data = ' '.join(str(value) for command in commands for value in command)
        result.append(f'  <path d="{data}" fill="{fill}"/>')
    return '\n'.join(result + ['</svg>', ''])


def path_points(commands: list[tuple]) -> list[tuple[float, float]]:
    """Flatten the shared cubic curves at master resolution for Pillow."""
    points = []
    current = (0.0, 0.0)
    for command in commands:
        if command[0] in {"M", "L"}:
            current = (command[1], command[2])
            points.append(current)
        elif command[0] == "C":
            start = current
            control1, control2, end = command[1:3], command[3:5], command[5:7]
            for step in range(1, 65):
                t = step / 64
                u = 1 - t
                points.append(tuple(u**3 * start[axis] + 3 * u**2 * t * control1[axis]
                                    + 3 * u * t**2 * control2[axis] + t**3 * end[axis]
                                    for axis in (0, 1)))
            current = end
    return points


def render_png(size: int) -> Image.Image:
    scale = 32
    image = Image.new("RGBA", (64 * scale, 64 * scale), (0, 0, 0, 0))
    drawing = ImageDraw.Draw(image)
    drawing.rounded_rectangle((0, 0, 64 * scale - 1, 64 * scale - 1),
                              radius=10 * scale, fill=BACKGROUND)
    for commands, fill in PATHS:
        drawing.polygon([(round(x * scale), round(y * scale)) for x, y in path_points(commands)], fill=fill)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the approved freeform open-P SVG, PNG and ICO assets.")
    parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "planning-icon.svg").write_text(svg_source(), encoding="utf-8", newline="\n")
    render_png(512).save(OUTPUT / "planning-icon.png", optimize=True)
    render_png(180).save(OUTPUT / "apple-touch-icon.png", optimize=True)
    render_png(32).save(OUTPUT / "favicon-32.png", optimize=True)
    render_png(64).save(OUTPUT / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("Exported approved open P: SVG, 512/180/32 PNG, 16/32/48/64 ICO (portal assets only).")


if __name__ == "__main__":
    main()
