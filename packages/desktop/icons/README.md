# Desktop app icons

Every file under `dev/`, `beta/` and `prod/` is **generated**. Do not hand-edit them.

## Regenerating

1. Replace `app-icon.png` in this directory with a new 1024x1024 PNG master.
2. From `packages/desktop`, run:

   ```sh
   python3 scripts/generate-icons.py
   ```

Needs Pillow (`pip install --user Pillow`) and, for `icon.icns`, macOS `iconutil`. The script is
deterministic — re-running it with the same master produces byte-identical output, so a no-op run
leaves a clean `git status`.

Useful flags: `--channel dev` (repeatable) to limit the run, `--master PATH` / `--out DIR` to
generate somewhere else.

All three channels currently use the **same artwork**. Differentiating them by badge or tint would
be a deliberate design decision, not something the script should invent.

## What gets generated

| File                                    | Shape       | Consumed by                                                      |
| --------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `icon.icns`                             | macOS inset | `electron-builder` `mac.icon`                                    |
| `dock.png` (256px)                      | macOS inset | `app.dock.setIcon()` in `src/main/windows.ts`                    |
| `icon.ico` (16/32/48/64/128/256)        | full-bleed  | `electron-builder` `win.icon`, NSIS installer icons              |
| `32x32.png`, `64x64.png`, `128x128.png` | full-bleed  | `electron-builder` `linux.icon` (it scans the dir for `NxN.png`) |
| `icon.png` (512px)                      | full-bleed  | Linux icon fallback, and `BrowserWindow`'s `icon` on Linux       |
| `128x128@2x.png`                        | full-bleed  | nothing today; kept for parity with the other sizes              |
| `Square*Logo.png`, `StoreLogo.png`      | full-bleed  | Windows/MSIX tiles                                               |

`scripts/copy-icons.ts` copies the whole channel folder to `resources/icons` (gitignored) during
`predev`/`prebuild`, and that is what both Electron and `electron-builder` read at runtime.

Windows and Linux do not apply a platform mask, so their assets stay edge-to-edge. Only the macOS
assets are inset.

## Why the macOS assets are inset

macOS Big Sur onwards expects an app icon to be pre-composed: artwork inside a rounded square with
a transparent margin and its own baked-in drop shadow. If you hand macOS a full-bleed 1024x1024
image, it renders it at full size and the app icon looks noticeably _larger_ than every other icon
in the Dock and in Finder. This repo used to fix that by running the source through Image2Icon's
"Big Sur Icon" preset by hand; `generate-icons.py` now does it directly.

Geometry, on a 1024x1024 canvas:

- rounded square of **824x824**, centered — a 100px transparent margin on every side
- corner radius **185.4px** (22.5% of 824)
- drop shadow: black at 28% opacity, 10px gaussian blur, offset 8px down
- the mask is rendered at 8x and box-filtered down, so the curve stays clean at 16px

`dock.png` is extracted straight back out of the finished `icon.icns` rather than re-rendered, so
the unpackaged dev Dock icon has exactly the same inset and shadow as the packaged app. Verify with:

```sh
iconutil -c iconset -o /tmp/check.iconset icons/dev/icon.icns
cmp icons/dev/dock.png /tmp/check.iconset/icon_128x128@2x.png
```

## `android/` and `ios/`

Leftovers from when this app was Tauri. Nothing in the build or the app references them; the script
does not touch them. They can be deleted whenever someone wants to.
