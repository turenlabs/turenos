#!/usr/bin/env python3
"""Regenerate every desktop app icon asset from the 1024x1024 master.

Usage:
    python3 packages/desktop/scripts/generate-icons.py [--master PATH] [--channel dev|beta|prod] ...

Requires Pillow (`pip install --user Pillow`) and, for `icon.icns`, macOS `iconutil`.
Output is deterministic: re-running produces byte-identical files.

See ../icons/README.md for why the macOS variant is inset the way it is.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover - dependency guard
    sys.exit("Pillow is required: pip install --user Pillow")

REPO_ICONS = Path(__file__).resolve().parent.parent / "icons"
DEFAULT_MASTER = REPO_ICONS / "app-icon.png"
CHANNELS = ("dev", "beta", "prod")

CANVAS = 1024

# --- macOS Big Sur+ app icon geometry, expressed on a 1024x1024 canvas --------
# Artwork lives inside a centred rounded square; everything outside is transparent.
SQUIRCLE_SIDE = 824  # 100px transparent margin on every side
SQUIRCLE_MARGIN = (CANVAS - SQUIRCLE_SIDE) // 2  # 100
SQUIRCLE_RADIUS = SQUIRCLE_SIDE * 0.225  # 185.4
SHADOW_BLUR = 10  # gaussian radius, px
SHADOW_OFFSET_Y = 8  # px, downward
SHADOW_OPACITY = 0.28
MASK_SUPERSAMPLE = 8  # mask is rendered at 8x and box-filtered down for clean edges

# --- Derived asset tables -----------------------------------------------------
# Flat (full-bleed) PNGs. Windows and Linux do not apply the macOS inset, so these
# keep the artwork edge-to-edge.
FLAT_PNGS: dict[str, int] = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    # Windows/MSIX tiles.
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

ICO_SIZES = [16, 32, 48, 64, 128, 256]

# The ten variants `iconutil` expects inside an .iconset directory.
ICONSET: dict[str, int] = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}

# `app.dock.setIcon()` in unpackaged dev must match the packaged inset exactly.
DOCK_SOURCE = "icon_128x128@2x.png"


def load_master(path: Path) -> Image.Image:
    master = Image.open(path).convert("RGBA")
    if master.size != (CANVAS, CANVAS):
        master = master.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)
    return master


def squircle_mask() -> Image.Image:
    """Anti-aliased alpha mask for the macOS rounded square."""
    scale = MASK_SUPERSAMPLE
    hi = Image.new("L", (CANVAS * scale, CANVAS * scale), 0)
    draw = ImageDraw.Draw(hi)
    left = SQUIRCLE_MARGIN * scale
    top = SQUIRCLE_MARGIN * scale
    right = (SQUIRCLE_MARGIN + SQUIRCLE_SIDE) * scale - 1
    bottom = (SQUIRCLE_MARGIN + SQUIRCLE_SIDE) * scale - 1
    draw.rounded_rectangle((left, top, right, bottom), radius=SQUIRCLE_RADIUS * scale, fill=255)
    # BOX is an exact area average of the supersampled mask: clean edges, no ringing.
    return hi.resize((CANVAS, CANVAS), Image.Resampling.BOX)


def build_mac_master(master: Image.Image) -> Image.Image:
    """1024x1024 RGBA: artwork masked to the squircle, over a restrained drop shadow."""
    mask = squircle_mask()

    art = master.resize((SQUIRCLE_SIDE, SQUIRCLE_SIDE), Image.Resampling.LANCZOS)
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    layer.paste(art, (SQUIRCLE_MARGIN, SQUIRCLE_MARGIN))
    layer.putalpha(mask)

    blurred = mask.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))
    shadow_alpha = blurred.point(lambda v: int(v * SHADOW_OPACITY))
    black = Image.new("L", (CANVAS, CANVAS), 0)
    shadow = Image.merge("RGBA", (black, black, black, shadow_alpha))

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(shadow, (0, SHADOW_OFFSET_Y))
    return Image.alpha_composite(canvas, layer)


def write_png(image: Image.Image, size: int, path: Path) -> None:
    resized = image if image.size == (size, size) else image.resize((size, size), Image.Resampling.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    resized.save(path, format="PNG", optimize=True)


def write_icns(mac_master: Image.Image, out: Path) -> None:
    if not Path("/usr/bin/iconutil").exists():
        print(f"  skip {out.name}: iconutil is macOS-only", file=sys.stderr)
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, size in ICONSET.items():
            write_png(mac_master, size, iconset / name)
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(out)],
            check=True,
        )
        # dock.png must be the same bytes as the packaged 256px variant, otherwise the
        # dev Dock icon sits at a different inset than the shipped app. Take it back out
        # of the .icns rather than reusing our own PNG: iconutil re-encodes on the way
        # in, so only the extracted file is byte-identical to what ships.
        extracted = Path(tmp) / "extracted.iconset"
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "iconset", str(out), "-o", str(extracted)],
            check=True,
        )
        shutil.copyfile(extracted / DOCK_SOURCE, out.parent / "dock.png")


def write_ico(master: Image.Image, out: Path) -> None:
    master.save(out, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def generate(master: Image.Image, mac_master: Image.Image, channel_dir: Path) -> None:
    channel_dir.mkdir(parents=True, exist_ok=True)
    for name, size in FLAT_PNGS.items():
        write_png(master, size, channel_dir / name)
    write_ico(master, channel_dir / "icon.ico")
    write_icns(mac_master, channel_dir / "icon.icns")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--master", type=Path, default=DEFAULT_MASTER, help="1024x1024 source PNG")
    parser.add_argument("--out", type=Path, default=REPO_ICONS, help="icons/ directory to write channels into")
    parser.add_argument("--channel", action="append", choices=CHANNELS, help="limit to one channel (repeatable)")
    args = parser.parse_args()

    if not args.master.is_file():
        print(f"master image not found: {args.master}", file=sys.stderr)
        return 1

    master = load_master(args.master)
    mac_master = build_mac_master(master)

    for channel in args.channel or CHANNELS:
        target = args.out / channel
        generate(master, mac_master, target)
        print(f"generated {channel} icons in {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
