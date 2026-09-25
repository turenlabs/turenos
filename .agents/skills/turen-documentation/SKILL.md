---
name: turen-documentation
description: Write, update, move, restructure or audit TurenOS documentation following the repository's documentation method. All documentation is centralized in docs/ sections (architecture, systems, providers, operations, development, experimental, assets); package and area READMEs are short entry points that link there, AGENTS.md files point there for detail, normative contracts stay in specs/, and prototypes go in mockups/. The systems catalog indexes every system page. Enforces TurenOS branding (TurenOS in prose, `forge` identifiers exact), source-grounded pages, short pages, and link hygiene, and ships a checker, a link-preserving page mover, and a section splitter. Use it whenever a change adds, edits, moves or reorganizes documentation, documents a system, package, or feature, or fixes documentation links.
---

# turen-documentation

TurenOS documentation is **centralized** in `docs/`. Package and area READMEs are short entry points that link into it, `AGENTS.md` files point into it for detail, and only a few things live elsewhere: normative contracts in `specs/`, per-target build provenance in `tools/<target>/`, and HTML prototypes in `mockups/`. This skill is the method for keeping it that way, and it works with any coding agent. Run every command from the repository root. The only prerequisite is Bun, which the repository already requires.

Read [references/practices.md](references/practices.md) before writing: it holds the writing rules, claim verification and multi-tree consistency rules this method builds on. For new pages, start from [references/templates.md](references/templates.md).

## Two rules that come before everything else

**Branding.** Prose says **TurenOS** (the product) and **Turen Labs** (the company). Technical identifiers keep their exact compatibility spelling, even when they say `forge`. That covers the `forge` CLI and its commands, `forge.json`, `.forge/` paths, `forge://` links, `FORGE_*` env vars, `packages/forge`, `ForgeHttpApi`, `@turenlabs/*` package names and serialized values. Put identifiers in backticks. Read `docs/architecture/branding.md` before writing any name you're unsure of. Never "fix" an identifier to match the product name; that breaks installs.

**Specs are normative; docs explain.** Everything under `specs/` and `packages/<pkg>/specs/` defines contracts that code is checked against. Docs link to a spec and explain it. They never move it, restate its normative text, or quietly contradict it. If a doc and a spec disagree, the spec wins: report the conflict instead of editing the spec to match the doc.

## Where documentation lives

