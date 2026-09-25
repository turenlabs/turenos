# Background shell jobs

The V2 `bash` tool admits an approved command as a durable, session-owned job.
Commands that finish within one second return their output normally. Longer
commands return a `job_id` and let the agent continue working.

Set `foreground: true` when the tool call must wait for completion. The existing
command timeout still applies: two minutes by default, up to ten minutes when
explicitly requested. Background execution does not disable timeouts.

Use `shell_job` to inspect work owned by the current session:

- `list`: up to 32 recent job summaries, without captured output.
- `status`: the current state of one `job_id`.
- `output`: captured output after completion, bounded to 1 MiB.
- `wait`: wait for one job, with `timeout_ms` defaulting to 1,000 and capped at
  600,000. A wait timeout does not cancel the command.
- `cancel`: request termination of the owned process group. `stopping` means
  teardown has not finished; it does not claim the process has been killed.

Detached completions enqueue a concise advisory notification to the same
session. Command output remains untrusted tool data and is not interpolated into
the notification. Quick inline results do not send duplicate notifications.

Command approval, working-directory checks, delegated command grants, and shell
safety checks all run before job admission. Other sessions cannot read, wait on,
or cancel the job. There are at most four active jobs per session and 32 per
runner.

Repeating the same tool-call identity reconciles the existing job rather than
executing the command again. Durable records are observations, not instructions
to resume after a restart. Lost process ownership is reported as `interrupted`;
TurenOS never replays the command or terminates a stored command PID on recovery.

## Source

- [`packages/core/src/shell-job.ts`](../../packages/core/src/shell-job.ts)
- [`packages/core/src/background-job.ts`](../../packages/core/src/background-job.ts)
- [`packages/core/src/tool/shell-job.ts`](../../packages/core/src/tool/shell-job.ts)
- [`packages/core/src/tool/bash.ts`](../../packages/core/src/tool/bash.ts)
