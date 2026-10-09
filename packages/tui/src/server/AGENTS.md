# One server connection

`connect()` (`connect.ts`) builds everything that talks to one server:
- the generated `@turenlabs/client`, on this package's `createTransport` (`transport.ts`);
- `createApi` (`src/api.ts`) for routes the generated client lacks;
- the provider routes (`src/providers/`);
- the shared working-folders store;
- the live event stream (`src/live-events/`).

## Conventions

- Send requests only through those paths; never add a bare `fetch` elsewhere. Each path:
  - refuses redirects (`redirect: "error"`), so credentials never follow one;
  - bounds what it reads (`readBounded`, `src/response-validation/body.ts`);
  - spreads `dial(socketPath)` from `proxy.ts`, so a server on a Unix socket works.
- `validateConnection` allows a password only over HTTPS, HTTP on `127.0.0.1` or `[::1]`, or a Unix socket. A socket connection uses the origin `http://localhost` (`SOCKET_ORIGIN`).
- The transport passes each generated-client response through `validateResponse` (`src/response-validation/validate.ts`), which routes by API path to a validator.
  - An `/api/` route with no validator passes through unchecked, so a route the TUI starts reading needs one there, with a test.
  - Other root routes are refused, except `/global/storage`, which the working-folders store parses itself.
- 401 and 403 become an `UnauthorizedError` body before anything is read, because an untrusted server could pad an error.
- Name every size or count limit as a constant that each path enforcing it imports (`RESPONSE_BYTES`, `RESPONSE_CHUNKS`).