| Kind                    | Location                                                                                                                                                                                 | Rules                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front door              | `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `NOTICE`                                                                                                                       | Product direction, develop commands, repo map and a short "start with" list linking into `docs/`. Keep them short and link out for depth.                                                                                             |
| Documentation           | `docs/<section>/`                                                                                                                                                                        | All prose documentation: how TurenOS systems work, package internals, area guides such as the extension catalog and WASM tool targets, operator procedures, contributor guides, and experimental work. The sections are below.        |
| Contracts               | `specs/`, `packages/<pkg>/specs/`                                                                                                                                                        | Normative. See the rule above.                                                                                                                                                                                                        |
| Entry points            | `packages/<pkg>/README.md`, `tools/README.md`, `services/catalog/README.md`                                                                                                              | Short: what the package or area is, its commands, and links into `docs/`. Long-form prose moves to `docs/`; never add a `docs/` folder inside a package or area.                                                                      |
| Target provenance       | `tools/<target>/README.md`, `PROVENANCE.md`, `VERIFY_WASM.md`                                                                                                                            | Build and provenance records that ship with each WASM target's artifact. They stay with the target.                                                                                                                                   |
| Inherited upstream docs | READMEs inherited from OpenCode, such as `packages/codemode/README.md`, `packages/http-recorder/README.md` and `packages/forge/src/sync/README.md`                                       | Leave them in place and unsplit so they stay comparable with upstream. To tell whether a README is inherited, diff it against OpenCode at the fork commit `3a1c6df` (see the root `README.md`); Turen-written docs belong in `docs/`. |
| Prototypes              | repo-root `mockups/`                                                                                                                                                                     | HTML/JS mockups. Never in `docs/`.                                                                                                                                                                                                    |
| Generated               | `Third-Party-Notices.md` (`bun run license:generate`), `packages/*-wasm/dist/README.md`, `packages/extensions/src/generated.ts`                                                          | Never hand-edit. Change the generator or its input.                                                                                                                                                                                   |
| Not documentation       | Agent instruction files (`AGENTS.md`, `CLAUDE.md`), `.forge/` (runtime config, commands, translation glossaries), other `.agents/` content, `tools/*/vendor/` and imported upstream docs | Leave alone. Docs never reference agent instruction files; the `turen-context` skill maintains `AGENTS.md`.                                                                                                                           |

Before writing anything, run down this table. Documentation goes in `docs/` unless a row above says otherwise; a package or area README only gains a link to the new page.

## The `docs/` sections

`docs/` holds `README.md` plus only these sections, in this order. Omit a section until it has content, and never invent new top-level sections. `scripts/check.ts` reads this table, so keep it the single source of truth.

| Section         | Required         | Holds                                                                                                                                                                                                                                                | Does not hold                                                                   |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `architecture/` | yes: `README.md` | Whole-system shape. `README.md` is the architecture overview: package and process topology, runtime and data flow, Location and trust boundaries, persistence, generated artifacts, source map. `branding.md` is the naming and compatibility policy | One system's behavior (systems/)                                                |
| `systems/`      | yes: `README.md` | `README.md` is the **systems catalog**: every system and subsystem with responsibilities, inputs/outputs, owner and failure behavior, and source. Plus one page (or folder) per system that needs more than its catalog row                          | Using a specific model provider (providers/), operator procedures (operations/) |
| `providers/`    | if applicable    | Model providers and the external agent CLIs TurenOS drives (Claude Code, Muse Code, local models): setup, tool routing, limits                                                                                                                       | Provider-resolution internals (systems/, "Model and provider layer")            |
| `operations/`   | if applicable    | Operator procedures for running and shipping TurenOS: persistent servers, SSH remote hosts, WSL backends, and `releases/` (release guide, automation, signing)                                                                                       | Contributor workflows (`CONTRIBUTING.md`)                                       |
| `development/`  | if applicable    | Contributor guides for changing TurenOS code: testing patterns and fixtures, code conventions, framework patterns                                                                                                                                    | Build, run and release commands (`CONTRIBUTING.md`, `AGENTS.md`, operations/)   |
| `experimental/` | if applicable    | Prototypes, experiments and benchmarks: work that explores or measures rather than documents how a shipped system behaves, each with a status line                                                                                                   | Experimental but shipped tools (systems/, with the status in the lead)          |
| `assets/`       | if applicable    | Images used by the docs and the root README, with their editable diagram sources (`.excalidraw`, `.tldraw`, `.drawio`) beside them                                                                                                                   | HTML prototypes (`mockups/`), documentation text                                |

`docs/assets/` is a load-bearing path: the root `README.md` logo and `script/generate-icon-reference.ts` use it. Don't move it.

## Where a page goes

Take the **first** rule that matches:

1. It defines a contract that code is checked against. **`specs/`**, not docs.
2. It guides contributors in changing the code: testing patterns and fixtures, code conventions, framework patterns. **`development/`**
3. It's a prototype, experiment or benchmark that explores or measures rather than documenting a shipped system's behavior. **`experimental/`**
4. An operator follows it to host, deploy or release TurenOS. **`operations/`**, and release procedures go in `operations/releases/`.
5. It's about using or routing through one model provider or external agent CLI. **`providers/`**
6. It describes the whole system's shape, or naming policy. **`architecture/`**
7. It describes how a named system behaves, including one package's internals or an area such as the extension catalog. **`systems/`** (see the next section).

## System pages and the catalog

- **Every system page has a catalog row.** The page's system appears in `docs/systems/README.md` with its Source column filled in, and the row's Source cell links the page. A new system means adding the row in the same change.
- **Name the page after the system** as users and the catalog say it (`memory.md`, `secure-storage.md`). Keep established file names when moving pages; renames break links for no gain.
- **A system with more than one page gets a folder.** Its `README.md` is the main page and links the rest, for example `systems/automations/README.md` plus `systems/automations/internals.md`. A folder's `README.md` is the topic's main page, not only an index.
- **Experimental but shipped** systems (for example `rosetta_exec`) stay in `systems/` and say "experimental" in the lead paragraph.

## Page conventions

Follow these on new pages, and fix old pages when you touch them rather than mass-editing.

- **Title** in sentence case (`# Release guide`, `# Background shell jobs`). Product and feature names keep their capitals.
- **Lead paragraph**: what it is, plus the one constraint the reader must know, in two to four sentences.
- **Links** are `./`-relative within a folder and `../` across sections. Link specs and source files with relative paths (`../../specs/v2/session.md`).
- **Source-grounded.** Cite implementing files as `packages/<pkg>/src/...` paths, verify each one exists, and end every system page with `## Source` listing them. The architecture overview keeps `## Source map`.
- **Standard section names** where they apply, in this order near the end: `## Configuration`, `## Verification`, `## Limits`, `## Source`. Use `## Limits`, not "Known limits" or "Current limits".
- **Experimental pages** carry `Status: prototype | benchmark | adopted | abandoned, as of YYYY-MM-DD` near the top. When a prototype ships, move the shipped behavior into its system page and mark the experimental page `adopted` with a link.
- **One topic per page.** Scope each page to one topic and one kind of content: explanation, how-to, or reference. Length is a symptom, not the rule: past 300 lines the checker asks for a review. If the page bundles several topics, split it along its `##` sections: `move.ts` turns `page.md` into `page/README.md`, then `split.ts` moves sections into sibling pages and rewrites every anchor link, and each moved section keeps a one-sentence summary and link in the main page. If it is one reference topic that is long by nature (a catalog, a table, an API listing), keep it and add `<!-- long-page: reference -->` near the top, as the systems catalog does.
- **No version numbers in file names.** Release announcements belong in the GitHub release. A page describing capabilities is an evergreen system page that says "as of 1.0.6".

