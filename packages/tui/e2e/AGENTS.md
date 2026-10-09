# Real-server scenarios

`bun run test:e2e` from `packages/tui` runs `e2e/*.e2e.ts`. It takes a few minutes and is not in CI.
- Each file starts one sandbox: a real server from this checkout with a scripted model (`script/sandbox/`).
- The TUI from `src` runs in that sandbox's private tmux (`e2e/support.ts`).

Workflow and trigger words: `docs/development/tui.md`.

## Conventions

- The scripted model picks its reply by trigger words in `script/sandbox/scenarios.ts`. A new flow gets a scenario there, never a real model.
- tmux runs only on the sandbox's private socket. Never touch the default tmux server.
- Wait for text or for the client to go idle (the sandbox's `wait` and `idle`) rather than sleeping.
- The footer reads `Typing` while the reply editor has the keys. Send Escape before a single-letter shortcut.
- By hand, it's the same sandbox:
  - `bun run sandbox start <name>`, then `launch`, `screen`, `keys`, `type` and `wait`;
  - `bun run sandbox stop <name>` when done.
