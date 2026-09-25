# Configuration

TurenOS reads `forge.json` and `forge.jsonc` documents from the global config directory and from the opened project,
then applies them in priority order to the Session V2 schema in `packages/core/src/config.ts`. A document that fails to
parse or decode is ignored in full, so one invalid value silently drops every setting in that file. For that reason
bounded numbers are clamped where they are used rather than rejected by the schema.

## Where configuration is read

When a Location opens, `Config.Service` collects documents from these places, lowest priority first:

1. The global config directory: `$XDG_CONFIG_HOME/forge` (by default `~/.config/forge`), or `FORGE_CONFIG_DIR` when set.
2. `forge.json` and `forge.jsonc` found by walking up from the opened directory to the project root. A file farther
   from the opened directory is applied before a nearer one.
3. `forge.json` and `forge.jsonc` inside each `.forge/` directory on the same walk, farther first.

Within one directory `forge.json` is applied before `forge.jsonc`. The documents are read once per Location and reused
until the Location is reopened.

How a key combines across documents depends on the key:

- Single values (`model`, `shell`, `default_agent`, `subagents`, `compaction`, and the other object settings) resolve
  to the value in the highest-priority document that sets the key (`Config.latest`). Objects are not merged field by
  field.
- `permissions` from every document are concatenated, lowest priority first, and appended to every agent's rules.
  Evaluation takes the last matching rule, so a nearer document's rule wins.
- `providers`, `commands`, and `skills` are applied document by document, so a later document adds entries and
  overrides entries with the same name.
- `experimental.policies` are applied in reverse document order, so a rule in the global file overrides a repository
  rule. Statement order inside a file is kept, and the last matching statement wins.

## Legacy and v1 documents

`decodeDocument` accepts both schema versions. A document that uses a v1-only key is migrated with
`ConfigMigrateV1.migrate`; any other document is read as v2 first and falls back to v1. Inside a v2 document:

- A v1 `provider` block is migrated and merged under `providers`; v2 entries win on conflict.
- `disabled_providers` and `enabled_providers` become `provider.use` statements in `experimental.policies`. The Desktop
  still writes `disabled_providers` when a provider is disconnected.
- v1 compaction names (`preserve_recent_tokens`, `tail_turns`, `reserved`) become `compaction.keep.tokens`,
  `compaction.keep.turns`, and `compaction.buffer`.

The legacy `packages/forge` runtime has its own loader, which also honours `FORGE_CONFIG` (an extra config file) and
`FORGE_CONFIG_CONTENT` (inline JSON). The Session V2 loader reads neither.

## Top-level keys

The descriptions are the schema annotations. "Legacy" marks keys read only by the legacy `packages/forge` runtime.

