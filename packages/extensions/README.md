# TurenOS Extensions

Extension v1 is the declarative catalog consumed by TurenOS. An extension may
contribute tools, MCP servers, data sources, and skills. Runtime code stays in
TurenOS adapters; catalog entries cannot execute arbitrary JavaScript.

Each extension is one JSON manifest under `manifests/`. Add the file, then run
`bun run generate` from this package. CI runs `bun run check` and rejects stale,
invalid, or duplicate catalog entries.

New entries must declare every secret, executable, upstream tool, and
write-capable operation. Unknown MCP tools are blocked by default. Linear is
the sole exception: `audited-linear-dynamic-v1` pins its endpoint, credential,
two broker tools, and write policy while runtime code permits only names
advertised by that exact upstream. A manifest is distribution metadata and
never grants filesystem, process, or network authority by itself. New adapter
names require a separately reviewed runtime; declarative hosted or
customer-URL MCP adapters do not execute extension code.
