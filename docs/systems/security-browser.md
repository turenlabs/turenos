# Security browser and proxy

Each Desktop session has one shared Security Browser and Proxy workspace, shown in the session's **Browser** panel. A
person drives it from the panel, and the session's agent can drive it through the [agent tools](#agent-tools). The browser's case is a
named, durable container for captured traffic and rules. Creating it does not
start an AI scan or require a model.

## Workflow

1. In a Desktop session, open the **Browser** panel, or run **Open Security
   Browser and Proxy** from the command palette. The session's case is
   `browser_<sessionID>`, created when the agent calls `browser_start`; until
   then the panel waits for it.
2. Open its Security Browser. The toolbar is trusted local UI; the destination runs in
   a separate sandboxed WebContentsView without a preload or Node access.
3. Browse with Intercept off to collect History. Reveal a selected flow explicitly
   before editing protected headers, bodies, or existing notes.
4. Enable Intercept to hold requests. Forward or drop explicitly. Response pauses
   are configured with a response-stage rule; use a request-pass rule when only
   the response should pause. Read a bounded response body before editing it.
5. Copy a revealed captured request to Repeater. Choose captured headers or live
   browser cookies, edit the request, and send once. Redirects are not followed
   automatically. Each explicit send has a new identity. Name, duplicate, or
   switch tabs to keep separate drafts and send histories.
6. Use **Load older** or **Load all** to browse the complete stored history.
   Use **Apply to case** to search all pages by URL, ID, method, status, exact
   hostname, MIME type, or source. Enable **masked content** to search bounded
   header and text-body previews. Protected values and notes are not searchable.
7. Compare saved responses with highlighted text-line, word, or hex differences.
   Comparisons use masked values by default. **Reveal both** requires explicit
   confirmation. Comparisons cannot establish equality of hidden or missing data.
8. Export the complete case or applied filter results as case JSON or HAR 1.2.
   Masked exports include bounded payload previews. Original exports require
   confirmation and include captured secrets. Review every export before sharing.

## Agent tools

The session's agent can drive the same browser and case through nine tools
(`packages/core/src/tool/security-proxy.ts`). A `deny` rule on a tool's name (resource `*`) keeps it out of the agent's
tool list. The tools don't request permission per call, so an `ask` rule adds no prompt.
All nine are deferred: they are not in the agent's initial tool list, and the agent loads them with `tool_load` before
its first call.

| Tool                | What it does                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `browser_start`     | Opens the session's Security Browser, optionally at a URL, and returns the case and a snapshot.          |
| `browser_navigate`  | Navigates the open browser; bare hosts use `https`.                                                      |
| `browser_status`    | Reads the browser status and any paused requests.                                                        |
| `browser_intercept` | Turns request/response interception on or off; turning it off settles held traffic.                      |
| `browser_decide`    | Decides one paused request: read, reveal, extend, forward with edits, or drop. Decisions are single-use. |
| `browser_history`   | Lists a masked history page with case-wide filters; pass `nextCursor` as `cursor` to read older pages.   |
| `browser_flow`      | Inspects one flow, masked unless reveal is requested explicitly.                                         |
| `browser_replay`    | Sends a captured request once, with optional edits to method, URL, headers, body, or cookies.            |
| `browser_stop`      | Closes the browser and clears its live profile; saved case history stays.                                |

`browser_decide` and `browser_replay` send real traffic to the target. Starting the browser runs no scan and no model.

## Boundaries

- Case data is owner-scoped by canonical local directory and optional workspace
  identity. One live app window controls a case at a time.
- Any HTTP(S) destination is allowed so the browser can follow real SaaS flows
  across identity, collaboration, cloud, and cluster services. App-internal
  origins remain protected.
- Browser data uses a fresh non-persistent partition per open generation. Closing
  the browser clears that profile, but not the case's encrypted history.
- Core reuses Storage guarded batches and SecretVault. Payloads are chunked before
  sealing. New history summaries include only a normalized response MIME type,
  not full headers or bodies. Existing summaries are read from saved payloads
  when needed. Content search and exports read bounded pages.
