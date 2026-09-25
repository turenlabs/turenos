# Batou write scanning

Batou is a static application security testing (SAST) scanner that TurenOS can run on every file an agent writes. When
the `turenlabs/batou` extension is enabled, each `write`, `edit`, and `apply_patch` call is scanned before it touches the
file, and a write Batou explicitly denies is blocked. It is off by default and fails open: if Batou can't run, the write
proceeds.

## Enabling it

Turn on **Batou** under **Settings → Security Integrations**. The catalog entry is
`services/catalog/manifests/tools/batou.json` (`defaultEnabled: false`).

TurenOS looks for a `batou` executable on `PATH` first. Otherwise it uses `<cache>/security/batou/batou` under the
TurenOS cache directory (`~/.cache/forge` by default), and on first enable downloads the pinned release
(`v2.0.0`) from `https://github.com/turenlabs/batou/releases`, checks its SHA-256 against a digest compiled into
TurenOS, and moves it into place atomically. Downloads exist for macOS and Linux on x64 and arm64; Windows is not
supported. After a failed download, TurenOS waits 60 seconds before trying again. The settings row shows the status:
not installed, downloading, installed, or failed.

## How a write is scanned

1. **Before the write.** TurenOS sends Batou a Claude Code-shaped `PreToolUse` event for the pending change. A deny
   decision (Batou's risk score at or above 0.7) stops the tool call, and the model receives Batou's reason as the tool
   error. The public Batou build signals a block with exit code 2 and the details in `additionalContext`; a managed
   build returns `permissionDecision: "deny"`. Both are treated as blocks.
2. **After the write.** A `PostToolUse` event collects Batou's advisory findings, which TurenOS appends to the tool
   result as notes. A clean "No security issues detected" result adds nothing.

In Session V2 this runs through the Core tool interceptors (`packages/core/src/tool/batou.ts`), which call the product
scanner adapter in `packages/forge/src/plugin/batou-v2.ts`. The legacy session runtime registers the same plugin
directly.

## Limits

- Only an explicit block stops a write. A disabled extension, missing binary, unsupported platform, spawn error,
  15-second timeout, or unparseable output lets the write proceed, with one log line per distinct failure.
- Batou's output is read up to 1 MiB; anything after that is cut off before parsing.
- Batou sees agent writes through these three tools only. Files changed by `bash` commands are not scanned.

## Source

- [`packages/core/src/tool/batou.ts`](../../packages/core/src/tool/batou.ts)
- [`packages/forge/src/plugin/batou.ts`](../../packages/forge/src/plugin/batou.ts)
- [`packages/forge/src/plugin/batou-v2.ts`](../../packages/forge/src/plugin/batou-v2.ts)
- [`packages/forge/src/security/batou-binary.ts`](../../packages/forge/src/security/batou-binary.ts)
- [`services/catalog/manifests/tools/batou.json`](../../services/catalog/manifests/tools/batou.json)
- Tests: [`packages/core/test/tool-batou.test.ts`](../../packages/core/test/tool-batou.test.ts), [`packages/forge/test/plugin/batou.test.ts`](../../packages/forge/test/plugin/batou.test.ts)
