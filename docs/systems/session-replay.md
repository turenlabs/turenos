# Session replay

Session replay searches every session and its durable events from one query, and pages through a single session's raw
event history. The app shows it at `/replay`. Its search index is built lazily: nothing is indexed until the first
replay search, after which a background backfill fills it in and search results report indexing progress.

## How it works

1. `GET /api/session/replay` (`session.replay`) calls `SessionV2.replay`. The first call enables the index in
   `session_replay_meta`, runs one backfill batch inline, and starts the background backfill. Later process starts
   resume the backfill automatically once the index is enabled.
2. The backfill indexes sessions and event text in batches of 64 sessions and 16 events, pausing 100 ms between
   batches. New writes queue in `session_replay_pending_v3`. The index lives in `session_replay_v3` with an FTS5 table,
   `session_replay_fts_v3`; a rebuild moves to a new table suffix instead of dropping the old index on a request path.
3. `SessionReplay.search` parses the query into free text and filters, matches sessions and events (never Lobby or
   other internal sessions), and returns scored entries, a total, a cursor for the next page, the parsed query, and the
   index status (`indexing` or `ready`, with progress).
4. `GET /api/session/:sessionID/replay` (`session.replayHistory`) reads one session's complete debug stream: its durable
   events in order, with previous and next cursors.

## Query syntax

Free text matches indexed session and event text. Filters are `field:value`, and a leading `-` negates one:

| Filter                   | Matches                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `session:`               | Session ID                                                                                                        |
| `id:`                    | Entry or event ID                                                                                                 |
| `message:`, `call:`      | Message ID or tool call ID                                                                                        |
| `type:`                  | Event type family, such as `type:tool`                                                                            |
| `agent:`                 | Agent name                                                                                                        |
| `model:`                 | Model ID or provider ID                                                                                           |
| `tool:`, `status:`       | Tool name or status                                                                                               |
| `path:`                  | File path mentioned by an event                                                                                   |
| `after:`, `before:`      | Time: relative (`30m`, `12h`, `7d`, `2w`), epoch milliseconds, or a date `Date.parse` accepts. Cannot be negated. |
| `has:error`              | Entries with an error. `error` is the only supported value.                                                       |
| `is:session`, `is:event` | Restrict results to sessions or to events.                                                                        |

A malformed query fails with `SessionReplay.QueryError` and the character position of the problem.

## Verification

```sh
bun test --cwd packages/core test/session-replay.test.ts
bun test --cwd packages/app src/pages/session-replay-model.test.ts
```

## Limits

- Queries are capped at 2,048 characters, 64 tokens, and 128 search terms.
- Only the first 2,048 characters of session text, 960 characters of each event text fragment, and 1,024 characters of a
  path are indexed.
- Until the backfill finishes, older sessions can be missing from results; the page reports `indexing` progress.

## Source

- [`packages/core/src/session/replay.ts`](../../packages/core/src/session/replay.ts)
- [`packages/core/src/session.ts`](../../packages/core/src/session.ts)
- [`packages/protocol/src/groups/session.ts`](../../packages/protocol/src/groups/session.ts)
- [`packages/server/src/handlers/session.ts`](../../packages/server/src/handlers/session.ts)
- [`packages/app/src/pages/session-replay.tsx`](../../packages/app/src/pages/session-replay.tsx)
