# Dangerous Commands

TurenOS's shell tools execute a command string with the host user's full filesystem, process, and network authority. One
mistaken argument in a recursive deletion destroys work that no undo, snapshot, or transcript can recover. `ShellSafety`
statically inspects every shell command before it runs and refuses one narrow class of irreversible mistake: recursive
deletion of anything that is not a literal direct child of the working directory or a temporary directory.

This is a hard block placed in front of the permission system, not another prompt. It is also deliberately narrow: it is
a guard against an agent's plausible mistake, not a security boundary. Read [Limits](#limits) before relying on it.

After this destructive-command check, a separate `ShellToolRouting` policy rejects high-confidence workspace searches
and mutations that belong in `grep`, `glob`, `edit`, or `apply_patch`. That policy improves tool selection; it does not
expand the recursive-delete safety model described here. See [Shell tool routing](./shell-tool-routing.md).

## Scope

The implementation lives in `packages/core/src/shell-safety.ts` and has two callers: the V2 `bash` tool in
`packages/core/src/tool/bash.ts` and the V1 `shell` tool in `packages/forge/src/tool/shell.ts`. Both call it the same way
and at the same point. It models exactly one operation:

```ts
export type Violation = {
  readonly operation: "recursive-delete"
  readonly target: string
  readonly reason: "root" | "home" | "working-directory" | "parent-directory" | "wildcard" | "dynamic"
}
```

`"recursive-delete"` is the only value `operation` ever takes; every construction site in the file uses that literal.
Nothing else about a command is judged by `ShellSafety`. `ShellToolRouting` performs the later, separate classification
of selected search and mutation commands.

A recursive deletion is allowed only when its target resolves to a **direct child** — exactly one path component — of the
working directory, `os.tmpdir()`, or, on non-Windows platforms, `/tmp`. `rm -rf ./dist` and `rm -rf /tmp/forge-build-123`
pass. `rm -rf ./a/b` does not, because the target is two components deep and therefore not a direct child.

The commands whose recursion is understood are `rm`, PowerShell's `Remove-Item` family (`del`, `erase`, `rd`,
`remove-item`, `ri`, `rm`, `rmdir`), `cmd`'s `del`, `erase`, `rd`, and `rmdir`, plus `find` and `xargs` as traversal
drivers. `find` with `-delete`, `-exec`, or `-execdir` is refused whatever its starting point, and `xargs` is refused when
it feeds a recursive `rm` or when a `find` appears in the same command, because neither the file set nor the expanded
argument list is knowable before execution.

## Analysis

### Shell detection

`ShellSafety.kind(shell)` takes the shell path, uses its basename, strips a `.exe` suffix, and lowercases it.
`powershell` and `pwsh` map to `"powershell"`, `cmd` maps to `"cmd"`, and **everything else maps to `"bash"`**. The V2
bash tool passes the configured `shell`, falling back to `/bin/sh` on POSIX and `process.env.COMSPEC ?? "cmd.exe"` on
Windows.

### Parsing

bash and PowerShell command strings are parsed with tree-sitter WASM grammars — `tree-sitter-bash` and
`tree-sitter-powershell` — loaded lazily on first inspection. `inspectRoot` then walks every `command` node in the tree in
document order, so each command in a pipeline, list, or subshell is judged individually.

`cmd` has no grammar. `ShellSafety.parse` and `ShellSafety.inspectParsed` accept only `"bash" | "powershell"`, and a `cmd`
string is handled by a hand-written path that splits on unquoted `&`, `|`, `;`, and newlines and lexes each segment with a
regex. `cmd` analysis is correspondingly weaker than the parsed shells.

Anything the analyser cannot resolve statically is treated as a violation with `reason: "dynamic"` rather than allowed.
Within its scope the check fails closed.

### Wrappers

A naive "is the first word `rm`" check is defeated by `sudo rm -rf /`. Simply skipping leading words is defeated by
`sudo -u root rm -rf /`, where `root` is the value of `-u` and not the command. Both problems need the wrapper's own
option grammar.

`command()` peels wrappers with per-wrapper flag arity. `PREFIX` holds the wrappers for which every leading `-` token can
simply be skipped:

```
builtin  busybox  command  nohup  setsid  stdbuf
```

