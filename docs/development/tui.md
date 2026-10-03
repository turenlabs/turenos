# TUI development

How to test and verify `packages/tui`, the OpenTUI terminal client described in [the TUI system page](../systems/tui/README.md). Run package commands from `packages/tui`; the repository root refuses to run tests.

## Checks

```sh
cd packages/tui
bun run test        # bun test --timeout 30000
bun typecheck       # tsgo --noEmit
bun run build       # writes dist/cli.js, ignored by git
```

A focused run needs the script's timeout too: `bun test test/conversation-scroll.test.ts test/dashboard.test.ts --timeout 30000`. From the repository root, `bun run lint` enforces the size limits below, and `bun run tui` starts the client.

The tests (`packages/tui/test/`) drive the real client against synthetic HTTP fixtures and OpenTUI test renderers (`test/support.ts` holds the shared server, event-stream and cleanup helpers). They cover transport validation, retry behavior, keyboard and modal interaction, session browsing and mutations, provider flows, models, Markdown and activity display. They do not test against a production server.

## Size limits

`packages/tui/src/**/*.ts` stays under 400 lines per file and 60 lines per function (blank lines and comments not counted), as errors in the root `.oxlintrc.json`. The limits keep each feature in small modules a reader can hold at once: a folder per feature with a façade module beside it that exposes the feature's controls. Split a file that approaches the limit by feature rather than raising it.

## Fixture rules

- Use synthetic data only: no production transcripts, credentials, shell history or machine installation records in fixtures, tests or docs.
- Never restart a live server or a running client to test the client. Tests and the PTY audit start their own loopback servers.
- Keep generated evidence (PNGs, logs, `evidence.json`) outside the repository.
- Keyboard fixtures use `mockInput.pressEnter()`, `pressArrow(direction, modifiers)` and `pressKey("ESCAPE")`. Confirm key delivery, and wait for the expected frame after a modal transition, before typing again.
- A Bun run that only prints usage or package scripts is not a passing test run, even with exit status zero.

Input and layout changes need both renderer tests and a real PTY. Preserve exact shortcut modifiers, captured request recipients, retry identifiers, transport limits, secret handling and focus when dialogs close or asynchronous responses arrive. Test reading positions during prepend-plus-stream updates, width reflow and docked replies, not only while following the tail. Exercise controls at 60x24 as well as larger sizes.

## PTY audit

`packages/tui/script/visual-audit.py` runs the current source, or the built `dist/cli.js` with `--built`, in isolated tmux PTYs against a synthetic HTTP fixture server and reconstructs PNGs of the terminal cells with Pillow. It needs Bun, tmux, Python 3 with Pillow, and DejaVu Sans Mono (regular, bold, oblique, bold-oblique). It is not part of CI and never installs those tools.

```sh
cd packages/tui
bun run build
python3 script/visual-audit.py /run/user/1000/tva --built
python3 script/visual-audit.py /run/user/1000/tva --built --sizes 60x24 120x36
```

- The output directory must be outside the repository and short: the runner places its tmux socket there and refuses a path of 104 bytes or more. It uses its own socket (`tmux -S`), never the default tmux server.
- The default run covers 160x48, 120x36, 90x28, 80x24 and 60x24 plus a 59x23 resize-shield case. `--exit-only` and `--lifecycle-only` run the exit-restoration and close/reopen/resize subsets.
- The fixture server answers `GET /global/health` as a server the client verifies, and every request lands in `evidence.json`. A request outside the allowed set fails the `safety` check.
- Exit status 1 means a check failed; `summary.md` and `evidence.json` at the output root describe the latest run. The runner hashes `src/**/*.ts` at the start and end and fails if source changed during capture.
- The PNGs are reconstructions of tmux cells, not screenshots of a GUI terminal, and a pass is not a visual review. Open a few and look.
- Remove the output directory and the package's `dist` build output afterwards.

## Source

- `packages/tui/package.json`
- `packages/tui/test/support.ts`
- `packages/tui/script/visual-audit.py`
- `.oxlintrc.json`
