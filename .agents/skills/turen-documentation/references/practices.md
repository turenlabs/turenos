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
- **Separate channels.** Docs never reference agent instruction files (`AGENTS.md`, `CLAUDE.md`). If a fact matters to both people and agents, it belongs in the docs. Harness instructions stay in the instruction files, with no cross-links.

## Verify every claim against the source

Before writing that a function exists, a flag is supported, a command takes an argument, a file lives at a path, an endpoint returns a shape, or a config key has a default, read the code or run the command and confirm it. Don't document from memory, from a similar project, or from what an API "probably" does. If you can't verify a claim, go verify it or leave it out. Outdated or invented details are worse than missing ones, because readers and agents act on them.

Numbers need the same care: limits, defaults, timeouts and counts come from constants in the source (`MAX_OWNER_ACTIVE = 4`), not from another page.

## Names and layout

- File and folder names are kebab-case (`shell-tool-routing.md`), with `README.md` as the only exception. Names starting with `_` or `.` are treated as site-generator files and skipped.
- `docs/README.md` is the only file at the root of `docs/`. Every other page lives in a section.
- A subfolder with more than one page has a `README.md`, which in TurenOS is the topic's main page and links its siblings.
- Every page is reachable by links from `docs/README.md`. An unlinked page is an orphan, so add it to its section's index.

## Moving or renaming pages

A move breaks every inbound link, not just the ones inside `docs/`. Use the mover (`scripts/move.ts`), which updates relative links, backticked path mentions and Markdown references outside `docs/`. Then run the inbound-link grep from SKILL.md for references the mover can't edit, such as code, scripts and config. Update every hit in the same change.

## Keeping docs true after code changes

Docs rot when code moves and nobody searches. When the task is "update the docs" after a change, or an audit:

1. List what changed: `git diff --name-only <base>...HEAD`, plus renamed or removed symbols, flags, commands and config keys.
2. Search every docs tree for each old path and name (`rg -n '<old>' docs/ tools/ services/catalog/`). Update each hit, or delete the claim if the thing is gone.
3. For an audit, re-verify each page's code-level claims against the source and run the checker. Report stale claims with the current reality ("says `--port`, flag is now `--listen`").

## Consistency across docs trees

TurenOS has several documentation trees: `docs/`, `tools/` (`README.md`, `docs/targets.md` and per-target READMEs), `services/catalog/` (`README.md`, `docs/`), the package READMEs and `specs/`. Each is fine on its own. The failure mode is the set contradicting itself.

- **A shared fact has one source of truth.** Counts (built-in tools, catalog sources), version pins, identifier tables and supported-format lists get copied into several pages and then drift. For each such fact, name its authority, preferably a build or config file or a single catalogue page. When it changes, grep every tree and instruction file for the old value and update them all in the same change.
- **Link, don't restate.** `docs/README.md` links each area's own docs once, under "Elsewhere in the repo", and points at the authority for shared facts instead of re-deriving them.
- A contradiction between two docs is a bug even when each page reads fine on its own.
