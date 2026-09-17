# PDF Inspect WASM

Bounded, offline PDF structure analysis for document-malware triage and agent
inspection, built on `lopdf` 0.45.0 (MIT, pinned `=0.45.0`). The module is
byte-only: it has no network, filesystem, DNS, or process APIs, and it never
executes JavaScript, never dereferences external references, and never renders
page content.

## Operations

All operations take `(bytes: Uint8Array, options_json: string)` and return a
JSON string. Failures are reported as `{"schema_version": 1, "error": code}`
rather than thrown. An empty options string or `{}` selects defaults; options
must be a JSON object.

### `pdf_inspect`

Document summary plus a `findings` array of suspicious indicators. Reports
PDF version, page/object counts, object-stream and compressed-object counts,
`encrypted` and `decrypted_on_load` flags (no password is ever supplied; a
password-protected document reports `encrypted` without decrypting),
`linearized`, xref type, trailer and catalog key lists, capped `/Info`
metadata (producer/creator/dates), a deduplicated bounded `urls` list, and the
SHA-256 of the input bytes.

Findings flag `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/URI`,
`/SubmitForm`, `/RichMedia`, `/EmbeddedFile(s)`, `/AcroForm`, `/XFA`, `/Names`
dictionaries, `/Encrypt`, object-stream presence, `/S` action types, external
URLs found inside string objects, and `javascript:`/`data:` URIs. Every finding
carries `code`, `severity`, `detail`, and the owning `[object, generation]`.

Options: `max_findings` (default and cap 4096), `max_urls` (default and cap
256).

### `pdf_objects`

Bounded object table: `object_id`/`generation`, object `kind`, `/Type`,
`/Subtype`, `stream` flag, encoded `stream_length`, declared `filters`,
top-level dictionary `keys`, and `suspicious_keys` collected by a bounded scan
of that object.

Options: `object_id` + `generation` select one object (error
`object_not_found` when absent), `type` filters by `/Type` name
(case-insensitive), `kind` filters by object variant, `max_results` (default
and cap 4096).

### `pdf_stream_decode`

Decodes one stream object selected by `object_id` (required) and `generation`,
returning bounded decoded bytes as `data_base64` plus `filters`,
`encoded_length`, `decoded_length`, `decoded_sha256`, and `delivered_bytes`.
Supported filters: FlateDecode, ASCIIHexDecode, ASCII85Decode, LZWDecode,
RunLengthDecode, BrotliDecode, including chains. Undecodable filters return
`unsupported_filter` with the offending names instead of silently returning
raw bytes; decoded output over `max_output_bytes` fails closed with
`decoded_stream_too_large`; payloads too large for the JSON output bound are
delivered truncated with `truncated: true` and `delivered_bytes`.

Options: `object_id` (required), `generation`, `max_output_bytes` (default and
cap 8 MiB).

### `pdf_text`

Bounded text extraction over the page tree via lopdf's bounded content
decoding. Returns `text`, `page_count`, `pages_processed`, `text_chars`,
per-page `warnings`, and `truncated`.

Options: `start_page` (1-based, default 1), `max_pages` (default 1024, cap
4096), `max_chars` (default 262144, cap 524288 bytes of text).

## Bounds

Limits are enforced before allocation and again after serialization: input
≤ 32 MiB, options ≤ 4 KiB, JSON output ≤ 4 MiB, results ≤ 4096. During load,
each eagerly-decoded object or xref stream is capped at 16 MiB against
decompression bombs; `pdf_stream_decode` caps decoded output at 8 MiB;
`pdf_text` caps each page's decompressed content at 8 MiB. The object scan is
depth-bounded (16) and node-budgeted (8192 nodes per object) and never follows
references, so cyclic object graphs cannot loop it.

## Build and verify

```sh
cargo test --manifest-path tools/pdf-inspect/Cargo.toml
wasm-pack build tools/pdf-inspect --target web --release --out-dir pkg
node tools/pdf-inspect/script/pack.mjs tools/pdf-inspect/pkg artifact/pdf-inspect-wasm
node tools/pdf-inspect/test/verify.mjs artifact/pdf-inspect-wasm/dist
cd artifact/pdf-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

`test/verify.mjs` loads the real compiled module and constructs PDF bytes by
hand — no mocks, no duplicated logic.
