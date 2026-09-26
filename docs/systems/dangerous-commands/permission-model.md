# The permission model

Deletion safety, specialized-tool routing, and permissions are separate systems that meet only in ordering.
`ShellSafety` runs first and cannot be overridden. `ShellToolRouting` runs second and redirects high-confidence workspace
searches and mutations. `PermissionV2` runs last and is entirely user-configurable.

After the safety and routing checks pass, the bash tool asserts permission in this order. If the resolved `workdir` is
outside the active Location, it asserts `action: "external_directory"` with the resource `<canonical directory>/*`. It
then asserts `external_directory` once for each external directory referenced by a command argument (see
[Command arguments outside the workspace](#command-arguments-outside-the-workspace)). It always asserts the tool's own
action last:

```
yield* permission.assert({
  action: name,
  resources: [input.command],
  save: [input.command],
  metadata: { workdir: target.resource },
  ...
})
```

`resources` and `save` are the raw command string. `PermissionV2.evaluate` finds the **last** rule whose action and
resource both match under `Wildcard.match`, and falls back to `ask` when nothing matches. Across multiple rulesets the
most restrictive effect wins: `deny` beats `ask` beats `allow`.

Choosing "Allow always" — the reply is `always` — writes a row into the SQLite `permission` table scoped to the current
project, and those rows are replayed as `effect: "allow"` rules. Because bash saves the exact command string, a saved
bash grant normally matches only that exact command again. Saved rules are still evaluated with `Wildcard.match`, so a
saved command that contains `*` or `?` also matches other commands that fit that pattern. In Session V2, saved grants can only
upgrade an `ask` to an `allow`; a configured `deny` is checked first and is never overridable.

The legacy runtime works differently (`packages/forge/src/permission/index.ts`). It keeps "always" approvals in memory
for the project instance and takes the last rule that matches across the configured rules and those approvals, so a
later approval can override a configured `deny`. The legacy shell tool's "always" saves `<command prefix> *` rather
than the exact command (`packages/forge/src/tool/shell.ts`), so one approval covers every command with that prefix.

A delegated subagent task can narrow this further. When the task is given exact command grants, every `bash` call must
match one of them exactly and run with `workdir` `.`; otherwise it is denied before the rules are evaluated. A task
with write roots denies `edit` and `external_directory` targets outside those roots in the same way.

Two things are worth stating plainly because they change what "protected" means in practice:

- The built-in ruleset for the default agent begins with `{ action: "*", resource: "*", effect: "allow" }`. Out of the
  box, `bash` is allowed without a prompt.
- The "Enforce permission checks" toggle — described in the UI as "Require approval for actions configured as Ask.
  Explicit denies always remain blocked" — is persisted under the storage scope `internal/permissions`, key
  `enforce_checks`, and **defaults to off**. While it is off, an `ask` outcome silently resolves to `allow`.

Neither of those affects `ShellSafety`. A blanket `allow`, a saved grant for the exact command, and permission checks
disabled all still leave the recursive-delete block in force, because it runs before `permission.assert` and returns a
`ToolFailure` rather than a permission request.

## Command arguments outside the workspace

Command arguments are gated as well as the `workdir`. The V2 bash tool tokenizes the command, expands a leading `~`,
`$HOME`, or `${HOME}`, and for each absolute path that resolves outside the working directory asserts
`action: "external_directory"` with the resource `<parent directory>/*`, saving the same resource on "Allow always". A
`deny` for `external_directory` therefore stops the command before the process starts. Once approved, the tool output
notes each directory:

```text
Command argument references approved external directory <dir>/*.
```

`packages/core/test/tool-bash.test.ts` covers this with "enforces external-directory policy for detected command
arguments", which denies `external_directory`, runs `cat <path outside the project>`, and asserts that the only
permission assertion made is `external_directory`, that no process ran, and that the result is an error. "expands
home-directory command arguments before enforcing scope" does the same for `cat ~/.ssh/id_rsa`. The V1 shell tool asks
`external_directory` for the directories its command scan finds in the same way.

The scan is lexical. It sees literal absolute paths and home-relative paths in the command text, not paths assembled at
run time, read from files, or reached through relative `..` traversal. With the default ruleset `external_directory` is
`ask`, except for the tool-output truncation directory and TurenOS's temporary directory (`Global.Path.tmp`), which are
allowed. While permission checks are not enforced, the `ask` resolves to `allow` anyway.
