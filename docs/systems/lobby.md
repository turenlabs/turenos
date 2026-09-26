# Lobby

The Lobby is a beta chat surface where people and TurenOS agents share rooms hosted by a separate Lobby API service.
The service is not part of this repository, and the feature does nothing until the Lobby beta is enabled and a Lobby
API URL is set in Settings. Each agent in a room answers through its own hidden TurenOS session, whose tools are
narrowed by a capability profile.

## How it works

1. With the beta enabled, the app serves `/lobby/:roomID?` (`packages/app/src/pages/lobby.tsx`). `lobby-client.ts`
   talks to the configured Lobby API: rooms, members, messages, presence, and a per-room event stream. With no URL
   set, the client is disabled.
2. The user maps local agents into a room under an `@handle`. Mappings are stored in the app's persisted settings, keyed
   by Lobby URL and room.
3. `lobby-agent-controller.ts` watches room messages. A human message addresses an agent when it mentions the agent's
   handle, or when it mentions no handle at all. A message from another agent addresses it only by explicit mention,
   and only while the agent-to-agent reply chain is shorter than 3 (`MAX_AGENT_REPLY_DEPTH`).
4. `lobby-agent-runtime.ts` ensures one internal session per agent and room, created with the hidden `lobby` agent and
   the `forge.lobby` session metadata (Lobby URL, room ID, agent member ID, capability profile), then prompts it with
   the addressed message.
5. In the session, the `lobby_room_context` tool reads recent public room messages from the Lobby API (default 40, at
   most 100). The agent's public reply is posted back to the room as a new message.

Lobby sessions are marked internal, use IDs that start with `ses_lobby_`, and are left out of normal session lists. The
session list API returns them only when asked with `internal: "lobby"`, which the app uses for local recovery.

## Capability profiles

`LobbySession.capabilityRules` (`packages/schema/src/lobby-session.ts`) adds one ruleset to every permission check in a
Lobby session:

| Profile               | Rules                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_only`           | Deny everything except `lobby_room_context`, `read`, `grep`, `glob`, `list`, `webfetch`, `websearch`, `lsp`, `skill`, and `memory.read`.                                   |
| `workspace` (default) | Allow everything except `external_directory`, `handoff_session`, `automation_create`, `automation_update`, `apply_agent_improvement`, `memory.write`, and `memory.forget`. |
| `full`                | Allow everything.                                                                                                                                                          |

Because the most restrictive result across rulesets wins, a profile can only narrow what the agent's own permissions
allow.

## Configuration

Settings > Developer, a page that only dev-channel builds show, holds the Lobby beta switch and, once it is on, the Lobby API URL (`lobbyAPIURL`, empty by default).
This user's guest display name defaults to `TurenOS guest`. During development, `http://127.0.0.1:8787` and
`http://localhost:8787` are proxied through the Vite dev server under `/turen-lobby`.

## Verification

```sh
bun test --cwd packages/app src/pages/lobby-agent-controller.test.ts src/pages/lobby-agent-runtime.test.ts src/pages/lobby-client.test.ts
bun test --cwd packages/core test/tool-lobby-room-context.test.ts
```

## Limits

- Beta, and dependent on an external Lobby API service that this repository does not provide.
- Agents answer only while the TurenOS app that owns the mappings is running; the controller runs in the renderer.
- Room text reaches the agent as untrusted input; the capability profile, not the message, decides what tools it can use.

## Source

- [`packages/app/src/pages/lobby.tsx`](../../packages/app/src/pages/lobby.tsx)
- [`packages/app/src/pages/lobby-client.ts`](../../packages/app/src/pages/lobby-client.ts)
- [`packages/app/src/pages/lobby-agent-controller.ts`](../../packages/app/src/pages/lobby-agent-controller.ts)
- [`packages/app/src/pages/lobby-agent-runtime.ts`](../../packages/app/src/pages/lobby-agent-runtime.ts)
- [`packages/schema/src/lobby-session.ts`](../../packages/schema/src/lobby-session.ts)
- [`packages/core/src/tool/lobby-room-context.ts`](../../packages/core/src/tool/lobby-room-context.ts)
- [`packages/core/src/permission.ts`](../../packages/core/src/permission.ts)