`exec`, `nice`, `timeout`, and `stdbuf` are matched before `PREFIX` and get bespoke handling, because a subset of their
flags (`-a`, `-n`, `-k`, `-s`, `--kill-after`, `--signal`, `-e`, `-i`, `-o`) consumes the next token. `sudo` and `doas`
use `SUDO_VALUE`, the set of sudo options that take a separate argument:

```
-C  -D  -g  -h  -p  -R  -r  -t  -T  -u  --chdir
```

`env` is handled separately because it can re-lex its own payload: `-S`, `-Sstring`, and `--split-string=` re-tokenize the
string and re-run the whole peel over the result, so `env -S 'rm -rf /'` and `env --split-string='rm -rf' ~` are seen as
the deletions they are.

### Interpreters

Peeling is not always safe. If the wrapper's arguments cannot be trusted to locate the interpreter's script argument, the
analyser refuses rather than guesses. `inspectParts` implements that with three sets. `WRAPPER_SCAN` is the set of first
tokens that trigger a forward scan:

```
builtin  busybox  command  doas  env  exec  nice  nohup  setsid  stdbuf  sudo  timeout
```

`WRAPPED_COMMAND` is what the scan looks for — the commands worth re-inspecting from that point:

```
bash  cmd  dash  find  ksh  powershell  pwsh  rm  sh  zsh
```

`INTERPRETER` is the subset that is refused outright when reached through a wrapper, because its payload is a program
rather than an argument list:

```
bash  cmd  dash  ksh  powershell  pwsh  sh  zsh
```

So `env -P /bin sh -c 'rm -rf "$HOME"'` and `sudo --user root sh -c 'rm -rf "$HOME"'` are refused as
`target: "dynamic evaluator input"`.

Interpreters reached directly are handled by `nested()`, which extracts the payload from `bash -c`, `sh -c`, `eval`,
`powershell -Command`, `pwsh -Command`, `cmd /c`, `cmd /k`, `Invoke-Expression`/`iex`, and `xargs … sh`, then recursively
inspects that string. If the payload is not statically knowable — it contains `$`, a backtick, `%VAR%`, `!VAR!`, a
PowerShell splat, a parenthesised expression, `-EncodedCommand`, or `-Command -` reading from stdin — the command is
refused instead. An interpreter invoked with no recognizable payload flag at all (`sh script.sh`, or the `sh` at the end
of a pipeline) is likewise refused, which is why `curl https://example.com/x.sh | sh` is blocked.

Recursion is bounded: `inspectText` refuses at depth greater than 4 with `target: "nested dynamic input"`.

### Directory changes

Every path judgement is relative to one working directory. A command that changes directory first invalidates that
arithmetic, so the analyser tracks it and refuses any later recursive deletion rather than recomputing.

`CWD_COMMANDS` is the set that sets the flag while walking the parsed tree:

```
cd  chdir  popd  pushd  push-location  set-location
```

The same flag is set by `sudo -D` / `sudo --chdir` and by `env -C` / `env --chdir` during wrapper peeling, and by `cd`,
`chdir`, `popd`, and `pushd` in the `cmd` path. Once set it stays set for the rest of the command string, and a later
recursive deletion is reported as `target: "target after a directory change"`. `cd .. && rm -rf project` and
`Set-Location ..; Remove-Item -Recurse -Force project` are both blocked.

### Command-name obfuscation

Command names are normalized before comparison: surrounding quotes are removed, inner `'…'` and `"…"` pairs are unwrapped,
escape characters are collapsed, the basename is taken, a `.exe` suffix is stripped, and the result is lowercased. Which
escapes are collapsed depends on the shell — backslash and `^` for the POSIX form, `^` and backtick for the Windows form.
That makes `r''m`, `s''h`, `/bin/rm`, `r^d`, and `C:\Windows\System32\cmd.exe` resolve to `rm`, `sh`, `rm`, `rd`, and
`cmd`. PowerShell tokens have their backtick escapes stripped separately, so `Remove-It` + backtick + `em` and
`-Recur` + backtick + `se` are recognized. A command name that is itself dynamic — a substitution, an expansion, a glob,
or a brace expression — combined with recursive flags is refused.

### PowerShell parameter values

