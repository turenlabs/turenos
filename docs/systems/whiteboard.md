# Session whiteboard

Whiteboard is a primary session dock tab. Terminal remains available under More.
The editor is Excalidraw, embedded locally and loaded only after opening a board.

## Collaboration

Open the same session on the same TurenOS server in multiple clients to share its
board. Existing server authentication applies. Cursors, selections, and participant
presence are live; drawings and raster images are persisted in SQLite. Presence is
ephemeral and expires after 30 seconds without a heartbeat.

Changes merge by element ID using Excalidraw's version and version-nonce ordering.
Independent edits are preserved; simultaneous changes to the same element resolve
at element granularity, not as character-level text collaboration. Deleted elements
remain as tombstones to prevent stale clients from resurrecting them.

The editor shows Saving, Saved, or Offline. Unacknowledged edits are kept in an
IndexedDB recovery outbox scoped to server and session, and replay after reconnect
or navigation. If browser storage is unavailable, an explicit warning advises
exporting a local copy before leaving. Camera position and local selection are not
broadcast as shared document state.

## Agent Tools

- `whiteboard_read`: reads the board and revision, optionally selected element IDs.
  Image data is summarized rather than included as base64 in model context.
- `whiteboard_update`: creates, updates, or removes shapes, lines, arrows, and text.
  It requires the revision from a read; stale edits fail rather than overwrite newer
  changes. Successful agent edits publish short-lived presence indicators.

Tools default to the top-level session's board so delegated agents work on the
human-visible canvas. Explicit session targets remain permission-checked.

## Local Assets And Limits

No Excalidraw room server or cloud storage is used. Fonts and their notices ship
with the application, and the upstream font CDN fallback is removed in both dev
and production builds. Hosted library browsing, external embeds, and AI generation
are disabled. Local drawing, image import, and file export remain available.

Boards are bounded to 5,000 elements including tombstones, 4 MiB serialized scene
data, and 16 MiB of raster file data with a 4 MiB per-file limit. PNG, JPEG, GIF,
and WebP data URLs are supported; SVG and remote image URLs are not accepted.

## Source

- [`packages/core/src/session/whiteboard.ts`](../../packages/core/src/session/whiteboard.ts)
- [`packages/core/src/session/whiteboard.sql.ts`](../../packages/core/src/session/whiteboard.sql.ts)
- [`packages/core/src/tool/whiteboard.ts`](../../packages/core/src/tool/whiteboard.ts)
- [`packages/app/src/components/whiteboard/index.tsx`](../../packages/app/src/components/whiteboard/index.tsx)
- [`packages/app/src/components/whiteboard/sync.ts`](../../packages/app/src/components/whiteboard/sync.ts)
- [`packages/app/src/components/whiteboard/outbox.ts`](../../packages/app/src/components/whiteboard/outbox.ts)
