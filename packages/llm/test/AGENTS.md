# Recorded tests

Recorded tests use one cassette file per scenario. A cassette holds an ordered array of `{ request, response }` interactions, so multi-step flows (tool loops, retries, polling) record into a single file. Use `recordedTests({ prefix, requires })` and let the helper derive cassette names from test names:

```ts
const recorded = recordedTests({ prefix: "openai-chat", requires: ["OPENAI_API_KEY"] })

recorded.effect("streams text", () =>
  Effect.gen(function* () {
    // test body
  }),
)
```

Replay is the default. `RECORD=true` records fresh cassettes and requires the listed env vars. Cassettes are written as pretty-printed JSON so multi-interaction diffs stay reviewable.

Pass `provider`, `protocol`, and optional `tags` to `recordedTests(...)` / `recorded.effect.with(...)` so cassettes carry searchable metadata. Use recorded-test filters to replay or record a narrow subset without rewriting a whole file:

- `RECORDED_PROVIDER=openai` matches tests tagged with `provider:openai`; comma-separated values are allowed.
- `RECORDED_PREFIX=openai-chat` matches cassette groups by `recordedTests({ prefix })`; comma-separated values are allowed.
- `RECORDED_TAGS=tool` requires all listed tags to be present, e.g. `RECORDED_TAGS=provider:togetherai,tool`.
- `RECORDED_TEST="streams text"` matches by test name, kebab-case test id, or cassette path.

Filters apply in replay and record mode. Combine them with `RECORD=true` when refreshing only one provider or scenario.

- Replay serves recorded interactions strictly in record order and checks method, URL, allow-listed headers, and JSON body. If a test reorders its requests, re-record its cassette.
- Non-textual response bodies are stored as base64 (`bodyEncoding: "base64"`); don't hand-edit them as text.
- Use `scriptedResponses` from `test/lib/http.ts` for tests that don't need a live provider.

Do not blanket re-record an entire test file when adding one cassette. `RECORD=true` rewrites every recorded case that runs, and provider streams contain volatile IDs, timestamps, fingerprints, and obfuscation fields. Prefer deleting the one cassette you intend to refresh, or run a focused test pattern that only registers the scenario you want to record. Keep stable existing cassettes unchanged unless their request shape or expected behavior changed.
