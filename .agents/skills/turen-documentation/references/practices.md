# Documentation practices

The writing, verification and consistency rules behind the TurenOS documentation method. SKILL.md decides _where_ a page goes. This file decides _how_ it's written and kept true.

## Writing rules

Documentation must be useful to both people and coding agents.

- **Lead with the answer.** The first sentence states what the page is about and the most important takeaway. No throat-clearing intros.
- **Concrete over abstract.** Use real file paths, commands, function names and config keys. If you say "the vault", also say where it lives (`packages/core/src/secret-vault.ts`).
- **Self-contained sections.** Use clear `##` headings so a reader, or an agent doing keyword search, can land on one section and understand it without reading the whole page.
- **Show, then explain.** Code blocks, command examples and concrete trees beat prose descriptions. Annotate the example briefly and don't pad it.
- **No marketing voice or filler.** Skip "comprehensive", "robust", "seamlessly", "leverage". Write as if briefing an engineer who has ten minutes.
- **Not self-referential.** Don't write about the page itself ("this document explains...", "in this section we will cover..."). Just explain the thing.
- **Not self-congratulatory.** Don't praise the project, design or team. State what it does and how it works.
- **Stay technical.** Cover how components fit together, what to run, inputs and outputs, failure modes, and tradeoffs with their reasons. Skip history, vision and persuasion. Decisions and their history belong in the commit or PR description.
- **Link laterally** with relative paths (`[release signing](../operations/releases/signing.md)`) so the tree stays navigable.
- **Date load-bearing claims.** If a fact is likely to drift (versions, measurements, deadlines, owners), say when it was true: "measured 2026-08-02", "as of 1.0.6".
- **Don't duplicate the code.** Explain _why_ and _how to use_, not what every function does line by line. Link to self-explanatory code instead of paraphrasing it.
- **Diagrams as text.** Prefer Mermaid or ASCII in fenced blocks over binary images: text renders on GitHub, diffs in review and can be read by agents. If an image is unavoidable, keep its editable source beside it in `docs/assets/`.
- **Separate channels.** Docs may name `AGENTS.md` as a concept but never link an agent instruction file or depend on what one says. If a fact matters to both people and agents, it belongs in the docs; the instruction file keeps the rule and links the page. A fact stated only in an `AGENTS.md` is invisible to people.

## Verify every claim against the source

Before writing that a function exists, a flag is supported, a command takes an argument, a file lives at a path, an endpoint returns a shape, or a config key has a default, read the code or run the command and confirm it. Don't document from memory, from a similar project, or from what an API "probably" does. If you can't verify a claim, go verify it or leave it out. Outdated or invented details are worse than missing ones, because readers and agents act on them.

Numbers need the same care: limits, defaults, timeouts and counts come from constants in the source (`MAX_OWNER_ACTIVE = 4`), not from another page.

Check behavioral guarantees separately from API names and links. Follow crash, retry, and side-effect claims through the actual recovery branches; a stable identifier or passing test does not establish idempotency downstream. Read benchmark methods before repeating causal, fairness, or quality claims, and state sample size and estimates beside the numbers.

## Names and layout

- File and folder names are kebab-case (`shell-tool-routing.md`), with `README.md` as the only exception. Names starting with `_` or `.` are treated as site-generator files and skipped.
- `docs/README.md` is the only file at the root of `docs/`. Every other page lives in a section.
- A subfolder with more than one page has a `README.md`, which in TurenOS is the topic's main page and links every sibling page and subfolder.
- Every page is reachable by links from `docs/README.md`. An unlinked page is an orphan, so add it to its section's index.

## Moving or renaming pages

A move breaks every inbound link, not just the ones inside `docs/`. Use the mover (`scripts/move.ts`), which updates relative links, backticked path mentions and Markdown references outside `docs/`. Then run the inbound-link grep from SKILL.md for references the mover can't edit, such as code, scripts and config. Update every hit in the same change.

