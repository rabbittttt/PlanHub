"""Export the Planning Workspace icon from one shared geometric definition.

SVG is used by the app; PNG/ICO are compatibility assets. Pillow is only a
development-time export dependency, never a front-end/runtime requirement.
Run: python scripts/export-planning-icon.py
"""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "portal" / "assets"
BLUE = "#245CDD"
WHITE = "#FFFFFF"
MINT = "#67E8D3"

# Coordinates use a 64 px viewBox. A wide calendar frame gives the mark its
# silhouette; two schedule slots and one advancing route remain clear at 16 px.
SHAPES = [
    {"kind": "rect", "x": 0, "y": 0, "w": 64, "h": 64, "r": 15, "fill": BLUE},
    {"kind": "rect", "x": 14, "y": 17, "w": 36, "h": 35, "r": 6,
     "fill": None, "stroke": WHITE, "width": 4},
    {"kind": "line", "points": [(24, 12), (24, 21)], "stroke": WHITE, "width": 4.5},
    {"kind": "line", "points": [(40, 12), (40, 21)], "stroke": WHITE, "width": 4.5},
    {"kind": "line", "points": [(15, 28), (49, 28)], "stroke": WHITE, "width": 3.5},
    {"kind": "rect", "x": 21, "y": 34, "w": 5.5, "h": 5.5, "r": 1.5, "fill": WHITE},
    {"kind": "rect", "x": 21, "y": 43, "w": 5.5, "h": 5.5, "r": 1.5, "fill": WHITE},
    {"kind": "line", "points": [(32, 45), (43, 34)], "stroke": MINT, "width": 4},
    {"kind": "line", "points": [(34, 34), (43, 34), (43, 43)], "stroke": MINT, "width": 4},
]


def svg_source() -> str:
    result = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" role="img" aria-labelledby="planning-title planning-description">',
        '  <title id="planning-title">计划部工作台</title>',
        '  <desc id="planning-description">蓝色圆角方形内，白色日历与计划节点结合青绿色向前箭头，表示有序计划、协同推进。</desc>',
    ]
    for shape in SHAPES:
        if shape["kind"] == "rect":
            attributes = ' '.join(f'{name}="{shape[key]}"' for name, key in
                                  [("x", "x"), ("y", "y"), ("width", "w"), ("height", "h"), ("rx", "r")])
            attributes += f' fill="{shape["fill"] or "none"}"'
            if shape.get("stroke"):
                attributes += f' stroke="{shape["stroke"]}" stroke-width="{shape["width"]}"'
            result.append(f'  <rect {attributes}/>')
        else:
            points = ' '.join(f'{x},{y}' for x, y in shape["points"])
            result.append(f'  <polyline points="{points}" fill="none" stroke="{shape["stroke"]}" stroke-width="{shape["width"]}" stroke-linecap="round" stroke-linejoin="round"/>')
    return '\n'.join(result + ['</svg>', ''])


def render_png(size: int) -> Image.Image:
    # A common 2048 px master avoids size-specific pixel geometry and preserves
    # the transparent outside corners when making the tiny browser tab icon.
    scale = 32
    image = Image.new("RGBA", (64 * scale, 64 * scale), (0, 0, 0, 0))
    drawing = ImageDraw.Draw(image)

    def rounded_rect(x, y, w, h, r, fill):
        drawing.rounded_rectangle((round(x * scale), round(y * scale), round((x + w) * scale), round((y + h) * scale)),
                                  radius=round(r * scale), fill=fill)

    for shape in SHAPES:
        if shape["kind"] == "rect":
            x, y, w, h, r = (shape[key] for key in ["x", "y", "w", "h", "r"])
            if shape.get("stroke"):
                half = shape["width"] / 2
                rounded_rect(x - half, y - half, w + 2 * half, h + 2 * half, r + half, shape["stroke"])
                # The frame interior exposes the same blue canvas beneath it.
                rounded_rect(x + half, y + half, w - 2 * half, h - 2 * half, max(0, r - half), BLUE)
            else:
                rounded_rect(x, y, w, h, r, shape["fill"])
        else:
            points = [(round(x * scale), round(y * scale)) for x, y in shape["points"]]
            width = round(shape["width"] * scale)
            drawing.line(points, fill=shape["stroke"], width=width, joint="curve")
            radius = shape["width"] * scale / 2
            # Matching SVG round caps and joins, also on the route's elbow.
            for x, y in points:
                drawing.ellipse((round(x - radius), round(y - radius), round(x + radius), round(y + radius)), fill=shape["stroke"])
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the Planning Workspace SVG, PNG and ICO assets.")
    parser.add_argument("--sync-sop", action="store_true", help="Copy the same icon into the SOP web application.")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "planning-icon.svg").write_text(svg_source(), encoding="utf-8", newline="\n")
    master = render_png(512)
    master.save(OUTPUT / "planning-icon.png", optimize=True)
    render_png(180).save(OUTPUT / "apple-touch-icon.png", optimize=True)
    render_png(32).save(OUTPUT / "favicon-32.png", optimize=True)
    render_png(64).save(OUTPUT / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    if args.sync_sop:
        sop = ROOT / "services" / "sop" / "web"
        if not sop.is_dir():
            raise SystemExit("SOP web directory is missing; portal assets were exported but not synchronized.")
        for source, destination in {
            "planning-icon.svg": "sop-icon.svg", "planning-icon.png": "sop-icon.png",
            "favicon-32.png": "sop-icon-32.png", "favicon.ico": "favicon.ico",
            "apple-touch-icon.png": "apple-touch-icon.png",
        }.items():
            shutil.copyfile(OUTPUT / source, sop / destination)
    print("Exported planning icon: SVG, 512/180/32 PNG, 16/32/48/64 ICO.")


if __name__ == "__main__":
    main()