## Keeping links and indexes in sync

- **Indexes to update with every page change**:
  - `docs/README.md`: one heading per section in table order, then "Contracts and specs" linking `specs/`, then "Elsewhere in the repo" linking `tools/README.md`, `services/catalog/README.md` and the package READMEs. Its "How these docs are organized" section summarizes this method for readers; keep it in step with this file.
  - The section's `README.md`.
  - The systems catalog row.
  - The root `README.md` "Documentation" start-with list, if the page is on it.
- **Inbound links from outside `docs/`** break on every move. The mover rewrites the Markdown ones. This grep finds all of them while skipping external URLs and the `tools/` and `services/` areas, whose `docs/` links point at their own trees:
  ```bash
  git grep -n -E '(^|[^/A-Za-z0-9_.-]|\.\./)docs/[A-Za-z0-9/_.#-]+' -- ':!docs/' ':!tools/' ':!services/' ':!**/test/**'
  ```
  Typical hits are the root `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, package READMEs and scripts that read `docs/assets/`. Prompt text, `.forge/glossary` and test strings also match but aren't links. The checker resolves every `docs/` path and `#anchor` cited from Markdown outside `docs/` (READMEs, `AGENTS.md`, `CONTRIBUTING.md`), skipping fenced examples and `.forge/`, so a rename made without the mover shows up as an error.

## Workflow

1. **Survey.** Run the checker for a baseline. It enforces the tables and conventions above, plus the naming, link, anchor, orphan and index rules from the practices:
   ```bash
   bun .agents/skills/turen-documentation/scripts/check.ts docs
   ```
2. **New page**: run the table in "Where documentation lives", then "Where a page goes". Write it under the practices and the conventions above. Then update the indexes and the catalog row, and link it from the package or area README if one covers the topic.
3. **Restructure.** Build the full mapping (current path, new path, the rule that places it) and **show it to the user before moving anything.**
   1. Do it on a branch with no other uncommitted docs edits.
   2. Write the moves as `old -> new` lines, relative to `docs/`, in a scratch file outside the repository. A target may leave `docs/`, for example `old-mock/index.html -> ../mockups/old-mock.html`.
   3. Let the mover do the mechanical part. It prints the plan by default. With `--apply` it moves each file with `git mv`, so history follows it, and rewrites every relative link inside `docs/`, backticked path mentions, and `docs/` references in Markdown outside it. It also lists references in code and config for you to fix by hand:
      ```bash
      bun .agents/skills/turen-documentation/scripts/move.ts <moves-file>           # plan
      bun .agents/skills/turen-documentation/scripts/move.ts <moves-file> --apply   # do it
      ```
   4. To break up a long page, move it into its own folder first, then split sections out:
      ```bash
      bun .agents/skills/turen-documentation/scripts/split.ts docs/<section>/<page>/README.md \
        --into <file>.md --title "<Title>" --section "<## heading>" [--section ...] [--into ...]   # add --apply
      ```
   5. Write the section READMEs, add missing catalog rows and links, and update `docs/README.md`.
4. **Verify.** Re-run the checker until it reports no errors. Re-read changed pages against the branding rule, and confirm every moved or edited claim against the source or spec.
