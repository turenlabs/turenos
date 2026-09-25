# Security Browser and Proxy

Each Desktop session has one shared Security Browser and a manual Proxy
workspace, shown in the session's **Browser** panel. The browser's case is a
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
   automatically. Each explicit send has a new identity.
6. Compare saved responses as text or hex, add case notes, preview literal rules,
   and export masked history summaries.

## Boundaries

- Case data is owner-scoped by canonical local directory and optional workspace
  identity. One live app window controls a case at a time.
- Any HTTP(S) destination is allowed so the browser can follow real SaaS flows
  across identity, collaboration, cloud, and cluster services. App-internal
  origins remain protected.
- Browser data uses a fresh non-persistent partition per open generation. Closing
  the browser clears that profile, but not the case's encrypted history.
- Core reuses Storage guarded batches and SecretVault. Payloads are chunked before
  sealing; history lists decrypt small manifests rather than all captured bodies.
- Desktop-to-sidecar operations use the private utility-process message port.
  There is no new HTTP ingest endpoint, external proxy, MITM CA, or extra Chromium.
- A held request expires by being dropped, never by silently forwarding. Lost
  debugger ownership destroys the affected remote contents. Unknown replay
  outcomes are not automatically retried.
- Display masking is intentionally not a guarantee that arbitrary secrets in
  response text can be detected. Reveal and export remain explicit user actions.

## Limits

This implementation covers the core manual HTTP(S) workflow, not every capability
in the planning whiteboard. It currently has one target view per case; popup
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

## Verification

Run from the relevant package directory, or use these explicit package selectors:

```sh
bun test --cwd packages/protocol test/proxy-policy.test.ts
bun test --cwd packages/core test/security-proxy.test.ts
bun test --cwd packages/app src/pages/security-proxy-model.test.ts
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
