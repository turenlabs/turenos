<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts
  and CUSTOMIZE_FORGE_SKILL_DESCRIPTION). The body below becomes the
  skill's content.
-->

# Customizing forge

forge validates its own config strictly and refuses to start when a field
is wrong. The shapes below cover the common surface area, but they are a
**summary, not the source of truth**.

## Full schema reference

The authoritative list of every config option — with field types, enums,
defaults, and descriptions — lives in the published JSON Schema:

**<https://github.com/turenlabs/forge/config.json>**

If a field is not documented in this skill, or you need to confirm an exact
shape before writing config, **fetch that URL and read the schema directly**
rather than guessing. forge hard-fails on invalid config, so the cost of a
wrong shape is a broken startup.

Independently, every `forge.json` should declare
`"$schema": "https://github.com/turenlabs/forge/config.json"` so the user's editor catches
mistakes as they type.

## Applying changes

Config is loaded once when forge starts and is not hot-reloaded. After
saving changes to `forge.json`, an agent file, a command, or any
other config-time file, **tell the user to quit and restart forge** for
the changes to take effect. The running session will keep using the
already-loaded config until then.

## Where files live

| Scope            | Path                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Project config   | `./forge.json`, `./forge.jsonc`, or `.forge/forge.json` (forge walks up from the cwd to the worktree root) |
| Global config    | `~/.config/forge/forge.json` (NOT `~/.forge/`)                                                             |
| Project agents   | `.forge/agent/<name>.md` or `.forge/agents/<name>.md`                                                      |
| Global agents    | `~/.config/forge/agent(s)/<name>.md`                                                                       |
| Project commands | `.forge/command/<name>.md` or `.forge/commands/<name>.md`                                                  |
| Global commands  | `~/.config/forge/command(s)/<name>.md`                                                                     |

Configs from each scope are deep-merged. Project overrides global. Unknown
top-level keys in `forge.json` are rejected with `ConfigInvalidError`.

## forge.json

Every field is optional.

```json
{
  "$schema": "https://github.com/turenlabs/forge/config.json",
  "username": "string",
  "model": "provider/model-id",
  "small_model": "provider/model-id",
  "default_agent": "agent-name",
  "shell": "/bin/zsh",
  "logLevel": "DEBUG" | "INFO" | "WARN" | "ERROR",
  "autoupdate": true | false | "notify",
  "snapshot": true,
  "instructions": ["AGENTS.md", "docs/style.md"],

  "agent": {
    "my-agent": {
      "model": "anthropic/claude-sonnet-4-6",
      "mode": "subagent",
      "description": "...",
      "permission": { "edit": "deny" }
    }
  },

  "command": {
    "deploy": { "description": "...", "template": "..." }
  },

  "permission": {
    "edit": "deny",
    "bash": { "git *": "allow", "*": "ask" }
  },

  "formatter": false,
  "lsp": false,

  "experimental": {
    "primary_tools": ["edit"],
    "mcp_timeout": 30000
  },

  "tool_output": { "max_lines": 200, "max_bytes": 8192 },

  "compaction": { "auto": true, "tail_turns": 15 }
}
```

Shape notes worth being explicit about:

- `model` always carries a provider prefix: `"anthropic/claude-sonnet-4-6"`.
- `agent` is an object keyed by agent name, not an array.
- `command` is an object keyed by command name, not an array.
- `permission` is either a string action or an object keyed by tool name.

## Skills And Data

Skills, references, and other data sources are catalog-managed Extension
contributions. They are not configured with filesystem paths, URLs, Git
repositories, or arbitrary `SKILL.md` discovery in `forge.json`.

Use the Extend page to inspect and activate the available catalog entries.
Only an Extension's declared configuration and secrets can be changed, and
the Extension runtime applies the corresponding policy.

## Agents

Two ways to define an agent. Use the file form for anything non-trivial.

### Inline (in `forge.json`)

```json
{
  "agent": {
    "my-reviewer": {
      "description": "Reviews PRs for style violations.",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "permission": { "edit": "deny", "bash": "ask" },
      "prompt": "You are a strict PR reviewer..."
    }
  }
}
```

### File

