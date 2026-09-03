#!/usr/bin/env python3
"""Generate Turen web and desktop branding from the approved raster mark.

The single source of truth is `turen-mark-source.png`: a square, transparent
illustration of the TurenOS agent. Everything below is derived from it, so a brand
change means replacing that one file and re-running this script.

App icons are composited onto an opaque near-black tile because the mark is
line art with cream fills that would otherwise disappear against a light Dock or
Finder background. Surfaces that render on an unknown or themed background --
the OAuth card, the in-app logo -- keep the transparent mark instead.
"""

from __future__ import annotations

import base64
import shutil
import subprocess
import sys
import tempfile
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "packages/ui/src/assets/brand"
FAVICONS = [ROOT / "packages/ui/src/assets/favicon", ROOT / "packages/app/public"]
IMAGES = [ROOT / "packages/ui/src/assets/images", ROOT / "packages/app/public"]
ICONS = ROOT / "packages/desktop/resources/icons"
# The per-channel sets under `packages/desktop/icons/<channel>` are what actually
# ship: `scripts/copy-icons.ts` wipes `resources/icons` and copies a channel over
# it at prebuild. So the master below is the real input, and `resources/icons` is
# only kept in sync here so a dev run before the first build looks right.
DESKTOP_MASTER = ROOT / "packages/desktop/icons/app-icon.png"
DESKTOP_ICON_SCRIPT = ROOT / "packages/desktop/scripts/generate-icons.py"
OAUTH_BRAND = ROOT / "packages/core/src/oauth/brand.ts"

SOURCE = BRAND / "turen-mark-source.png"
BACKGROUND = (8, 12, 11, 255)
# Share of an opaque tile the artwork covers. Apple's own icons sit near 0.80;
# the floating variants (Dock, Android foreground) can run wider because the
# platform applies its own mask.
INSET = 0.80
FLOAT_INSET = 0.84
ICO_SIZES = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]


def artwork() -> Image.Image:
    image = Image.open(SOURCE).convert("RGBA")
    return image.crop(image.getchannel("A").getbbox())


