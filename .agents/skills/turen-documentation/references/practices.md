# Documentation practices

How TurenOS pages are written, verified against the code, and audited. SKILL.md decides _where_ a page goes; this file decides _how_ it's written and kept true.

## Writing rules

Documentation must be useful to both people and coding agents.

- **Lead with the answer.** The first sentence states what the page is about and the most important takeaway.
- **Concrete over abstract.** Use real file paths, commands, function names and config keys. If you say "the vault", also say where it lives (`packages/core/src/secret-vault.ts`).
- **Self-contained sections.** Clear `##` headings let a reader, or an agent doing keyword search, land on one section and understand it.
- **Show, then explain.** Code blocks, commands and concrete trees beat prose descriptions.
- **No marketing voice, filler or self-reference.** Skip "comprehensive", "robust", "seamlessly", "this document explains". Don't praise the project. Write as if briefing an engineer who has ten minutes.
- **Stay technical and current.** Cover how components fit together, what to run, inputs and outputs, failure modes, and tradeoffs with their reasons. History ("now", "previously", "formerly", PR numbers) belongs in commits and release notes.
- **Date load-bearing claims** that drift (versions, measurements, owners): "measured 2026-08-02", "as of 1.0.6".
- **Explain, don't transcribe.** Say why and how to use something, and what happens when it fails. Link self-explanatory code instead of paraphrasing it line by line.
- **Diagrams as text.** Prefer Mermaid or ASCII in fenced blocks. If an image is unavoidable, keep its editable source beside it in `docs/assets/`.
- **Separate channels.** Docs may name `AGENTS.md` as a concept but never link one or depend on it. A fact people need belongs in the docs even when an `AGENTS.md` states it as a rule.

## Verifying claims

Every claim comes from reading the code or running the command. Don't write from memory, from a similar project, from another page, or from what an API "probably" does. An invented or stale detail is worse than a missing one, because readers and agents act on it. What to read depends on the claim:

| Claim                                   | Where the truth is                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A limit, timeout, count or size         | The constant in the source (`MAX_OWNER_ACTIVE = 4`). For an external artifact, its pinned metadata.                                                                                                                                 |
| A default, or "on/off by default"       | The value used at runtime: schema defaults, the flag reader (TurenOS has two, `packages/core/src/flag/flag.ts` and `packages/forge/src/effect/runtime-flags.ts`, with different defaults), and any stored toggle that overrides it. |
| A config key or env var                 | The config schema and every place that reads it. A key that is parsed but never read is not a feature.                                                                                                                              |
| A tool, route or command exists         | Its registration (tool map, `location-services.ts` node, route group, CLI command), not just the file that defines it. Defined but unregistered code does nothing.                                                                  |
| "only", "never", "not wired", "manual"  | A repository-wide grep for the registration or caller that would prove it wrong.                                                                                                                                                    |
| Failure, retry, recovery or idempotency | The actual error and recovery branches. A stable ID or passing test does not prove a downstream effect happens once.                                                                                                                |
| A UI path ("Settings > …")              | The settings components and their gating conditions (for example, dev-channel-only pages).                                                                                                                                          |
| A workflow, release or CI behavior      | The workflow file and scripts it runs. If the real workflow lives somewhere this checkout can't see, say that the page describes the checked-in copy.                                                                               |
| A benchmark result or causal claim      | The benchmark code and raw results. State the sample size, which run each number came from, and what changed between runs.                                                                                                          |
| Data rights or third-party terms        | The provider's current primary terms. Public access or a code licence is not a data licence.                                                                                                                                        |

If a claim can't be confirmed, confirm it or leave it out. If the code looks wrong, document what it does and record the bug separately; don't describe the intended behavior as if it shipped.

## Names and layout

- File and folder names are kebab-case (`shell-tool-routing.md`), with `README.md` as the only exception. Names starting with `_` or `.` are skipped as site-generator files.
- `docs/README.md` is the only file at the root of `docs/`.
- A subfolder with more than one page has a `README.md` that is the topic's main page and links every sibling page and subfolder.
- Every page is reachable by links from `docs/README.md`.

## Auditing

An audit finds what would mislead a person or an agent: wrong claims, contradictions, blind spots and unclear wording. It is code reading, not a checker run.

1. **Split the work.** Divide the tree into lanes (architecture, each group of systems pages, operations and providers, development and experimental, the `AGENTS.md` files, and a blind-spot lane). Give each lane to its own agent when several can run in parallel. Each lane reads its pages, then the code behind every claim.
2. **Verify each claim** with the table above. Numbers, defaults, absolute words and failure behavior go stale fastest; check those first.
3. **Compare every copy of a shared fact.** For each catalog row, compare it with the system's page and sub-pages. For each count, default, name or policy table, grep `docs/`, the READMEs and every `AGENTS.md`. Two copies that differ are a finding even if one is right.
4. **Hunt blind spots from the code outward.** List what starts when the server boots or the Desktop launches (schedulers, pollers, background agents, downloaded binaries, outbound network calls), every registered agent tool, every config key and env var, and every workspace package. Anything with no page or catalog row is a finding. So is any fact that lives only in an `AGENTS.md`.
5. **Look for residue.** Link text naming an old file, "see below" pointing into another page, folder READMEs whose summaries no longer match the child page, pages written as instructions for one agent run ("You implement", "as stubbed"), unexplained internal names (`source-106`), and history wording.
6. **Report before editing.** Severity order: incorrect claim, contradiction, blind spot, unclear wording. Each finding gives `file:line`, what the page says, what the source shows with its `path:line`, and a one-line fix. Fix after the report is reviewed. Keep code bugs found along the way in a separate list for code changes.
7. **Re-verify the fixes.** New text can be wrong too. Have a second reader check the rewritten claims against the code before finishing.

## One docs tree, many entry points

All documentation lives in `docs/`. Package and area READMEs are entry points, `AGENTS.md` files point into `docs/`, and `specs/` holds contracts. The failure mode is those places contradicting each other.

- **A shared fact has one source of truth**, preferably the code or a single `docs/` page. When it changes, grep `docs/`, the READMEs and the `AGENTS.md` files for the old value and update them in the same change.
- **Link, don't restate.** A README or `AGENTS.md` names the fact and links the `docs/` page.
- **No second docs tree.** Never add a `docs/` folder inside a package or area; move long README prose into `docs/` with `move.ts`.