`targets()` treats any non-flag token as a deletion target. Without knowing which PowerShell parameters take a value, the
value would be misread as a target: in `Remove-Item -Recurse -Force -ErrorAction $mode ./dist`, `$mode` would look like a
dynamic target and the safe command would be blocked. `POWERSHELL_VALUE_PARAMETERS` lists the common parameters that
consume the following token:

```
-credential  -erroraction  -errorvariable  -exclude  -filter  -include  -informationaction
-informationvariable  -outbuffer  -outvariable  -pipelinevariable  -progressaction  -stream
-warningaction  -warningvariable
```

`POWERSHELL_VALUE_ALIASES` covers their short forms:

```
-ea  -ev  -ia  -iv  -ob  -ov  -pv  -wa  -wv
```

Abbreviations of at least five characters including the leading hyphen are also accepted when they are an unambiguous
prefix of exactly one of those parameters, matching PowerShell's own prefix resolution.
`-LiteralPath` and `-LP` mark their value as literal so a bracketed directory name such as `'[cache]'` is not treated as a
wildcard.

### Target rules

Once a recursive deletion and its targets are identified, each target is judged by `violation()`. The reasons are:

| `reason`            | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `root`              | A filesystem root: `/`, `//`, `C:\`, `\\server\share`, or a target that resolves to one |
| `home`              | `~`, `~name`, or a target that resolves to `os.homedir()`                               |
| `working-directory` | `.`, `~+`, or a target that resolves to the working directory itself                    |
| `parent-directory`  | Any `..` component, or a target that is an ancestor of the working directory            |
| `wildcard`          | An unquoted `*`, `?`, `[`, `]`, `{`, or `}` in the target                               |
| `dynamic`           | Anything that cannot be resolved statically, and anything that is not a direct child    |

`dynamic` is the catch-all and covers substitutions and variables (`$`, backtick, `%VAR%`, `!VAR!`, PowerShell splats),
drive-relative Windows paths such as `C:..`, Windows components with a trailing space or dot (which the OS normalizes
away), absolute paths with a trailing separator or an embedded `.` component, multi-component relative paths, and every
target that survives the earlier checks but is not a direct child of the working directory, `os.tmpdir()`, or `/tmp`.

Single-quoted bash targets are exempt from wildcard, home, and variable interpretation, because the shell will not expand
them either: `rm -rf '*'` and `rm -rf '~'` refer to files literally named `*` and `~` and are allowed.

## Violations

A violation is a hard failure, and it happens before anything else. In the V2 bash tool the order is: resolve the working
directory, read the configured shell, inspect destructive commands, apply specialized-tool routing, and only then request
permission:

```
const violation = yield* ShellSafety.inspect({
  command: input.command,
  cwd: target.canonical,
  shell: ShellSafety.kind(shell),
})
if (violation) return yield* new ToolFailure({ message: ShellSafety.blockedMessage(violation) })

const recommendation = yield* ShellToolRouting.inspect({
  command: input.command,
  cwd: target.canonical,
  shell: ShellSafety.kind(shell),
})
if (recommendation)
  return yield* new ToolFailure({ message: ShellToolRouting.blockedMessage(recommendation) })
