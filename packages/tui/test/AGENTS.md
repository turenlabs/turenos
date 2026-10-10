# TUI tests

These tests run against fakes: `turen()` servers and stand-in `forge` and `ssh` scripts. Scenarios against a real server are in `e2e/`.

## Helpers

- `test/support.ts`:
  - `turen({ routes, password, socket })` is a fake server that records each request (`paths()`, `sent()`);
  - `terminal(width, height)` is a test renderer;
  - `sized(...)` and `dashboard(routes)` mount a dashboard on one;
  - `cleanup` callbacks run after each test, through the hook in `test/preload.ts`, which `bunfig.toml` preloads.
- Feature fixtures sit beside their tests (`agent-fixture.ts`, `team-fixture.ts`, `<stem>-fixture.ts`). Share setup through them rather than copying it: the PR review fails on duplicated code.
- Test files stay under 400 lines (lint). Split a growing file by feature into `<stem>-<feature>.test.ts`.

## Gotchas

- `terminal()` encodes keys as a legacy terminal does.
  - Ctrl+letter is a control byte.
  - OpenTUI's `pressBackspace()` sends 0x08, which the TUI reads as Ctrl+H (the screensaver); send Backspace with `backspace(view)`.
  - Pass `kittyKeyboard: true` to `createTestRenderer` when a test needs CSI-u keys.
- In legacy encoding, Esc followed at once by a letter parses as Alt+letter. Render or wait for a frame between them.
- Use `mockInput.pressEnter()`, `pressArrow(...)` and `pressKey("ESCAPE")`. After a modal transition, wait for the expected frame before the next key.
- Register hooks such as `afterEach` in `test/preload.ts` or in the test file itself: one registered by an imported helper runs only in the first file that loads it.
- `terminal()` and `turen()` register their own cleanup. Mount a dashboard and push its `dispose` to `cleanup`, so nothing leaks into the next test.
