# Web search and web fetch

`websearch` and `webfetch` are local agent tools that reach the public internet from the TurenOS server: `websearch`
sends the query to Exa or Parallel, and `webfetch` downloads a URL the agent chooses. Both contact external services
with the query or URL as written, and both run the same way whatever model provider the Session uses. They are separate
from provider-hosted search tools, which run at the model provider (see
[LLM tool dispatch](./model-provider-layer/llm-tool-dispatch.md)).

## How it works

Session V2 registers both tools for every Location (`packages/core/src/tool/builtins.ts`). The legacy runtime registers
its own copies in `packages/forge/src/tool/registry.ts`.

**`websearch`** (`packages/core/src/tool/websearch.ts`):

1. Reads whether the built-in data extensions `turenlabs/websearch-exa` and `turenlabs/websearch-parallel` are enabled.
   Both are enabled by default (`defaultEnabled` in `services/catalog/manifests/data/`).
2. Picks the backend with `selectProvider`: the only enabled one, or, when both are enabled, a stable choice from a
   checksum of the Session ID, so one Session always uses the same backend. With neither enabled the call fails with
   "No web search extension is enabled".
3. Asks permission for the `websearch` action with the query as the resource.
4. Reads the backend's optional API key from the extension's secrets (`EXA_API_KEY` or `PARALLEL_API_KEY`) and calls
   the backend's hosted MCP endpoint with one JSON-RPC tool-call request (MCP method "tools/call"):

   | Backend  | Endpoint                         | MCP tool         | Without a key                    | With a key                                      |
   | -------- | -------------------------------- | ---------------- | -------------------------------- | ----------------------------------------------- |
   | Exa      | `https://mcp.exa.ai/mcp`         | `web_search_exa` | request sent with no credentials | key sent as the `exaApiKey` URL query parameter |
   | Parallel | `https://search.parallel.ai/mcp` | `web_search`     | request sent with no credentials | `Authorization: Bearer <key>` header            |

   Exa receives the query, `type`, `numResults`, `livecrawl`, and `contextMaxCharacters`. Parallel receives the query
   as its objective and only search query, plus the Session ID; it ignores the other options.

5. Returns the first text item of the MCP result, or "No search results found" when there is none.

**`webfetch`** (`packages/core/src/tool/webfetch.ts`):

1. Rejects any URL that is not `http:` or `https:`.
2. Asks permission for the `webfetch` action with the URL as the resource.
3. Sends a GET with a desktop Chrome `User-Agent` and an `Accept` header weighted toward the requested format. If
   Cloudflare answers `403` with `cf-mitigated: challenge`, it retries once with a short non-browser `User-Agent`.
4. Accepts only textual responses: `text/*`, JSON, XML, and JavaScript types, or a missing content type. Images and
   other binary types fail.
5. Converts HTML with Turndown for `markdown` (the default) or extracts visible text for `text`, dropping scripts and
   styles; `html` and non-HTML bodies are returned unchanged.

Either tool reports any failure to the model as one generic message ("Unable to search the web for …" or "Unable to
fetch …"), without the underlying cause.

## Tool input

| Tool        | Field                  | Values                                  | Default                              |
| ----------- | ---------------------- | --------------------------------------- | ------------------------------------ |
| `websearch` | `query`                | string                                  | required                             |
| `websearch` | `numResults`           | 1 to 20                                 | 8                                    |
| `websearch` | `livecrawl`            | `fallback`, `preferred`                 | `fallback`                           |
| `websearch` | `type`                 | `auto`, `fast`, `deep`                  | `auto`                               |
| `websearch` | `contextMaxCharacters` | 1 to 50,000                             | 10,000 (applied by Exa when omitted) |
| `webfetch`  | `url`                  | `http://` or `https://` URL             | required                             |
| `webfetch`  | `format`               | `markdown`, `text`, `html`              | `markdown`                           |
| `webfetch`  | `timeout`              | seconds, greater than 0 and at most 120 | 30                                   |

## Configuration

- **Backend choice**: enable or disable the Exa Web Search and Parallel Web Search extensions (see
  [developer catalog runtime](./developer-catalog-runtime/README.md)). Disabling one pins every Session to the other;
  disabling both turns web search off.
- **API keys**: optional. They are extension secrets stored in the TurenOS secret vault (see
  [secure storage](./secure-storage.md)), never in configuration files.
- **Permissions**: the actions are `websearch` and `webfetch`, with the query or URL as the resource, so rules can
  allow, ask, or deny per pattern. The default V2 agent rules allow both, and the `research` specialist allows them
  explicitly (`packages/core/src/plugin/agent.ts`). Approving a prompt with "always" saves an allow rule for every
  query or URL (`*`).

## Verification

```sh
cd packages/core
bun test test/tool-websearch.test.ts test/tool-webfetch.test.ts
cd ../forge
bun test test/tool/websearch.test.ts test/tool/webfetch.test.ts
```

## Limits

- `websearch`: each backend request times out after 25 seconds, and a response larger than 256 KiB fails.
- `webfetch`: a response larger than 5 MiB fails, whether declared by `Content-Length` or counted while streaming. The
  timeout covers the request and body download.
- `webfetch` follows no authentication flow and sends no cookies; it fetches what an anonymous client sees. It does not
  block private or loopback addresses, so a permitted call can reach services on the server's network.
- Large text results may be replaced in the model context with a preview while the complete output is kept in managed
  storage.
- The legacy runtime's copies differ in a few ways:
  - `websearch` is hidden from the tool list, not failed, when neither extension is enabled.
  - `websearch` has no response-size limit, does not cap `numResults` or `contextMaxCharacters`, and also sends
    Parallel the model name.
  - `webfetch` returns images as attachments, and it clamps a timeout above 120 seconds instead of rejecting it.

## Source

- [`packages/core/src/tool/websearch.ts`](../../packages/core/src/tool/websearch.ts)
- [`packages/core/src/tool/webfetch.ts`](../../packages/core/src/tool/webfetch.ts)
- [`packages/core/src/tool/http-body.ts`](../../packages/core/src/tool/http-body.ts)
- [`packages/core/src/tool/builtins.ts`](../../packages/core/src/tool/builtins.ts)
- [`packages/core/src/extension.ts`](../../packages/core/src/extension.ts)
- [`packages/forge/src/tool/websearch.ts`](../../packages/forge/src/tool/websearch.ts)
- [`packages/forge/src/tool/webfetch.ts`](../../packages/forge/src/tool/webfetch.ts)
- [`packages/forge/src/tool/mcp-websearch.ts`](../../packages/forge/src/tool/mcp-websearch.ts)
- [`packages/forge/src/tool/registry.ts`](../../packages/forge/src/tool/registry.ts)
- Manifests: [`services/catalog/manifests/data/websearch-exa.json`](../../services/catalog/manifests/data/websearch-exa.json),
  [`services/catalog/manifests/data/websearch-parallel.json`](../../services/catalog/manifests/data/websearch-parallel.json)
- Tests: [`packages/core/test/tool-websearch.test.ts`](../../packages/core/test/tool-websearch.test.ts),
  [`packages/core/test/tool-webfetch.test.ts`](../../packages/core/test/tool-webfetch.test.ts)
