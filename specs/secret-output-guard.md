# Secret-safe tool output

## Problem

TurenOS is an agent harness. An adapter can hide a credential in its own report while a follow-up file read or shell command discloses the same value to model context and ordinary durable output storage. Protection must follow the data, not the tool name.

## Decisions

| Decision  | First implementation                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope     | High-confidence credential formats in tool-result text and JSON, plus explicitly registered known values where lifecycle ownership is available     |
| Known     | Configured values count only when specific enough to mask anywhere: ≥ 12 characters, ≥ 6 distinct characters, not a documented placeholder          |
| Matching  | Locate every finding on the original text, then replace overlapping findings as one union reference                                                 |
| Identity  | Versioned, domain-separated keyed fingerprints derived from the installation's SecretVault key; never plain hashes                                  |
| Default   | Enabled; no model-accessible unmask operation or broad off switch                                                                                   |
| Failure   | Withhold unprocessable output with a fixed diagnostic; never fall back to raw output; scope the failure so it never wedges a Session                |
| Retention | Sanitize before ordinary output retention; do not retain originals for local reveal                                                                 |
| Editing   | Reject masked references in built-in mutation inputs rather than writing placeholders back to source                                                |
| Lifetime  | One compiled snapshot per operation (provider turn, tool settlement, processing step, callback); no cross-operation raw-secret cache                |
| Rollout   | Exercise Core settlement, overflow, shell-job persistence and provider request paths; document legacy and external execution limitations explicitly |

The user approved planning and implementation of the proposal. These bounded defaults follow the recommendation discussed before implementation.

## Non-goals

- Comprehensive DLP, entropy-based discovery, PII classification, OCR, arbitrary binary or encoded-secret detection.
- A containment boundary against malicious plugins, arbitrary shell network traffic, or intentional encoding/exfiltration.
- Rewriting historical event logs, source repositories, or pre-existing output files.
- Retaining raw originals or offering an unmask UI.
- Changing provider authentication headers; credentials are still used by the authenticated transport.
- Reintroducing findings, reporting, or pentest orchestration domains.

## Architecture

1. A shared Core redactor transforms text and JSON using bounded format detectors and an operation's configured values, compiled once per snapshot. SecretVault supplies a domain-separated fingerprint without exposing the root key. A lenient JSON-compatible walk serves legacy display metadata, and a stream boundary lets appended output be released without splitting a finding.
2. Core registry sanitizes tool output before ToolOutputStore can create overflow files, reusing the settlement's snapshot for bounding. Settlement is checked again after plugin notes and before durable execution retention; cached settlements are sanitized on return.
3. ShellJob and Core direct shell sanitize captured output before their durable writes and before their own output truncation. This is separate from registry settlement.
4. Input placeholders, and input the check cannot inspect, are rejected before built-in file mutation and shell execution with a tool error. This prevents accidental round-trip corruption, not deliberate encoding or alternate mutation channels.
5. Provider and legacy paths are traced independently; a registry hook is not assumed to cover them. The Core runner guards each request part independently, and its publisher settles every call even when protection fails. Derived text (titles, compaction prompts and checkpoints) is protected before truncation. Request tests capture synthetic tool output without contacting external providers.

## Data model

No new findings database or raw-secret store. Model-visible references have the shape `[SECRET:v1:<rule>:<keyed-fingerprint>]`. References preserve correlation under the same installation key. A vault-key change changes references. Originals are neither recoverable from references nor retained by this feature.

## Security properties

- Supported complete credential patterns are masked before the newly covered retention and disclosure paths.
- AWS access-key identifiers are identified as identifiers, not claimed to be complete credentials.
- Unknown formats, encoded data, images, producer-truncated fragments and historical records require explicit limitations; absence of a match proves nothing about sensitivity.
- Redaction does not alter input source files. Tool error messages and post-execution annotations need the same protection as successful output.
- Failures must not embed original values in diagnostics.
- Tests use only fabricated credentials and isolated storage.

## Rollout order and verification

1. Write failing registry/output and redactor regressions.
2. Implement shared redaction and stable identity.
3. Integrate output/storage paths and reject accidental placeholder writes.
4. Exercise real persistence and provider serialization with synthetic credentials; cover repeated observations, overflow, failure, and normal output.
5. Run package typechecks, focused regression suites and independent review. Record unverified paths and limitations in user-facing documentation.

## Audit outcomes

- Provider-hosted execution cannot be intercepted before initial upstream disclosure. Its local results are guarded before publication; CLI/workflow callback returns are guarded independently.
- Legacy truncation and tool-part persistence need separate guards from Core settlement. These are covered; arbitrary custom stores, binary artifact writes, and raw arguments remain outside this feature's retention guarantee.
- Known-value acquisition uses bounded, operation-local snapshots of provider credentials and declared extension secret fields. No global raw list or environment-wide scan is introduced; rotation/deletion applies to subsequent snapshots.
- Independent review found, and regression tests now pin, these defects in the first implementation:
  - one unprocessable historical part failed every later provider request;
  - a protection failure left durable tool calls unsettled, and a protection outage ended a turn with no terminal event;
  - applying detectors in sequence leaked part of a configured value that embedded a detected token, or that overlapped another value;
  - placeholder keys masked ordinary words;
  - titles and compaction truncated text before protecting it;
  - Core direct shell stored raw output, and legacy shell appended raw output to its saved file;
  - a transient outage overwrote stored legacy tool text, and opaque provider metadata was rewritten;
  - Claude Code bridge failures lost their diagnostic, and an interrupted bridge call was never settled.
- The literal `[SECRET:v1` mutation check also refuses searches for references. That false positive is kept deliberately: the check cannot tell a search pattern from a truncated reference copied into a command, and the workaround (omit the bracket) is documented.

See `docs/secret-output-protection.md` for the implemented boundaries and explicit limitations. Integration tests exercise synthetic secrets through real retention and provider-request paths; they are not a universal DLP or containment guarantee.
