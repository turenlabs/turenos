# Secret output protection

TurenOS masks supported credentials in tool-result text and JSON before ordinary output retention and model submission. This lets an agent investigate configuration files, incident logs, and repositories without routinely copying recognizable credentials into its transcript. It is a disclosure safeguard, not a sandbox or a comprehensive DLP system.

## What changes

Matched values become references such as `[SECRET:v1:github:<fingerprint>]`. Repeated occurrences remain correlatable under the same vault key without exposing the value. Fingerprints are keyed and domain-separated; they are not plain hashes of credentials. Changing the installation vault key changes references. Without persistent vault configuration, the existing ephemeral vault behavior limits stability to that process.

Protection is enabled by default. There is no model-accessible reveal command, broad off switch, or retained raw copy created by this feature. Original source files are not rewritten.

Built-in edit, write, patch, and agent shell inputs containing a reference are rejected, with a tool error, before anything executes. This prevents accidentally replacing a source credential with masked text. The check is deliberately literal: any input containing `[SECRET:v1` is refused, including a reference cut short by a preview and a search such as `rg '\[SECRET:v1'`. To search for references, leave out the leading bracket (`rg -F 'SECRET:v1:'`). Input the check cannot inspect (not plain data, too deep, or too large) is refused the same way. This guard does not validate arbitrary truncated source text or cover every possible mutation channel.

## Covered boundaries

- Core tool settlement: structured values, textual content, error strings, and interceptor annotations. Output is protected before managed overflow retention and durable settlement storage; cached settlements are protected when returned.
- Managed text overflow: the joined text is checked again before storage because concatenating individually safe fragments can reconstruct a credential. Attachments keep their position when that recheck changes the text.
- Shell jobs and Core direct shell: captured output and failure text are protected before the independent job storage or the durable `shell` message, and before the byte cap. The command line the user typed is stored as entered.
- Legacy Forge tools: final local, broker, and MCP text/metadata, streamed metadata, shared truncation files (including output streamed to a saved file while a shell command runs), and running/completed/error tool-part persistence. Direct shell completion returns the protected persisted part.
- Model requests: conversational text and tool-result text/JSON are checked before the normal Core and Forge request paths, including Core title and compaction requests. This also protects supported values in older tool results when they are sent again; it does not rewrite their historical storage.
- Truncated derivatives: the Session title prompt, compaction's summarization and fact-extraction prompts, the persisted `recent` tail, fallback checkpoint excerpts, and provider failure details are protected before they are trimmed or elided, so a cut can only split a reference, never a credential.
- Provider-hosted results: supported result fields are protected before local durable publication. Provider error text is protected before it becomes a durable step failure. Claude Code bridge replies and GitLab workflow callback results and failures are protected separately from publication; a failed callback returns a protected diagnostic rather than a generic error.

Provider-hosted tools already execute upstream. TurenOS cannot prevent a provider from initially seeing information produced inside that provider's environment.

## Detection and known credentials

The initial high-confidence format detectors cover selected GitHub, GitLab, Slack, Stripe live-key, Google API-key, AWS access-key-ID, and PEM private-key forms. An AWS access-key ID is an identifier, not a complete AWS credential. Detection is deliberately bounded and does not recognize every variant of these formats.

An operation acquires a snapshot of configured provider keys and OAuth access/refresh values, plus declared extension secret fields, including disabled extensions. These literal values are masked even when they have no recognizable format. All findings are located on the original text before anything is replaced, and overlapping findings become one reference. A stored value that embeds a recognizable token (for example an `AKIA…:secret` pair) is therefore masked whole, and so are configured values that overlap each other. When a detected token and a configured value cover exactly the same text, the detected format names the reference.

Configured values that cannot be told apart from ordinary text are not masked:

- values shorter than 12 characters;
- values with fewer than 6 distinct characters;
- a few documented "any key works" placeholders such as `sk-no-key-required` and `your-api-key`.

Placeholder keys such as `ollama` or `EMPTY` would otherwise rewrite ordinary words in prompts, tool output and source the agent must edit. A real credential this short is not protected by this feature. Format detectors still apply to it.

A snapshot belongs to one operation and is released with it. An operation is a provider turn in the Core runner, one tool settlement, one legacy Forge processing step, or one shell, title, compaction, persistence, or workflow callback. Nothing is cached across operations in a process-global raw-secret registry, and a failed acquisition is not remembered. A credential stored or rotated while an operation is running is recognized from the next operation. Arbitrary environment variables are not enumerated.

