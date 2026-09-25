# CodeMode tool discovery

CodeMode builds a budgeted model-visible catalog of host tools and provides a runtime search tool. See the [CodeMode overview](./README.md) for its authority boundary and the [API](./api.md) for runtime construction.

## Catalog selection

The agent-tool instructions use a budgeted catalog. Every tool namespace is listed with its tool count regardless of budget. Complete, JSDoc-annotated signatures are inlined while the budget lasts. Schema field descriptions and tags count toward each signature's estimated cost.

Selection proceeds round-robin across alphabetically ordered namespaces. In each round, a namespace attempts to place its next-cheapest signature. If it does not fit, that namespace drops out while the others continue. The generated guide labels coverage overall (`COMPLETE list` or `PARTIAL - N of M shown`) and per namespace (`(3 tools)`, `(3 tools, 1 shown)`, or `(3 tools, none shown)`).

The catalog-entry budget defaults to 2,000 estimated tokens (characters / 4, the same heuristic TurenOS uses). It applies only to full tool entries shown in the catalog; fixed instructions and namespace summaries are not counted. Override it when constructing a runtime:

```ts
const runtime = CodeMode.make({
  tools,
  discovery: { catalogBudget: 6_000 },
})
```

The budget must be a non-negative safe integer.

The runtime search tool is always registered - including when the catalog is fully inlined - so a speculative `tools.$codemode.search` call never fails as an unknown tool. It is only advertised in the instructions when the inlined list is partial:

```ts
const matches = await tools.$codemode.search({
  query: "order status",
  namespace: "orders", // optional: scope to one top-level namespace
  limit: 10,
  offset: 0,
})
```

`search` performs deterministic, additive field-weighted matching. The query is tokenized (camelCase boundaries split; every non-alphanumeric character is a separator; empties and `*` are dropped), and each term scores every tool: exact path or path-segment match (20), path substring (8), description substring (4), and searchable-text substring (2). Each term also carries naive singular variants (trailing `s`/`es` stripped), and a field check passes when the term or any variant matches - so a plural query term (`issues`) still finds a tool whose text only says `issue`, without changing the weights. The searchable text also includes the input schema's property names and their description strings, so a query naming a parameter finds its tool, and substring matching means partial words match. Scores sum across terms; matches are sorted by score (ties broken alphabetically by path), then sliced from the zero-based `offset` (default 0) to the configured `limit` (default 10). `remaining` counts matches after the current page. `next` is `{ offset }` when another page exists and `null` on the final page; spread it into the original request to preserve its query, namespace, and limit.

```ts
const request = { query: "order status", namespace: "orders", limit: 10 }
const page = await tools.$codemode.search(request)
const nextPage = page.next ? await tools.$codemode.search({ ...request, ...page.next }) : undefined
```

Each result contains the path, description, and the same generated TypeScript signature used by the inline catalog, so no second lookup is needed. Signatures use the JSDoc-annotated multiline form: each described input/output field carries its schema `description` as a `/** ... */` comment, and constraints TypeScript cannot express ride along as tags (`@deprecated`, `@default`, `@format`, `@minItems`, `@maxItems`).

```ts
tools.github.list_issues(input: {
  /** Repository owner */
  owner: string,
  /** Cursor from the previous response's pageInfo */
  after?: string,
  /**
   * Results per page
   * @default 30
   */
  perPage?: number,
}): Promise<unknown>
```

Result paths are rendered as JavaScript expressions rooted at `tools` (`tools.orders.lookup`, or `tools.context7["resolve-library-id"]` for non-identifier segments), so each `path` is directly usable as the call site. An empty query browses the catalog alphabetically by path; combined with `namespace` (`{ query: "", namespace: "orders" }`) it lists everything in that namespace. A query that names one tool path exactly (canonical path, `tools.`-prefixed path, or rendered JavaScript expression) is treated as a lookup and returns that tool alone.

The instructions are structured markdown, ordered so the workflow sits at the top and the catalog at the bottom: a `## Workflow` section with numbered steps (find a tool via search when the catalog is partial, or pick from the inlined list when it is complete; call the exact path as-is; return only the needed fields), a `## Rules` section holding only guidance the workflow does not already cover (only listed/search-result Code Mode tools and internal runtime tools exist inside `tools`; filter and aggregate collections in code; narrow `Promise<unknown>` results at runtime; run independent calls through `Promise.all`; enumerate `tools` with `Object.keys`/`for...in`; browse a namespace and paginate search results when search is advertised), a short `## Language` section that identifies the runtime as a restricted JavaScript orchestration language and names its major unavailable capabilities, and the budgeted `## Available tools` catalog. Example call forms use explicit `<namespace>.<tool>`/`<field>` placeholders - never a real or fabricated tool name.

A host cannot define its own `$codemode` top-level namespace.

## Source

- [`packages/codemode/src/tool-runtime.ts`](../../../packages/codemode/src/tool-runtime.ts)