def tile(art: Image.Image, size: int, *, opaque: bool = True, inset: float = INSET, circle: bool = False) -> Image.Image:
    if circle:
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(canvas).ellipse((0, 0, size - 1, size - 1), fill=BACKGROUND)
    else:
        canvas = Image.new("RGBA", (size, size), BACKGROUND if opaque else (0, 0, 0, 0))
    scale = (size * inset) / max(art.size)
    fitted = art.resize((max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.Resampling.LANCZOS)
    canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return canvas


def square(art: Image.Image, size: int) -> Image.Image:
    side = max(art.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(art, ((side - art.width) // 2, (side - art.height) // 2))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def save(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def data_uri(image: Image.Image) -> str:
    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def main() -> None:
    art = artwork()

    # In-app mark: transparent, so it inherits whatever surface renders it.
    save(square(art, 1024).resize((1024, 1024), Image.Resampling.LANCZOS), BRAND / "turen-mark.png")

    save(tile(art, 512), ICONS / "icon.png")
    save(tile(art, 256, opaque=False, inset=FLOAT_INSET), ICONS / "dock.png")
    for size in (32, 64, 128):
        save(tile(art, size), ICONS / f"{size}x{size}.png")
    save(tile(art, 256), ICONS / "128x128@2x.png")

    windows = {"Square30x30Logo": 30, "Square44x44Logo": 44, "Square71x71Logo": 71, "Square89x89Logo": 89,
               "Square107x107Logo": 107, "Square142x142Logo": 142, "Square150x150Logo": 150,
               "Square284x284Logo": 284, "Square310x310Logo": 310, "StoreLogo": 50}
    for name, size in windows.items():
        save(tile(art, size), ICONS / f"{name}.png")

    ios = {"AppIcon-20x20@1x": 20, "AppIcon-20x20@2x": 40, "AppIcon-20x20@2x-1": 40, "AppIcon-20x20@3x": 60,
           "AppIcon-29x29@1x": 29, "AppIcon-29x29@2x": 58, "AppIcon-29x29@2x-1": 58, "AppIcon-29x29@3x": 87,
           "AppIcon-40x40@1x": 40, "AppIcon-40x40@2x": 80, "AppIcon-40x40@2x-1": 80, "AppIcon-40x40@3x": 120,
           "AppIcon-60x60@2x": 120, "AppIcon-60x60@3x": 180, "AppIcon-76x76@1x": 76, "AppIcon-76x76@2x": 152,
           "AppIcon-83.5x83.5@2x": 167, "AppIcon-512@2x": 1024}
    for name, size in ios.items():
        save(tile(art, size), ICONS / "ios" / f"{name}.png")

    for dpi, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        base = ICONS / "android" / f"mipmap-{dpi}"
        save(tile(art, size), base / "ic_launcher.png")
        save(tile(art, size, circle=True), base / "ic_launcher_round.png")
        save(tile(art, size, opaque=False, inset=0.62), base / "ic_launcher_foreground.png")

    tile(art, 256).save(ICONS / "icon.ico", format="ICO", sizes=ICO_SIZES)

    if sys.platform == "darwin":
        with tempfile.TemporaryDirectory() as tmp:
            iconset = Path(tmp) / "TurenOS.iconset"
            iconset.mkdir()
            for base in (16, 32, 128, 256, 512):
                save(tile(art, base), iconset / f"icon_{base}x{base}.png")
                save(tile(art, base * 2), iconset / f"icon_{base}x{base}@2x.png")
            subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICONS / "icon.icns")], check=True)
    else:
        print("skipping icon.icns: iconutil is macOS only", file=sys.stderr)

    # The shipped per-channel sets, built by the desktop's own generator so the
    # macOS squircle inset and drop shadow stay consistent with its README.
    save(tile(art, 1024), DESKTOP_MASTER)
    subprocess.run([sys.executable, str(DESKTOP_ICON_SCRIPT), "--master", str(DESKTOP_MASTER)], check=True)

    favicon_svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
        f'<image width="512" height="512" href="{data_uri(tile(art, 512))}"/>'
        "</svg>\n"
    )
    for directory in FAVICONS:
        for name in ("favicon-96x96.png", "favicon-96x96-v3.png"):
            save(tile(art, 96), directory / name)
        for name in ("apple-touch-icon.png", "apple-touch-icon-v3.png"):
            save(tile(art, 180), directory / name)
        save(tile(art, 192), directory / "web-app-manifest-192x192.png")
        save(tile(art, 512), directory / "web-app-manifest-512x512.png")
        for name in ("favicon.ico", "favicon-v3.ico"):
            tile(art, 256).save(directory / name, format="ICO", sizes=ICO_SIZES)
        for name in ("favicon.svg", "favicon-v3.svg"):
            (directory / name).write_text(favicon_svg)

    social = Image.new("RGBA", (1200, 630), BACKGROUND)
    badge = tile(art, 420, opaque=False, inset=1.0)
    social.alpha_composite(badge, ((1200 - badge.width) // 2, (630 - badge.height) // 2))
    for directory in IMAGES:
        for name in ("social-share.png", "social-share-black.png", "social-share-zen.png"):
            if directory.name == "public" and name == "social-share-black.png":
                continue
            save(social, directory / name)

    (BRAND / "anvil-badge.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        f'<image width="1024" height="1024" href="{data_uri(tile(art, 1024))}"/>'
        "</svg>"
    )
    (BRAND / "anvil-share.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">'
        f'<image width="1200" height="630" href="{data_uri(social)}"/>'
        "</svg>"
    )

    # The OAuth card themes light or dark, so it takes the transparent mark.
    OAUTH_BRAND.write_text(
        "// Generated by script/generate-brand-assets.py.\n"
        "export const WORDMARK = "
        + repr(f'<img class="wordmark" src="{data_uri(square(art, 256))}" alt="TurenOS" aria-label="TurenOS">')
        + "\n"
    )


if __name__ == "__main__":
    main()