- Desktop-to-sidecar operations use the private utility-process message port.
  There is no new HTTP ingest endpoint, external proxy, MITM CA, or extra Chromium.
- A held request expires by being dropped, never by silently forwarding. Lost
  debugger ownership destroys the affected remote contents. Unknown replay
  outcomes are not automatically retried.
- Display masking is intentionally not a guarantee that arbitrary secrets in
  response text can be detected. Reveal and export remain explicit user actions.

## Limits

This implementation covers the core HTTP(S) interception and replay workflow. It currently has one target view per
case; popup
OAuth, browser tabs, downloads, WebSocket frame editing, client certificates,
custom certificate exceptions, linked scan evidence, and curl export are not
provided. There is no built-in HTTP authentication credential prompt; explicit
Authorization headers can be edited through Proxy. Live replay refreshes cookies
only, not JavaScript-held tokens or other authorization headers.
Normal certificate validation remains enabled. Service workers are
bypassed for capture, so this mode does not reproduce offline/PWA behavior.

Full-body edits are bounded to 1 MiB. Streaming bodies and unavailable uploads
cannot be edited as complete messages. Replay rejects duplicate request-header
names that Electron's request transport cannot represent faithfully. Raw displays
are protocol-visible representations, not wire-exact HTTP/2 messages.

History initially shows the latest page. Loading older rows or applying filters
stops automatic history replacement; use **Refresh** to include new traffic.
Sorting applies to loaded rows. Case storage remains limited to 10,000 flows
and 100 MiB. Repeater drafts stay in memory until the case changes or the page
closes. Sent requests remain in encrypted case history.

Diffs inspect up to 64 KiB per response body and have a processing limit.
Masked text-body previews stop at 65,536 characters; binary previews are unavailable.
JSON exports preserve original/edit relationships and capture states. HAR uses
extension fields for capture states and binary request-body encoding. HTTP
versions and detailed timing phases are not recorded and are not inferred.
Exports read successive stored pages, not a transaction-wide snapshot.

## Verification

Run from the relevant package directory, or use these explicit package selectors:

```sh
bun test --cwd packages/protocol test/proxy-policy.test.ts
bun test --cwd packages/core test/security-proxy.test.ts
bun test --cwd packages/app src/pages/security-proxy-model.test.ts
bun test --cwd packages/app ./test-browser/security-proxy.test.ts
bun test --cwd packages/desktop src/main/security-proxy-bridge.test.ts src/main/window-security.test.ts src/main/window-registry.test.ts src/main/shutdown.test.ts
bun test --cwd packages/forge test/server/httpapi-listen.test.ts --test-name-pattern 'owns private proxy storage'
bun --cwd packages/desktop scripts/security-proxy-integration.ts
```

The Electron integration harness launches its own isolated Electron process and
loopback fixtures. It exercises the production controller with a store boundary
fixture; separate Core and Server tests exercise real persistence and the
listener-owned service. It does not restart or attach to the running TurenOS app.
The capability probe in `packages/desktop/scripts/security-browser-probe.cjs` is
supplementary, not a replacement for production-controller testing.

## Source

- [`packages/desktop/src/main/security-proxy.ts`](../../packages/desktop/src/main/security-proxy.ts)
- [`packages/desktop/src/preload/security-browser.ts`](../../packages/desktop/src/preload/security-browser.ts)
- [`packages/desktop/src/renderer/security-browser.ts`](../../packages/desktop/src/renderer/security-browser.ts)
- [`packages/core/src/security-proxy.ts`](../../packages/core/src/security-proxy.ts)
- [`packages/core/src/security-proxy-runtime.ts`](../../packages/core/src/security-proxy-runtime.ts)
- [`packages/core/src/tool/security-proxy.ts`](../../packages/core/src/tool/security-proxy.ts)
- [`packages/app/src/pages/security-proxy.tsx`](../../packages/app/src/pages/security-proxy.tsx)
- [`packages/protocol/src/proxy-policy.ts`](../../packages/protocol/src/proxy-policy.ts)
