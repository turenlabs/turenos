# Turen TUI

## Boundaries

- This is the independent Bun client, not sibling `turenos/`. `src/cli.ts` starts `src/index.ts`; execution and persistent session data remain on the server. Never restart a live server for client tests.
- `@turenlabs/client` resolves to copied generated files in `vendor/client/`. Preserve the narrow patch and sync procedure in `docs/reference/provenance.md`; do not add monorepo workspace dependencies or guess endpoint contracts.
- Live text uses the global `/api/event` fetch in `src/live-events.ts`, not the removed generated subscription. Polling is reconciliation/fallback, not the only update path.
- Server discovery and switching live in `src/servers.ts` and `src/server-picker.ts`. Local servers come only from records their owners publish: the desktop's `attach.json`, the shim's `~/.forge/run`, and `/etc/turenos/attach.json`. Never write a password to disk or put a secret in argv. Never start a second server over data a running desktop owns, because session drains are process-local.
- `mountApp` mounts the new dashboard before disposing the old one. Anything a dashboard registers on the renderer must be released in its `dispose()`, or it leaks across server switches.
- Current operator/auth guidance is `docs/guides/usage.md`; verification details are in `docs/guides/development.md`. Keep dated audit evidence distinct from current behavior.

## Commands

- Put Bun **1.4.2** on `PATH`: test/build scripts invoke `bun` again, so an absolute path on only the outer invocation does not pin the nested runtime.
- From this root: `bun install --frozen-lockfile`, then `bun typecheck`, `bun run test`, and `bun run format:check` (the CI checks).
- Focused tests need the script's timeout too: `bun test test/conversation-scroll.test.ts test/dashboard.test.ts --timeout 30000`.
- `bun run build` writes ignored `dist/cli.js` with external packages, not a standalone executable. Keep Bun and intact `node_modules`/native dependencies; smoke-test with `bun dist/cli.js --help`. Building does not replace launchers or restart clients.
- Prettier excludes `vendor/`, `bun.lock`, and `script/*.py`; a formatting pass does not check those files.

## TUI Invariants

- Preserve exact key modifiers, modal focus, captured recipients, retry IDs, transport limits, and credential restrictions. Local slash admission must cover keyboard and mouse submission, not just Enter.
- `parentID` is navigation metadata, not proof of task ownership. Child drafts must never be silently transferred or sent to the main session; startup cannot assume a main thread is in the latest session page.
- Size reply editors with `editor.lineInfo.lineSources.length`; `virtualLineCount` can be viewport-limited. Reserve the scrollbar column rather than letting it cover wrapped text.
- Test reading positions during prepend-plus-stream updates, width reflow, and docked replies, not only while following the tail. Use native logical-line/display-column mapping rather than implementing word wrapping.

## Terminal Verification

- Input/layout changes require renderer tests and real PTYs. Use synthetic fixtures, never production transcripts or credentials; keep generated evidence outside the checkout/Git.
- Keyboard fixtures use `mockInput.pressEnter()`, `pressArrow(...)`, and `pressKey("ESCAPE")`; wait for the expected frame after modal transitions before typing again.
- The PTY runner is not in CI. It needs tmux, Python 3 with Pillow, and DejaVu Sans Mono fonts. Build first for `--built`; do not edit source during capture, which checks source hashes.

```sh
bun run build
python3 script/visual-audit.py /tmp/turen-tui-audit --built --sizes 60x24 120x36
```

- Inspect terminal-cell captures as well as check counts; reconstructed PNGs and synthetic-server passes are not production or cross-platform verification.
