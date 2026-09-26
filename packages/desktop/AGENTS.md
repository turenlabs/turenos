# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process IPC handlers go through `TrustedIpc` (`src/main/trusted-ipc.ts`): general handlers in `src/main/ipc.ts`, feature handlers beside their feature (`src/main/ssh/ipc.ts`, `src/main/wsl/ipc.ts`).

## Dev builds

- Packaged dev app (unsigned, dev channel, `com.turenlabs.forge.dev` data): run `bun run build && bunx electron-builder --mac dir --config electron-builder.config.ts --publish never "--config.mac.identity=-" "--config.mac.notarize=false"`, then open `dist/mac-arm64/TurenOS Dev.app`. For renderer-only changes, skip `prebuild` and the verify scripts: `bunx electron-vite build` followed by the same `electron-builder` command.
- `packages/desktop/package.json` is source, not build output. Never copy a packaged app's `package.json` over it: electron-builder strips `scripts` and injects `desktopName`, which silently breaks `bun dev`, `bun run build`, and desktop typechecking in CI.
