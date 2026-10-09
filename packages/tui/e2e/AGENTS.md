# Real-server scenarios

Each `e2e/*.e2e.ts` file starts one sandbox: a real server from this checkout with a scripted model (`script/sandbox/`). It drives the TUI from `src` in that sandbox's private tmux (`e2e/support.ts`).

Workflow and trigger words: `docs/development/tui.md`.

## Conventions

- The scripted model picks its reply by trigger words in `script/sandbox/scenarios.ts`. A new flow gets a scenario there, never a real model.
- Wait with `waitFor` or `settle` (`script/sandbox/terminal.ts`) rather than sleeping.
