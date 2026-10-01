# Provider facades

Provider-facing APIs are configured facades over route values. Endpoint/auth/resource/API-version setup happens before model selection, and model selectors accept only a model or deployment id:

```ts
const openai = OpenAI.configure({ apiKey, baseURL })
const model = openai.responses("gpt-4o-mini")

const azure = Azure.configure({ resourceName, apiKey, apiVersion: "v1" })
const deployment = azure.responses("my-deployment")

const gateway = CloudflareAIGateway.configure({ accountId, gatewayId, gatewayApiKey, apiKey })
const proxied = gateway.model("openai/gpt-4o-mini")
```

Keep provider facades small and explicit:

- Use branded `ProviderID.make(...)` and `ModelID.make(...)` where ids are constructed directly.
- Use `model` for the default API path and named methods for provider-native alternatives such as OpenAI `responses`, `responsesWebSocket`, and `chat`.
- Put provider-specific setup on `.configure(...)`; do not add `model(id, overrides)` as a duplicate construction path.
- Export lower-level `routes` arrays separately only when advanced internal wiring needs them.
- Prefer `apiKey` as provider-specific sugar and `auth` as the explicit override; keep them mutually exclusive in provider option types with `ProviderAuthOption`.
- Resolve `apiKey` → `Auth` with `AuthOptions.bearer(options, "<PROVIDER>_API_KEY")` (it honors an explicit `auth` override and falls back to `Auth.config(envVar)` so missing keys surface a typed `Authentication` error rather than a runtime crash).
- Use separate top-level facades for products with different required setup, such as `CloudflareAIGateway` and `CloudflareWorkersAI`.

`Provider.make(...)` remains available for simple static provider definitions, but new built-in providers should prefer plain configured facades unless a helper removes real duplication without adding runtime behavior.
