# Observability

TurenOS writes structured logs to a local file and, only when an OTLP endpoint is configured, also exports logs and
traces over OpenTelemetry. Nothing leaves the machine by default. The file log is rotated at 10 MiB when the logger is
created, not during a run.

## How it works

1. `Observability.layer` (`packages/core/src/observability.ts`) installs the log sinks and, when configured, the tracing
   layer for the process.
2. `Logging.fileLogger` appends to `forge.log` in the log directory: `<data>/log`, by default
   `~/.local/share/forge/log/forge.log`. Each line is `key=value` pairs with a timestamp, level, and the process run ID,
   followed by the message, cause, spans, and annotations flattened into dotted keys.
3. When the file is at least 10 MiB as the logger is created, it is renamed to `forge.log.1`, replacing the previous
   archive. Disk use is therefore bounded at roughly twice the cap.
4. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, `Otlp.loggers` adds an OTLP log exporter at `<endpoint>/v1/logs`, and
   `Otlp.tracingLayer` loads the OpenTelemetry Node SDK with a batching exporter at `<endpoint>/v1/traces`. It also
   registers a global context manager so AI SDK spans nest under Effect spans.

Exported telemetry carries the service name `forge`, the installed version, the release channel as
`deployment.environment.name`, `forge.client`, and the run ID as both `forge.run` and `service.instance.id`, plus any
`OTEL_RESOURCE_ATTRIBUTES`.

## Desktop logs

The Desktop main process keeps its own logs, separate from `forge.log` (`packages/desktop/src/main/logging.ts`):

- Each launch writes to `<userData>/logs/<timestamp>/`, one `<scope>.log` file per scope (`main`, `renderer`, and
  others), each capped at 5 MiB. Entries in `<userData>/logs/` older than 7 days are deleted at startup.
- `network.netlog` in the same run directory is a Chromium net log capped at 20 MiB.
- Crash dumps go to `<userData>/Crashpad`. The crash reporter never uploads them.
- **Export Logs...** in the Desktop menu (also offered on the error page and the window-recovery dialog) writes
  `forge-debug-<timestamp>.zip` to Downloads. It holds a manifest plus the last 24 hours of Desktop logs, server logs
  (`$XDG_DATA_HOME/forge/log` and `<userData>/forge/log`), and crash dumps, skipping files over 50 MiB and symlinks.

`<userData>` is the Electron user data directory listed in [Secure storage](./secure-storage.md#on-disk-locations).

## Configuration

| Variable                      | Default | Effect                                                                                  |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `FORGE_LOG_LEVEL`             | `INFO`  | Minimum level: `DEBUG`, `INFO`, `WARN`, or `ERROR`. Any other value falls back to info. |
| `FORGE_PRINT_LOGS`            | unset   | `1` also writes every log line to stderr.                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset   | Base URL for OTLP/HTTP log and trace export. Unset means no export.                     |
| `OTEL_EXPORTER_OTLP_HEADERS`  | unset   | Comma-separated `key=value` headers sent with each export.                              |
| `OTEL_RESOURCE_ATTRIBUTES`    | unset   | Comma-separated, URL-encoded `key=value` resource attributes. Invalid input is ignored. |

The `forge` CLI flags `--log-level <level>` and `--print-logs` set `FORGE_LOG_LEVEL` and `FORGE_PRINT_LOGS=1` for that
run (`packages/forge/src/index.ts`).

A workspace process created by the experimental [workspaces](./workspaces.md) control plane inherits the three `OTEL_*`
variables from its parent.

## Verification

```sh
bun test --cwd packages/core test/effect/observability.test.ts
```

## Limits

- Rotation happens only at logger construction, so one long run can grow the log past 10 MiB.
- Log lines are not redacted by the logger; callers must avoid logging secrets.
- Export uses OTLP/HTTP with JSON serialization only.

## Source

- [`packages/core/src/observability.ts`](../../packages/core/src/observability.ts)
- [`packages/core/src/observability/logging.ts`](../../packages/core/src/observability/logging.ts)
- [`packages/core/src/observability/otlp.ts`](../../packages/core/src/observability/otlp.ts)
- [`packages/core/src/global.ts`](../../packages/core/src/global.ts)
- [`packages/desktop/src/main/logging.ts`](../../packages/desktop/src/main/logging.ts)
- Tests: [`packages/core/test/effect/observability.test.ts`](../../packages/core/test/effect/observability.test.ts)
