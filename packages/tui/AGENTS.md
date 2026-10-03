# Turen TUI

`packages/tui` is the OpenTUI terminal client (TypeScript, Bun). It renders locally; sessions, tools and model execution stay on the server. System page: `docs/systems/tui/README.md`.

## Commands

Run from `packages/tui` unless noted.

- `bun run test` (tests need the script's `--timeout 30000`; a focused run is `bun test test/dashboard.test.ts --timeout 30000`), `bun typecheck`, `bun run build` (writes ignored `dist/cli.js`).
- Run `bun run tui` from the repository root, where the root `package.json` defines it, to start the client (it runs `bun --cwd packages/tui start`).
- PTY audit, after `bun run build`: `python3 script/visual-audit.py /run/user/1000/tva --built`. The output path must be outside the repo and short (the tmux socket path must stay under 104 bytes). Do not edit `src` during capture, because the audit hashes source. Delete the output directory and `dist` afterwards. Details: `docs/development/tui.md`.
- Any other tmux use runs on a private socket, `tmux -L <name> ...`. Never touch the default tmux server, and never `kill-server` without `-L`.

## Layout and limits

- `src/<feature>/` holds the implementation; a façade `src/<feature>.ts` beside it (`src/index.ts` for `dashboard/`) exposes the feature's controls. Add to a feature folder rather than a new top-level file.
- No `src` file over 400 lines and no function over 60 lines (blank lines and comments excluded). Both are errors in the root `.oxlintrc.json`, checked by `bun run lint` from the repository root; they keep each feature in small modules. Split by feature instead of raising the limits.
- The only TurenOS runtime dependency is `@turenlabs/client` (workspace): never import Core, Server or Protocol, and do not guess endpoint contracts the generated client lacks.

## Invariants

- Preserve exact key modifiers, modal focus, captured request recipients, retry IDs, transport limits and credential restrictions. Local slash admission covers keyboard and mouse submission, not only Enter.
- Anything a dashboard registers on the renderer is released in its `dispose()` (`src/dashboard/lifecycle.ts`), or it leaks across server switches. `mountApp` mounts the new dashboard before disposing the old one.
- Size reply editors with `editor.lineInfo.lineSources.length`; `virtualLineCount` can be viewport-limited. Reserve the scrollbar column.
- `parentID` is navigation metadata, not proof of task ownership. Never transfer or send a child's draft to the main session.
- Live text comes from the global `/api/event` stream (`src/live-events/`); polling is reconciliation, not the only update path.
- Local servers come only from records their owners publish. Never write a password to disk or put a secret in argv. Never start a second server over data a running desktop owns.
- Test reading positions during prepend-plus-stream updates, width reflow and docked replies, not only at the tail. Use the native logical-line mapping, not custom word wrapping.
- Tests and audits use synthetic fixtures only: no production transcripts or credentials. Never restart a live server or client to test the client. Keyboard fixtures use `mockInput.pressEnter()`, `pressArrow(...)` and `pressKey("ESCAPE")`, then wait for the expected frame after a modal transition.