## Keeping docs true after code changes

Docs rot when code moves and nobody searches. When the task is "update the docs" after a change, or an audit:

1. List what changed: `git diff --name-only <base>...HEAD`, plus renamed or removed symbols, flags, commands and config keys.
2. Search every docs tree for each old path and name (`rg -n '<old>' docs/ tools/ services/catalog/`). Update each hit, or delete the claim if the thing is gone.
3. For an audit, re-verify each page's code-level claims against the source and run the checker. Report stale claims with the current reality ("says `--port`, flag is now `--listen`").

## Auditing for confusion

An audit looks for what would mislead a person or an agent: wrong claims, contradictions, blind spots, and unclear wording. The checker proves structure only; every item below needs reading and a search.

1. **Baseline.** Run `check.ts docs --coverage` and the `turen-context` checker. Treat each coverage note as a blind-spot candidate.
2. **Defaults and toggles, not only constants.** A limit can be right while the page misleads about what a user gets without configuring anything. Find each "falls back to", "defaults to", "asks", "off by default" claim and trace it to the value used at runtime, including stored toggles (the permission `ask` effect resolves to `allow` while _Enforce permission checks_ is off).
3. **Absolute words.** "manual", "not enabled", "not yet wired", "only", "never", "no agent tool": grep for the registration that would falsify it (`tools.register`, a `node` in `location-services.ts`, a scheduler started in `server.ts`, an exported tool map).
4. **Every copy of a shared fact.** For each catalog row, compare it with the system's page and sub-pages; for each count, default, name, or policy table, grep `docs/`, the READMEs and every `AGENTS.md`. Two copies that differ are a finding even if one is right. Keep one copy and link it.
5. **Blind spots.** Anything started when the server boots (schedulers, pollers, background reviewers, downloaded binaries, outbound network calls) needs a page or a catalog row. So does each workspace package and each top-level code folder, and each fact that currently lives only in an `AGENTS.md`.
6. **Split and move residue.** Link text that still names the old file (the checker flags it), "above/below/see below" that now points into another page, a folder README summary that no longer matches the child page's lead, and notes about one subsystem left inside another subsystem's page.
7. **Leftover prompts.** Pages written as instructions for one agent run: grep for `You implement`, `(yours)`, `as stubbed`, `do not edit`, `is NOT installed`. Rewrite them as a procedure for any reader.
8. **Unexplained references.** Internal code names (`source-106`), planning artifacts ("the planning whiteboard"), other products, and names that exist nowhere in the repository. Define them where they first appear or remove them.
9. **History in evergreen pages.** "now", "previously", "originally", release-by-release notes, and PR numbers belong in commits and release notes.

Report in severity order (incorrect claim, contradiction, blind spot, unclear wording). Each finding gives `file:line`, what the page says, what the source shows with its path, and a one-line fix. Fix after the report is reviewed, not during it.

## One docs tree, many entry points

All TurenOS documentation lives in `docs/`. Package and area READMEs (`packages/<pkg>/README.md`, `tools/README.md`, `services/catalog/README.md`) are entry points, `AGENTS.md` files point into `docs/` for detail, and `specs/` holds contracts. The failure mode is those places contradicting each other.

- **A shared fact has one source of truth.** Counts (built-in tools, catalog sources), version pins, identifier tables and supported-format lists get copied into several pages and READMEs, then drift. For each such fact, name its authority, preferably a build or config file or a single `docs/` page. When it changes, grep `docs/`, the READMEs and the `AGENTS.md` files for the old value and update them all in the same change.
- **Link, don't restate.** A README or `AGENTS.md` names the fact and links the `docs/` page instead of copying its explanation.
- **No second docs tree.** Never add a `docs/` folder inside a package or area. If a README grows long-form prose, move that prose into a `docs/` page with `move.ts` and link it.
- A contradiction between two places is a bug even when each one reads fine on its own.
