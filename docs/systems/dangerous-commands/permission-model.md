# The permission model

Deletion safety, specialized-tool routing, and permissions are separate systems that meet only in ordering.
`ShellSafety` runs first and cannot be overridden. `ShellToolRouting` runs second and redirects high-confidence workspace
searches and mutations. `PermissionV2` runs last and is entirely user-configurable.

After the safety and routing checks pass, the bash tool may assert permission twice. If the resolved `workdir` is outside
the active Location, it first asserts `action: "external_directory"` with the resource `<canonical directory>/*`. It
always asserts the tool's own action:

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
bash grant matches only that exact command again. Saved grants can only upgrade an `ask` to an `allow`; a configured
`deny` is checked first and is never overridable.

Two things are worth stating plainly because they change what "protected" means in practice:

- The built-in ruleset for the default agent begins with `{ action: "*", resource: "*", effect: "allow" }`. Out of the
  box, `bash` is allowed without a prompt.
- The "Enforce permission checks" toggle — described in the UI as "Require approval for actions configured as Ask.
  Explicit denies always remain blocked" — is persisted under the storage scope `internal/permissions`, key
  `enforce_checks`, and **defaults to off**. While it is off, an `ask` outcome silently resolves to `allow`.

Neither of those affects `ShellSafety`. A blanket `allow`, a saved grant for the exact command, and permission checks
disabled all still leave the recursive-delete block in force, because it runs before `permission.assert` and returns a
`ToolFailure` rather than a permission request.

The command-argument scan is a different matter. The bash tool tokenizes the command, and for each absolute path outside
the working directory emits a warning:

```text
Command argument references external directory <dir>/*. Bash runs with host-user filesystem, process, and network
authority; this scan is advisory only.
```

This is advisory in the literal sense. `packages/core/test/tool-bash.test.ts` has "reports external command arguments as
advisory warnings without enforcing approval", which sets the `external_directory` action to deny, runs
`cat <path outside the project>`, and asserts that the only permission assertion made is `bash` and that the process ran
anyway. Only the resolved `workdir` is gated by `external_directory`; command arguments are not.
