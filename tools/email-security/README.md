# Email Security WASM

Bounded RFC 5322 and MIME analysis for `.eml` and `message/rfc822` input.
The module is byte-only and has no network, filesystem, DNS, or process APIs.

The initial operation is `inspect(bytes, options_json)`. It returns decoded
headers, addresses, subject, MIME attachment metadata, optional text/HTML
bodies, URLs/email addresses/IPv4/hash IOCs, and conservative security signals
such as advertised SPF, DKIM, or DMARC failures. Advertised authentication
headers are evidence only; they are not cryptographic verification.

Hard limits are enforced inside WASM before the result crosses into
JavaScript: 32 MiB input, 512 headers, 256 attachments, 2,048 IOCs, 64 KiB
individual values, and 4 MiB body text. Attachment bytes are never returned by
this operation. Use the separate `email_extract_attachment` host tool to save
one attachment before bounded YARA, archive, or binary analysis.

`extract_attachment(bytes: Uint8Array, index: number, max_output_bytes: number)
-> Uint8Array` returns one decoded attachment, using the same zero-based order
as `inspect`. Both numeric arguments are required: index must be an integer
0–255 and max_output_bytes an integer 1–8,388,608. Invalid bounds, missing
attachments, transfer-decoding problems, and oversize input/output throw errors.
Empty attachments are valid. MIME filenames are never paths. Text attachment
contents follow mail-parser's charset decoding; binary contents remain bytes.
Parsing is capped at 32 MiB; mail-parser decodes parts during parsing, so the
output cap is checked on the selected decoded slice before allocating its
returned vector, not before parser-internal decoding allocations.

Build with `wasm-pack build --target web --release`, then run
`node test/verify.mjs pkg` from this directory. No additional dependencies are
required. Packaging remains `node script/pack.mjs` after verification.

`sanitize_html(html)` applies a strict email allowlist with Ammonia. It removes
scripts, forms and event attributes, permits only `http`, `https`, and `cid`
links, rejects relative URLs, and caps input at 2 MiB. Sanitization is not a
trust verdict; links should still be reviewed by the IOC and scoring tools.