## Bounds and failure behavior

Work is bounded:

- Text and JSON processing has a 16 MiB byte budget, and JSON traversal is limited to depth 64 and 100,000 nodes.
- Snapshots accept at most 256 eligible values totaling 64 KiB. Credential acquisition also has enumeration limits and a five-second timeout.
- A configured value longer than 64 KiB, or more eligible values than the snapshot budget allows, makes protection unavailable rather than silently incomplete.

Protection fails closed: the original text is never used in place of text the guard could not process. Failure is scoped so that it does not wedge the Session:

- Provider requests: history is re-sent every turn, so each part is protected independently. A stored part the guard cannot process (written by an older build, deeper than the walk allows, or over the byte budget) is replaced by `[Content withheld: secret redaction failed]`, and the rest of the request proceeds. If no snapshot can be acquired, the turn ends with a visible step failure before any provider request is made.
- Tool settlement: without a snapshot, the tool is not executed and the call settles with an error. Output that cannot be protected settles as a fixed "withheld" error.
- Durable tool records: every tool call still receives a terminal event. A result that cannot be protected is stored as a fixed failure. Cleanup and step failures use fixed text when protection is unavailable.
- Compaction declines with `protectionUnavailable` and sends nothing. Title generation is skipped and the Session keeps its placeholder name.
- Shell output that cannot be protected is replaced by a fixed notice without stranding completion. Streamed shell output is released to its saved file only at least 4,096 characters (or the longest configured value) behind the live end, and never inside a finding; an unterminated private key block is held until it closes. Past 16 MiB of held output, the rest of the stream is withheld.
- Legacy Forge persistence: during an outage, new tool text is withheld, while text already stored for a part is kept as stored. Re-saving a historical part, such as a compaction mark, never destroys it. The part's own provider metadata (signatures, item IDs) is opaque and left byte-for-byte intact. Display metadata is normalized the way its persisted JSON would be: dates become ISO strings, non-finite numbers become `null`, and plain class instances become their own data fields. Accessors and `toJSON` hooks are never invoked; only a node the walk refuses to read is withheld.
- Workflow callbacks: without a snapshot, the callback does not run and the service receives an ordinary tool error.

Cancellation remains cancellation. An interrupted Claude Code bridge call is still settled as interrupted in the durable transcript.

## Limits

Do not treat an unmasked result as proof that it contains no sensitive information.

- Unknown formats, arbitrary passwords, short or low-variety configured values, PII, entropy-based discovery, encoded secrets, OCR, images, and binary artifacts are not generally detected.
- Media payloads/URIs, attachment fields, opaque provider metadata, signed reasoning, and transport authentication are not generally rewritten. Authentication must still work.
- Raw tool arguments, pending inputs, typed direct-shell commands, original files, existing event logs, and pre-existing output artifacts are not scrubbed at rest by this feature. Model-generated assistant text is stored as produced; it is protected when sent again.
- A producer that truncates or encodes a credential before the guard sees it can defeat detection. Matches split across unrelated structured fields are not reconstructed for detection. A detected token directly adjacent to another credential can lose its word boundary and go unrecognized on that pass.
- This is not containment against malicious plugins, shell network traffic, deliberate encoding, or other exfiltration channels. Plugin hooks observe tool output before final protection.
- Custom tools that independently persist data or bypass the covered settlement paths need their own review. Binary artifact writes are not text-redaction boundaries. Forge's agent-generation helper sends only the user's description and is not a guarded path.
- An exception or log outside the covered output paths is not covered simply because the tool's eventual error part is protected.

For sensitive investigations, combine this safeguard with appropriate workspace, credential, network, and execution controls. It reduces accidental disclosure; it does not replace those controls.

## Verification

Regression tests use synthetic credentials and isolated storage. They cover:

- real Core file reads followed by captured provider requests, with event, projection and execution records and overflow files;
- repeated shell observations, streamed shell truncation files, and Core direct shell;
- configured opaque credentials, including the eligibility policy and overlapping or composite values;
- legacy post-hook output and persistence, including metadata compatibility and a transient outage over historical parts;
- provider-hosted publication, cleanup and snapshot outages, and a legacy history record the guard cannot process;
- Claude Code bridge failures and interruption, workflow callbacks, title and compaction truncation, and mutation rejection.

Separate tests verify normal media and optional-field compatibility, failure behavior, and interruption.

These tests do not claim a secret-bearing wire capture for every runtime or a live external-provider audit. Run tests from their package directories; the repository root deliberately refuses test execution.
