"""Export the selected two-tone folded P from one shared vector definition.

SVG is used by the portal; PNG/ICO are compatibility assets. Pillow is only
a development-time export dependency, never a front-end/runtime requirement.
Run: python scripts/export-planning-icon.py
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "portal" / "assets"
BACKGROUND = "#F3EDFF"
PRIMARY = "#6550B9"
FOLD = "#8B75C9"

# Vector reconstruction of the user-selected fourth P concept. Coordinates
# describe the icon tile itself, without the image-generation preview margin.
# SVG and raster exports consume these same paths, with no font dependency.
P_OUTLINE = [
    ("M", 14.8, 10.2), ("L", 39.4, 10.2),
    ("C", 47.7, 10.2, 52.8, 16.2, 52.8, 24.6),
    ("C", 52.8, 33.1, 47.5, 39.3, 39.4, 39.3),
    ("L", 24.8, 39.3), ("L", 24.8, 56.3),
    ("L", 14.8, 56.3), ("Z",),
]
P_COUNTER = [
    ("M", 24.8, 19.4), ("L", 38.9, 19.4),
    ("C", 42.1, 19.4, 43.3, 21.8, 43.3, 24.7),
    ("C", 43.3, 27.7, 41.5, 30.2, 38.9, 30.2),
    ("L", 24.8, 30.2), ("Z",),
]
P_FOLD = [
    ("M", 14.8, 20.2), ("L", 24.8, 30.2),
    ("L", 24.8, 56.3), ("L", 14.8, 56.3), ("Z",),
]
PATHS = [(P_OUTLINE, PRIMARY), (P_COUNTER, BACKGROUND), (P_FOLD, FOLD)]


def svg_source() -> str:
    result = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" role="img" aria-labelledby="planning-title planning-description">',
        '  <title id="planning-title">计划部双色折带 P 图标</title>',
        '  <desc id="planning-description">浅紫圆角方形内，深紫色的 P 字上部与柔紫色竖笔以斜向折角相接。</desc>',
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
    parser = argparse.ArgumentParser(description="Export the selected folded-P SVG, PNG and ICO assets.")
    parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "planning-icon.svg").write_text(svg_source(), encoding="utf-8", newline="\n")
    render_png(512).save(OUTPUT / "planning-icon.png", optimize=True)
    render_png(180).save(OUTPUT / "apple-touch-icon.png", optimize=True)
    render_png(32).save(OUTPUT / "favicon-32.png", optimize=True)
    render_png(64).save(OUTPUT / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("Exported folded P: SVG, 512/180/32 PNG, 16/32/48/64 ICO (portal assets only).")


if __name__ == "__main__":
    main()