```
.forge/agent/my-reviewer.md      OR     .forge/agents/my-reviewer.md
```

```markdown
---
description: Reviews PRs for style violations.
mode: subagent
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash: ask
---

You are a strict PR reviewer. Focus on...
```

The file body becomes the agent's `prompt`. Do not also put `prompt:` in the
frontmatter.

`mode` is one of `"primary"`, `"subagent"`, `"all"`.

Allowed top-level frontmatter fields: `name, model, variant, description, mode,
hidden, color, steps, options, permission, disable, temperature, top_p`. Any
unknown field is silently routed into `options`.

To disable a built-in agent: `agent: { build: { disable: true } }`, or in a
file, `disable: true` in frontmatter.

`default_agent` must point to a non-hidden, primary-mode agent.

### Built-in agents

forge ships with `build`, `plan`, `general`, `explore`. Hidden internal agents:
`compaction`, `title`, `summary`. To override a built-in's fields, define the
same key in `agent: { <name>: { ... } }`.

## Commands

forge's command loader scans for `**/*.md` inside command directories. The
file is named after the command, and lives directly inside the `command` folder:

```
.forge/command/deploy.md
```

Frontmatter:

```markdown
---
description: One sentence describing what the command does.
agent: build
model: anthropic/claude-sonnet-4-6
---

(command body in markdown: the prompt forge runs, with $ARGUMENTS for the user's input)
```

- `template` is the command body — everything below the frontmatter — and is required: it is the prompt forge runs when the command is invoked. Do not also put a `template:` key in the frontmatter.
- `$ARGUMENTS` is replaced with everything the user typed after the command; `$1`, `$2`, … pull individual positional arguments.
- Optional: `description`, `agent`, `model`, `variant`, `subtask`.

## Extensions

Providers, MCP servers, security tools, data sources, and skills
are managed as catalog Extensions. Do not add `plugin`, `provider`, or `mcp`
keys to `forge.json`, and do not load executable packages or local plugin
files through configuration. Use the Extend page to inspect, configure,
enable, and disable the supported catalog entries.

## Permissions

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" }
}
```

Actions: `"allow"`, `"ask"`, `"deny"`.

Per-tool value forms: `"allow"` shorthand (treated as `{"*": "allow"}`), or an
object `{ pattern: action }`. Within an object, **insertion order matters**.
forge evaluates the LAST matching rule, so put broad rules first and narrow
rules last.

`permission: "allow"` (a string at the top level) is shorthand for "allow
everything" and is rarely what the user wants.

Known permission keys: `read, edit, glob, grep, list, bash, task,
external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop,
skill`. Some of these (`todowrite,
question, webfetch, websearch, doom_loop`) only accept a flat
action, not a per-pattern object.

`external_directory` patterns are filesystem paths (use `~/`, absolute paths,
or globs like `~/projects/**`).

Per-agent `permission:` overrides top-level `permission:`. Plan Mode lives on
the `plan` agent's permission ruleset (`edit: deny *`).

## Escape hatches

When a user's config is broken and forge won't start, these env vars help:

- `FORGE_DISABLE_PROJECT_CONFIG=1`: skip the project's local `forge.json`
  and start from globals only. Run from the project directory, forge loads,
  the user edits the broken file, then they restart without the flag.
- `FORGE_CONFIG=/path/to/file.json`: load an additional explicit config.
- `FORGE_CONFIG_CONTENT='{"$schema":"https://github.com/turenlabs/forge/config.json"}'`:
  inject inline JSON as a final local-scope merge.
- `FORGE_PURE=1`: skip external plugins entirely.

## When proposing edits

- Validate against the schema before writing. If you are unsure of a field's
  exact shape, or the field is not covered in this skill, fetch
  `https://github.com/turenlabs/forge/config.json` and read the schema rather than guessing.
- Preserve `$schema` and any existing fields the user did not ask to change.
- For agent and command definitions, prefer creating new files
  in the correct location over inlining everything in `forge.json`.
- If the user's existing config is malformed, point them at the env-var escape
  hatches above so they can edit from inside forge without breaking their
  session.
- After saving any config change, remind the user to quit and restart forge
  — running sessions keep using the already-loaded config.
