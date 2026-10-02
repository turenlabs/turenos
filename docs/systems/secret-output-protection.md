# Secret output protection

TurenOS masks supported credentials in tool-result text and JSON before ordinary output retention and model submission. This lets an agent investigate configuration files, incident logs, and repositories without routinely copying recognizable credentials into its transcript. It is a disclosure safeguard, not a sandbox or a comprehensive DLP system.

## What changes

Matched values become references such as `[SECRET:v1:github:<fingerprint>]`. Repeated occurrences remain correlatable under the same vault key without exposing the value. Fingerprints are keyed and domain-separated; they are not plain hashes of credentials. Changing the installation vault key changes references. Without persistent vault configuration, the existing ephemeral vault behavior limits stability to that process.

Protection is enabled by default. There is no model-accessible reveal command, broad off switch, or retained raw copy created by this feature. Original source files are not rewritten.

Built-in edit, write, patch, and agent shell inputs containing a reference are rejected, with a tool error, before anything executes. This prevents accidentally replacing a source credential with masked text. The check is deliberately literal: any input containing `[SECRET:v1` is refused, including a reference cut short by a preview and a search such as `rg '\[SECRET:v1'`. To search for references, leave out the leading bracket (`rg -F 'SECRET:v1:'`). Input the check cannot inspect (not plain data, too deep, or too large) is refused the same way. This guard does not validate arbitrary truncated source text or cover every possible mutation channel.

## Covered boundaries

- Core tool settlement: structured values, textual content, error strings, and interceptor annotations. Output is protected before managed overflow retention and durable settlement storage; cached settlements are protected when returned.
- Core error text: tool failures, Claude Code bridge failures, tool and goal cleanup, provider stream failures and unstarted-turn failures are protected on the complete original message before the diagnostic formatter rewrites paths and known key shapes or caps the length. Formatting first could hide part of a configured value from the guard, or cut a credential before the guard saw it. References survive formatting, and the length cap never splits one.
- Managed text overflow: the joined text is checked again before storage because concatenating individually safe fragments can reconstruct a credential. Attachments keep their position when that recheck changes the text.
- Shell jobs and Core direct shell: captured output and failure text are protected before the independent job storage or the durable `shell` message, and before the byte cap. The command line the user typed is stored as entered.
- Legacy Forge tools: final local, broker, and MCP text/metadata, streamed metadata, shared truncation files, and running/completed/error tool-part persistence. Direct shell completion returns the protected persisted part. A shell command's live previews, its saved output file and its final tail all come from one protector that sees the output as it arrives, so none of them can publish a credential that is still arriving or cut one before it is masked.
- Model requests: conversational text and tool-result text/JSON are checked before the normal Core and Forge request paths, including Core title and compaction requests. This also protects supported values in older tool results when they are sent again; it does not rewrite their historical storage. A steer handed to a running Claude Code CLI is protected with the turn's snapshot before it is written to the CLI's stdin. If protection is unavailable or cannot process a steer, it is not offered, and it promotes at the next provider-turn boundary, whose request is protected part by part.
- Provider retries: the durable retry diagnostic (message, response headers and body, metadata) is protected before it is published and projected into the Session's retry status. If protection is unavailable or fails, the diagnostic becomes fixed text with only the status code and retryability.
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

A snapshot belongs to one operation and is released with it. An operation is a provider turn in the Core runner, one tool settlement, one legacy Forge processing step, or one shell, title, compaction, persistence, or workflow callback. Nothing is cached across operations in a process-global raw-secret registry, and a failed acquisition is not remembered. The tool callback installed on a cached GitLab workflow model holds only a way to acquire protection, so no request's snapshot stays reachable through the cached model. A credential stored or rotated while an operation is running is recognized from the next operation. Arbitrary environment variables are not enumerated.

## Bounds and failure behavior

Work is bounded:

- Text and JSON processing has a 16 MiB byte budget, and JSON traversal is limited to depth 64 and 100,000 nodes.
- Snapshots accept at most 256 eligible values totaling 64 KiB. Credential acquisition also has enumeration limits and a five-second timeout.
- A configured value longer than 64 KiB, or more eligible values than the snapshot budget allows, makes protection unavailable rather than silently incomplete.

Protection fails closed: the original text is never used in place of text the guard could not process. Failure is scoped so that it does not wedge the Session:

- Provider requests: history is re-sent every turn, so each part is protected independently. A stored part the guard cannot process (written by an older build, deeper than the walk allows, or over the byte budget) is replaced by `[Content withheld: secret redaction failed]`, and the rest of the request proceeds. Parts the guard leaves unchanged are kept as the same objects, and a request with nothing to protect is passed on as built rather than copied. If no snapshot can be acquired, the turn ends with a visible step failure before any provider request is made.
- Tool settlement: without a snapshot, the tool is not executed and the call settles with an error. Output that cannot be protected settles as a fixed "withheld" error.
- Durable tool records: every tool call still receives a terminal event. A result that cannot be protected is stored as a fixed failure. Cleanup and step failures use fixed text when protection is unavailable.
- Compaction declines with `protectionUnavailable` and sends nothing. Title generation is skipped and the Session keeps its placeholder name.
- Shell output that cannot be protected is replaced by a fixed notice without stranding completion. Streamed shell output is released as soon as it is decided, and only the suffix that later output could still turn into a finding is held back:
  - an open run of token characters that could still become a detected format (such as `gh` or `AKIA…`), up to the longest one;
  - a partial private key header or an unclosed reference;
  - the start of a configured value;
  - an unterminated private key block, which is held until it closes.

  Ordinary output therefore still previews live, including a prompt or progress word with no newline yet. A held suffix appears once more output decides it or the command ends. Releases never split a UTF-16 surrogate pair, so each separately written piece of the saved file is valid UTF-8. Past 16 MiB of held output, the rest of the stream is withheld.

- Legacy Forge persistence: during an outage, new tool text is withheld, while text already stored for a part is kept. Re-saving a historical part, such as a compaction mark, never destroys it. The incoming state is read only through its own data properties and compared without invoking accessors, `toJSON` hooks or proxy traps; a field that matches is written from the stored copy, never from the incoming object. The part's own provider metadata (signatures, item IDs) is opaque and left byte-for-byte intact. Display metadata is normalized the way its persisted JSON would be: dates become ISO strings, non-finite numbers become `null`, and plain class instances become their own data fields. Accessors, `toJSON` hooks and proxies are never invoked or read through; only a node the walk refuses to read is withheld.
- Workflow callbacks: without a snapshot, the callback does not run and the service receives an ordinary tool error.

Cancellation remains cancellation. An interrupted Claude Code bridge call is still settled as interrupted in the durable transcript.

## Limits

Do not treat an unmasked result as proof that it contains no sensitive information.

- Unknown formats, arbitrary passwords, short or low-variety configured values, PII, entropy-based discovery, encoded secrets, OCR, images, and binary artifacts are not generally detected.
- Streaming can conservatively mask more than one-shot detection. Once preceding text has been released, a later token-shaped chunk can match without its original left context, even when the combined identifier would not match. This accepted trade-off can change output depending on chunk boundaries; streamed and one-shot output are not guaranteed to be identical.
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
- Forge shell previews through real Session event history, final tails and separately written UTF-8 releases;
- configured opaque credentials, including the eligibility policy and overlapping or composite values;
- composite configured values and long messages in tool, bridge and cleanup errors, checked in returned results and durable execution and event records;
- legacy post-hook output and persistence, including metadata compatibility, a transient outage over historical parts, and hook counters that must stay at zero during an outage;
- provider-hosted publication, cleanup and snapshot outages, and a legacy history record the guard cannot process;
- Claude Code bridge failures and interruption, workflow callbacks and their per-call protection, title and compaction truncation, and mutation rejection;
- provider retry diagnostics in the durable event and the projected retry status, and live Claude Code steers as delivered to the CLI, each including the fail-closed case.

Separate tests verify normal media and optional-field compatibility, failure behavior, and interruption.

These tests do not claim a secret-bearing wire capture for every runtime or a live external-provider audit. Run tests from their package directories; the repository root deliberately refuses test execution.

## Source

- [`packages/core/src/secret-redaction.ts`](../../packages/core/src/secret-redaction.ts): detectors, references, budgets, and the mutation check.
- [`packages/core/src/secret-output.ts`](../../packages/core/src/secret-output.ts): per-operation snapshots of configured credentials.
- [`packages/core/src/tool/registry.ts`](../../packages/core/src/tool/registry.ts) and [`packages/core/src/tool-output-store.ts`](../../packages/core/src/tool-output-store.ts): tool settlement and overflow retention.
- [`packages/core/src/session/disclosure.ts`](../../packages/core/src/session/disclosure.ts) and [`packages/core/src/session/runner/llm.ts`](../../packages/core/src/session/runner/llm.ts): model requests.
- [`packages/core/src/shell-job.ts`](../../packages/core/src/shell-job.ts) and [`packages/core/src/session/shell.ts`](../../packages/core/src/session/shell.ts): shell jobs and direct shell.
- [`packages/forge/src/tool/secret-output.ts`](../../packages/forge/src/tool/secret-output.ts), [`packages/forge/src/session/disclosure.ts`](../../packages/forge/src/session/disclosure.ts), and [`packages/forge/src/tool/shell.ts`](../../packages/forge/src/tool/shell.ts): the legacy Forge paths.
- [`specs/secret-output-guard.md`](../../specs/secret-output-guard.md): the design contract.
