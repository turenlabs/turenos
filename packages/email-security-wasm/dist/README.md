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
this operation. Use the existing bounded YARA, archive, and binary tools for
separate attachment analysis.

`sanitize_html(html)` applies a strict email allowlist with Ammonia. It removes
scripts, forms and event attributes, permits only `http`, `https`, and `cid`
links, rejects relative URLs, and caps input at 2 MiB. Sanitization is not a
trust verdict; links should still be reviewed by the IOC and scoring tools.