| Key               | Type                       | Default                                      | Meaning                                                                                                   |
| ----------------- | -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `$schema`         | string                     | none                                         | JSON schema reference for editor validation (`https://github.com/turenlabs/forge/config.json`).           |
| `model`           | string                     | none                                         | Default model when no session or agent model is selected, as `provider/model`.                            |
| `default_agent`   | string                     | built-in default                             | Default primary agent when no session agent is selected.                                                  |
| `shell`           | string                     | `/bin/sh`; `COMSPEC` or `cmd.exe` on Windows | Shell for the terminal and shell tools. It also selects the `ShellSafety` grammar.                        |
| `permissions`     | rule array                 | none                                         | Ordered `{ action, resource, effect }` rules; `effect` is `allow`, `deny`, or `ask`.                      |
| `agents`          | record of agent objects    | none                                         | Built-in agent overrides and custom agents. See [Agents](#agents).                                        |
| `subagents`       | object                     | see below                                    | Durable subagent delegation limits.                                                                       |
| `snapshots`       | boolean                    | `true`                                       | Snapshots used for undo and revert. Only `false` disables them.                                           |
| `watcher`         | object                     | none                                         | `ignore`: extra glob patterns the filesystem watcher skips.                                               |
| `attachments`     | object                     | see below                                    | Image attachment processing.                                                                              |
| `tool_output`     | object                     | 2,000 lines, 51,200 bytes                    | `max_lines` and `max_bytes` before tool output is written to a file and shown as a preview.               |
| `compaction`      | object                     | see below                                    | Conversation compaction and replay pruning.                                                               |
| `retention`       | object                     | see below                                    | How long stored session payloads are kept in full before they are reduced to previews.                    |
| `reflection`      | object                     | enabled, every 20 sessions                   | `enabled` and `every_sessions` for embedded reflection checkpoints.                                       |
| `semantic_memory` | object                     | disabled                                     | `enabled: true` downloads the `potion-base-8M` model and adds local semantic memory retrieval.            |
| `commands`        | record of command objects  | none                                         | Named slash commands. See [Commands](#commands).                                                          |
| `skills`          | string array               | none                                         | Ordered local directories or HTTPS sources for skill discovery.                                           |
| `plugins`         | array                      | none                                         | Plugin packages to load, each a package name or `{ package, options }`. Subject to plugin trust.          |
| `providers`       | record of provider objects | none                                         | Provider and model overrides. See [Providers](#providers).                                                |
| `experimental`    | object                     | none                                         | `harness_self_modification` and `policies`. See [Experimental](#experimental).                            |
| `formatter`       | boolean or record          | disabled                                     | Legacy. `true` enables the built-in formatters; a record enables them and overrides or disables entries.  |
| `lsp`             | boolean or record          | disabled                                     | Legacy. `true` enables the built-in language servers; a record enables them and overrides entries.        |
| `autoupdate`      | boolean or `"notify"`      | install patch releases, notify for others    | Legacy CLI upgrade check. `false` (or `FORGE_DISABLE_AUTOUPDATE`) disables it; `"notify"` only notifies.  |
| `username`        | string                     | none                                         | Legacy. Name shown in conversations. The server's Basic Auth username is `FORGE_SERVER_USERNAME` instead. |
| `enterprise`      | object                     | none                                         | Legacy. `url` of the session import and revocation service.                                               |

## Nested settings

| Key                                      | Default | Notes                                                                                                                    |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `subagents.max_concurrent`               | 50      | Subagents one session may run at once. Values above 50 are clamped.                                                      |
| `attachments.image.auto_resize`          | `true`  | Resize images that exceed the limits below.                                                                              |
| `attachments.image.max_width`            | 2,000   | Pixels.                                                                                                                  |
| `attachments.image.max_height`           | 2,000   | Pixels.                                                                                                                  |
| `attachments.image.max_base64_bytes`     | 5 MiB   | Encoded size limit.                                                                                                      |
| `compaction.auto`                        | `true`  | Compact automatically when the context budget runs out. A user-requested compaction ignores it.                          |
| `compaction.prune`                       | `true`  | Clear stale tool results from replay. `false` also turns off the clearing options below.                                 |
| `compaction.pruneInputs`                 | `true`  | Also clear stale, re-derivable tool inputs (`write`, `edit`, `apply_patch` bodies).                                      |
| `compaction.pruneMedia`                  | `true`  | Also clear stale media attachments past the protect window.                                                              |
| `compaction.dedupOutputs`                | `true`  | Clear older tool results that are byte-identical to a newer one.                                                         |
| `compaction.ledger`                      | `true`  | Carry an append-only ledger of durable facts with each checkpoint. Costs one extra short summarizer call per compaction. |
| `compaction.keep.tokens`                 | 16,000  | Recent tokens kept out of the summary. Clamped to 200,000.                                                               |
| `compaction.keep.turns`                  | 2       | Recent turns kept out of the summary; `0` disables turn alignment. Clamped to 50.                                        |
| `compaction.buffer`                      | 20,000  | Tokens reserved below the context limit. Clamped to 500,000.                                                             |
| `retention.toolOutputDays`               | 14      | Days a stored tool payload is kept in full. `0` disables; values above 3650 are clamped.                                 |
| `retention.archivedSessionDays`          | 30      | Days after archiving before tool payloads and shell output are reduced to previews. `0` disables; clamped to 3650.       |
| `reflection.every_sessions`              | 20      | Completed root sessions between reflection checkpoints.                                                                  |
| `experimental.harness_self_modification` | off     | Allow the automatic Harness reviewer to propose and apply self-modifications.                                            |

## Agents

Each `agents.<name>` entry overrides a built-in agent or defines a new one. Fields: `model`, `variant`, `system`,
`description`, `mode` (`primary`, `subagent`, or `all`), `hidden`, `color`, `steps` (a positive integer), `disabled`,
and `permissions`. An agent's `permissions` are appended after the top-level rules. Agents can also be written as
Markdown files under `agent/` or `agents/` in any config directory.

## Commands

Each `commands.<name>` entry defines a slash command with a required `template` plus optional `description`, `agent`,
`model`, `variant`, and `subtask`. Commands can also be written as Markdown files under `command/` or `commands/` in any
config directory; the file name is the command name.

## Providers

Each `providers.<id>` entry can set `name`, `env` (credential variable names), `api` (an AI SDK package and URL, or a
native URL), `request.headers`, `request.body`, and `models`. Each `models.<id>` entry can set `name`, `family`, `api`,
`capabilities`, `request`, `variants`, `cost`, `limit`, and `disabled`. The v1 `provider` form, with `npm`, `api`, and
`options`, is still accepted and migrated; see [Local models](../providers/local-models.md) for a worked example.

## Experimental

`experimental.policies` holds `{ action, resource, effect }` statements, where `effect` is `allow` or `deny`. The only
action today is `provider.use`, whose resource is a provider ID. The last matching statement wins.

## Verification

```sh
bun test --cwd packages/core test/config/config.test.ts test/config/provider.test.ts test/config/command.test.ts
```

## Limits

- A document that fails to parse or decode is ignored entirely, with no error surfaced to the session.
- Unknown keys are ignored rather than rejected.
- Documents are read when a Location opens; editing a file does not affect an open Location until it is reopened.
- The legacy and Session V2 loaders read the same files with different schemas, so a key marked legacy has no effect
  on Session V2 behavior.

## Source

- [`packages/core/src/config.ts`](../../packages/core/src/config.ts)
- [`packages/core/src/config/`](../../packages/core/src/config/)
- [`packages/core/src/v1/config/migrate.ts`](../../packages/core/src/v1/config/migrate.ts)
- [`packages/core/src/session/compaction.ts`](../../packages/core/src/session/compaction.ts)
- [`packages/core/src/retention.ts`](../../packages/core/src/retention.ts)
- [`packages/core/src/image.ts`](../../packages/core/src/image.ts)
- [`packages/forge/src/config/config.ts`](../../packages/forge/src/config/config.ts)