```

The model sees a tool error containing `blockedMessage(violation)`:

```text
Blocked dangerous recursive deletion of <target>. TurenOS only allows recursive shell deletion of a narrow literal child of
the working directory or temporary directory, such as ./dist. Filesystem roots, home directories, working-directory
roots, parent directories, wildcard roots, and targets that cannot be resolved statically are not allowed. Use the
appropriate TurenOS file tool for other cleanup.
```

The message interpolates `violation.target`. For a concrete path that is the raw target text as written in the command;
otherwise it is one of ten fixed labels: `a dynamic input`, `dynamic command input`,
`dynamic command or recursion switch`, `dynamic evaluator input`, `dynamic recursion switch`, `find traversal`,
`nested dynamic input`, `pipeline or dynamic input`, `target after a directory change`, and `xargs input`. The `reason`
field is not part of the message; two different reasons produce the same sentence.

There is no prompt, no "allow once", and no way for the user to approve the command from the UI. Both shell
implementations block before their permission call. `packages/core/test/tool-bash.test.ts` locks this in with
"hard-denies unbounded recursive deletion before permission or process execution", which asserts the error text and that
both the recorded permission assertions and the recorded process runs are empty. The V1 shell tool has the equivalent
test in `packages/forge/test/tool/shell.test.ts`, asserting the captured permission requests are empty.

The working directory used for the comparison is canonical. The V2 bash tool inspects against `target.canonical` from
`LocationMutation.resolve`, which resolves symlinks; the V1 shell tool calls `fs.resolve(cwd)` first. A test in the V1
suite, "canonicalizes a symlink workdir before recursive-delete ancestry checks", covers the case where a symlinked
`workdir` would otherwise hide an ancestor relationship.

`ShellSafety` also exports `PROCESS_SAFETY_GUIDANCE`, which is interpolated into the bash tool description and the V1
shell prompt:

```text
When starting background work, capture its PID or process group and stop that exact identifier. Avoid broad command-line
or process-name matching such as `pkill -f`, `killall`, `taskkill /IM`, or wildcard PowerShell process selection because
agent, task, and command text can also appear in TurenOS, sidecar, test-runner, or harness parent command lines.
```

This is prompt text only. Nothing enforces it; `pkill -f` and `killall` are not blocked.

## The Permission Model

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

## Configuration

There is **no configuration key, CLI flag, or environment variable that disables, relaxes, or extends the
recursive-delete guard.** The allow rule, the command sets, and the depth limit are compiled in.

Two `forge.json` keys are relevant to the surrounding behaviour:

| Key           | Type                                    | Default                                               |
| ------------- | --------------------------------------- | ----------------------------------------------------- |
| `shell`       | string                                  | `/bin/sh` on POSIX; `COMSPEC` or `cmd.exe` on Windows |
| `permissions` | array of `{ action, resource, effect }` | absent; unmatched actions fall back to `ask`          |

`shell` is documented as "Default shell to use for terminal and shell tool execution". It matters here only because
`ShellSafety.kind` derives the grammar from it: setting it to `pwsh` selects PowerShell analysis, setting it to `cmd.exe`
selects the `cmd` path, and setting it to anything else selects bash analysis.

`permissions` is documented as "Ordered tool permission rules applied to agent tool use". `effect` is one of `"allow"`,
`"deny"`, or `"ask"`. The top-level ruleset is appended to every agent's rules, and a per-agent `permissions` array under
`agents.<name>` is appended after that; since evaluation takes the last match, later rules win.

```json
{
  "shell": "/bin/zsh",
  "permissions": [
    { "action": "bash", "resource": "*", "effect": "ask" },
    { "action": "bash", "resource": "git *", "effect": "allow" },
    { "action": "external_directory", "resource": "*", "effect": "deny" }
  ],
  "agents": {
    "plan": {
      "permissions": [{ "action": "bash", "resource": "*", "effect": "deny" }]
    }
  }
}
```

Two details of resource matching are easy to get wrong. `*` becomes `.*` and `?` becomes `.`, so patterns are anchored
globs over the whole string; and a pattern ending in a space followed by `*` also matches the bare prefix, so `git *`
matches `git` as well as `git status`. Home-directory expansion of `~` and `$HOME` in a resource is applied only to the
`external_directory`, `read`, and `edit` actions — never to `bash`, because a bash resource is raw shell text and
rewriting `$HOME/private/**` would not match `$HOME/private/key`.

Deny rules on `bash` are matched against the literal command string. They are useful for narrowing an agent, but they are
string matching, not command analysis: a denied command reached through a wrapper, an alias, or an interpreter will not
match the pattern.

## Protected Filesystem Paths

`packages/core/src/filesystem/protected.ts` is sometimes assumed to be part of this protection. It is not. It is a table
of OS-privacy-protected locations — the macOS TCC categories under the home directory and `~/Library`, the darwin root
metadata directories, and the Windows shell folders — and it exists so that scanning does not trip a consent prompt.

Its only consumers are `packages/core/src/ripgrep.ts`, which turns the list into `--glob=!` exclusions for its `glob`,
`find`, and `grep` operations, and `packages/core/src/filesystem/watcher.ts`, which appends the paths to the watcher's
ignore list. The effect is that those paths are invisible to search and to the watcher. Nothing is blocked, no error is
raised, and no permission is requested. It places no restriction whatsoever on what the bash tool may read, write, or
delete, and it returns an empty list on Linux. There is no test coverage for it.

## Limits

Everything below is a property of the current implementation, not a wish list.

**TurenOS is not a sandbox.** The bash tool's own description says it executes a command "with the host user's filesystem,
process, and network authority". Once the command starts, nothing constrains it. The rest follows from that.

**Only recursive deletion is modelled by `ShellSafety`.** Non-recursive deletion is not: `rm -f /etc/passwd` passes, and
`rm -f /` is in the test suite's explicitly-allowed list. Nor does `ShellSafety` model overwrites, truncation, permission
changes, or block-device writes. The later routing policy catches a narrow set of direct workspace writes such as
`echo value > file`, `tee file`, `sed -i`, and `perl -pi`, but it is not a general mutation analyser.
`dd if=/dev/zero of=/dev/disk0` and `chmod -R 000 /` remain outside both analyses.

**Only the delete commands listed above are recognized.** Any other program that deletes recursively is invisible.
`git clean -xfd`, `make clean`, `npx rimraf /`, `node -e "require('fs').rmSync('/', { recursive: true, force: true })"`,
and `python3 -c "import shutil; shutil.rmtree('/')"` are all allowed by the analyser. So is a script written to disk with
the write tool and then invoked by an interpreter TurenOS does not recognize.

**Any shell that is not PowerShell or `cmd` is parsed as bash.** `fish`, `nu`, and other shells with different quoting
and expansion rules are analysed with a grammar that does not describe them.

**The interpreter list is a fixed set of names.** `nested()` recognizes `bash`, `dash`, `ksh`, `sh`, `zsh`, `eval`,
`powershell`, `pwsh`, `cmd`, and `Invoke-Expression`. A shell outside that list used the same way is not descended into
at all: `fish -c 'rm -rf /'` is allowed by the analyser.

**`cmd` analysis is not parser-based.** It is regex splitting and lexing, and is the weakest of the three paths.

**Target paths are not resolved on disk.** The working directory is canonicalized, but the target is judged by lexical
path arithmetic against it. Nothing stats the target or resolves symlinks in it. In practice the depth-one rule and the
refusal of trailing separators bound the damage rather than symlink resolution doing so.

**The check is on text, at one instant.** It runs before the process starts. The filesystem may change between the check
and execution, and the command may create, move, or link things once it is running.

**It is not a defence against a determined adversary.** The analysis is a static model of a handful of command shapes.
Anything an attacker — or prompt-injected content steering the agent — can express outside those shapes passes through.
Treat it as insurance against a plausible agent mistake in a command it wrote itself, and rely on the permission model,
backups, and version control for anything stronger.

**Process-safety guidance is advice, not enforcement.** `pkill -f`, `killall`, and `taskkill /IM` are described as
hazardous in the tool description and are not blocked.

## Tests

`packages/core/test/shell-safety.test.ts` is the specification in practice: a table of 125 commands that must be blocked
and 23 that must be allowed, each run through `ShellSafety.inspect` with `cwd` set to `/workspace/project`, plus three
targeted cases for ancestor detection with a `..`-prefixed directory name, a `cmd` control-body delete against a Windows
`cwd`, and Windows trailing-space normalization, and one assertion that `PROCESS_SAFETY_GUIDANCE` still says what it is
supposed to say. Add a case to the appropriate table when changing behaviour; the tables are the reason the evasion
handling can be refactored safely.

Integration behaviour — that a violation blocks before permission and before execution — is covered in
`packages/core/test/tool-bash.test.ts` for the V2 bash tool and `packages/forge/test/tool/shell.test.ts` for the V1 shell
tool. Permission evaluation, the default-off enforcement toggle, and saved grants are covered in
`packages/core/test/permission.test.ts`.

Specialized-tool routing has its own reviewed command corpus in `packages/core/test/fixtures/tool-routing.json`, replayed
by `packages/core/test/shell-tool-routing.test.ts` and measured by
`packages/core/test/benchmark/tool-routing.ts`. See [Shell tool routing](./shell-tool-routing.md) for scope, benchmark
interpretation, and focused commands.
