## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Debugging

- Never restart the user's running app or server process. Start your own dev servers (below) when you need to verify a change.

## Local Dev

- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/forge`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Startup

- Home hydrates session directories incrementally and cancels the rest when route restore unmounts it. Global server readiness waits only for project identity; config, provider, and path queries must not delay restored-tab navigation.

## Extend Page

- `src/pages/extend.tsx` renders only the server's built-in catalog (`extension.list`). There is no remote catalog endpoint or external merge; catalog content comes from `services/catalog/manifests` via `packages/extensions`.
