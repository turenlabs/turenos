---
name: turen-documentation
description: Write, update, move or audit TurenOS documentation by reading the code it describes. Every claim on a page (defaults, limits, flags, paths, behavior, failure modes) comes from the implementing source, its registrations and tests, never from memory or another page. Documentation is centralized in docs/ sections (architecture, systems, providers, operations, development, experimental, assets); READMEs are short entry points, AGENTS.md files point into docs/, contracts stay in specs/, prototypes in mockups/, and the systems catalog indexes every system page. Covers TurenOS branding, where a page goes, page conventions, a code-first audit method for wrong claims, contradictions and undocumented systems, a link checker and a link-preserving page mover. Use it whenever a change adds, edits, moves or reorganizes documentation, documents a system, package or feature, follows a code change that docs describe, or audits the docs.
---

# turen-documentation

TurenOS documentation is written from the code. A page is correct when every claim on it matches what the implementing source does today; nothing else makes it correct, including a passing checker. This skill says where pages live and how to write them, but most of the work is reading code: the source files, the registrations that wire them in, the config schema, the constants, and the tests. It works with any coding agent. Run commands from the repository root; Bun is the only prerequisite.

Read [references/practices.md](references/practices.md) before writing: it holds the writing rules, how to verify each kind of claim, and the audit method. New pages start from [references/templates.md](references/templates.md).

## Read the code, then write

Do this for every page you write or change, and for every claim you touch on an existing page.

1. **Find the implementation.** Locate the entry point, the files that implement the behavior, and where it is registered or started: a tool map, a node in `location-services.ts`, a route group, a scheduler in `server.ts`, a CLI command. Search broadly; a system often has a Session V2 path in `packages/core` and a legacy path in `packages/forge`.
2. **Load it into context.** Read those files, the config schema or flag readers they consume, and their tests. Tests show intended behavior and edge cases the code alone hides.
3. **Take facts from the code.** Defaults, limits, timeouts and counts come from constants and schema defaults. Trace every "defaults to", "off by default" or "asks" to the value used at runtime, including flags and stored toggles. Follow failure, retry and recovery claims through the actual branches.
4. **Check absolute claims.** Before writing "only", "never", "not wired", "manual" or "no agent tool", grep for the registration that would prove it wrong.
5. **Write what the code shows.** Explain what it does, how to use it, and how it fails. Cite the files in `## Source`. If you can't confirm a claim, confirm it or leave it out.
6. **Update every copy.** Grep `docs/`, the READMEs and the `AGENTS.md` files for the same fact (a count, default, name or table) and make them agree, or keep one copy and link it.
7. **Run the checker last.** It catches broken links, missing paths and unindexed pages. It says nothing about whether the page is true.

For a large audit, split the tree into lanes (by section or system) and give each lane to a separate agent that reads the code for its pages and reports findings with `file:line` evidence for both the page and the source. See [Auditing](references/practices.md#auditing).

## Two rules that come before everything else

**Branding.** Prose says **TurenOS** (the product) and **Turen Labs** (the company). Technical identifiers keep their exact compatibility spelling, even when they say `forge`: the `forge` CLI and its commands, `forge.json`, `.forge/` paths, `forge://` links, `FORGE_*` env vars, `packages/forge`, `ForgeHttpApi`, `@turenlabs/*` package names and serialized values. Put identifiers in backticks. Read `docs/architecture/branding.md` before writing a name you're unsure of. Never "fix" an identifier to match the product name; that breaks installs.

**Specs are normative; docs explain.** `specs/` and `packages/<pkg>/specs/` define contracts that code is checked against. Docs link to a spec and explain it; they never move it, restate its normative text, or quietly contradict it. When the code and a spec disagree, document what the code does, say that it differs from the spec, and report the conflict. Don't edit the spec to match.

## Where documentation lives

| Kind                    | Location                                                                                                                                                                                 | Rules                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front door              | `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `NOTICE`                                                                                                                       | Product direction, develop commands, repo map and a short "start with" list linking into `docs/`. Keep them short and link out for depth.                                                                                                                                                                  |
| Documentation           | `docs/<section>/`                                                                                                                                                                        | All prose documentation: how TurenOS systems work, package internals, area guides such as the extension catalog and WASM tool targets, operator procedures, contributor guides, and experimental work. The sections are below.                                                                             |
| Contracts               | `specs/`, `packages/<pkg>/specs/`                                                                                                                                                        | Normative. See the rule above.                                                                                                                                                                                                                                                                             |
| Entry points            | `packages/<pkg>/README.md`, `tools/README.md`, `services/catalog/README.md`                                                                                                              | Short: what the package or area is, its commands, and links into `docs/`. Long-form prose moves to `docs/`; never add a `docs/` folder inside a package or area.                                                                                                                                           |
| Target provenance       | `tools/<target>/README.md`, `PROVENANCE.md`, `VERIFY_WASM.md`                                                                                                                            | Build and provenance records that ship with each WASM target's artifact. They stay with the target.                                                                                                                                                                                                        |
| Inherited upstream docs | READMEs inherited from OpenCode: `packages/http-recorder/README.md` and `packages/forge/src/sync/README.md`                                                                              | Leave them in place and unsplit so they stay comparable with upstream. Every other README is Turen-written and its long-form prose belongs in `docs/`. The fork commit `3a1c6df` is not in this repository's history, so add a README to this list only after comparing it with OpenCode's copy on GitHub. |
| Prototypes              | repo-root `mockups/`                                                                                                                                                                     | HTML/JS mockups. Never in `docs/`.                                                                                                                                                                                                                                                                         |
| Generated               | `Third-Party-Notices.md` (`bun run license:generate`), `packages/*-wasm/dist/README.md`, `packages/extensions/src/generated.ts`                                                          | Never hand-edit. Change the generator or its input.                                                                                                                                                                                                                                                        |
| Not documentation       | Agent instruction files (`AGENTS.md`, `CLAUDE.md`), `.forge/` (runtime config, commands, translation glossaries), other `.agents/` content, `tools/*/vendor/` and imported upstream docs | Leave alone. Docs may name `AGENTS.md` as a concept, always in backticks, but never link one or depend on its contents; the `turen-context` skill maintains them. A fact a person needs belongs in `docs/` even when an `AGENTS.md` also states it as a rule.                                              |

Documentation goes in `docs/` unless a row above says otherwise; a package or area README only gains a link to the new page.

## The `docs/` sections

`docs/` holds `README.md` plus only these sections, in this order. Omit a section until it has content, and never invent new top-level sections. `scripts/check.ts` reads this table, so keep it the single source of truth.

| Section         | Required         | Holds                                                                                                                                                                                                                                                | Does not hold                                                                   |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `architecture/` | yes: `README.md` | Whole-system shape. `README.md` is the architecture overview: package and process topology, runtime and data flow, Location and trust boundaries, persistence, generated artifacts, source map. `branding.md` is the naming and compatibility policy | One system's behavior (systems/)                                                |
| `systems/`      | yes: `README.md` | `README.md` is the **systems catalog**: every system and subsystem with responsibilities, inputs/outputs, owner and failure behavior, and source. Plus one page (or folder) per system that needs more than its catalog row                          | Using a specific model provider (providers/), operator procedures (operations/) |
| `providers/`    | if applicable    | Model providers and the external agent CLIs TurenOS drives (Claude Code, Muse Code, local models): setup, tool routing, limits                                                                                                                       | Provider-resolution internals (systems/, "Model and provider layer")            |
| `operations/`   | if applicable    | Operator procedures for hosting and shipping TurenOS: backends the Desktop drives (`ssh-remote/`, `wsl.md`), headless and persistent servers, and `releases/` (release guide, automation, signing)                                                   | Contributor workflows (`CONTRIBUTING.md`)                                       |
| `development/`  | if applicable    | Contributor guides for changing TurenOS code: testing patterns and fixtures, code conventions, framework patterns                                                                                                                                    | Build, run and release commands (`CONTRIBUTING.md`, operations/)                |
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
7. It describes how a named system behaves, including one package's internals or an area such as the extension catalog. **`systems/`**

## System pages and the catalog

- **Every system page has a catalog row** in `docs/systems/README.md`, and the row's Source cell links the page. A new system adds its row in the same change. The row's defaults and failure behavior must match the page; both come from the code.
- **Anything that runs on its own needs a row**: schedulers, pollers, background reviewers, downloaded binaries and outbound network calls. Readers need to know what TurenOS does without being asked.
- **Name the page after the system** as users and the catalog say it (`memory.md`, `secure-storage.md`). Keep established file names; renames break links for no gain.
- **A system with more than one page gets a folder.** Its `README.md` is the main page and links the rest, for example `systems/automations/README.md` plus `systems/automations/internals.md`.
- **Experimental but shipped** systems (for example `rosetta_exec`) stay in `systems/` and say "experimental" in the lead paragraph.

## Page conventions

Follow these on new pages, and fix old pages when you touch them rather than mass-editing.

- **Title and headings** in sentence case (`# Release guide`, `## Key loading and failure`). Product and feature names keep their capitals.
- **Lead paragraph**: what it is, plus the one constraint the reader must know, in two to four sentences.
- **Links** are `./`-relative within a folder and `../` across sections. Link specs and source files with relative paths (`../../specs/v2/session.md`).
- **Source-grounded.** Cite implementing files as `packages/<pkg>/src/...` paths, and end every system page with `## Source` listing them. The architecture overview keeps `## Source map`.
- **Written for readers, not for one agent run.** A page never addresses a single implementer ("You implement exactly one file", "bun is not installed here"). When a page describes guidance TurenOS gives its own agents, say so ("The default guidance tells the parent to…").
- **Code samples compile.** Put `yield*` examples inside `Effect.gen(function* () { ... })`; Prettier rewrites a bare top-level `yield*` into `yield *`.
- **Standard section names** where they apply, in this order near the end: `## Configuration`, `## Verification`, `## Limits`, `## Source`.
- **Experimental pages** carry `Status: prototype | benchmark | adopted | abandoned, as of YYYY-MM-DD` in their first 12 lines. When a prototype ships, move the shipped behavior into its system page and mark the experimental page `adopted` with a link.
- **One topic per page**: one topic and one kind of content (explanation, how-to, or reference). When a page grows past a few hundred lines and covers several topics, turn it into a folder with `move.ts` (`page.md -> page/README.md`), move sections into sibling pages by hand, leave a one-sentence summary and link for each in the main page, and fix the anchor links the checker then reports. Long single-topic reference pages, like the systems catalog, stay whole.
- **No version numbers in file names.** A page describing capabilities is evergreen and says "as of 1.0.6" where a fact is version-bound.

## Keeping links and indexes in sync

- **Indexes to update with every page change**: `docs/README.md` (one heading per section in table order except `assets/`, then "Contracts and specs" and "Elsewhere in the repo"; its "How these docs are organized" section summarizes this method and stays in step with it), the section's `README.md`, the systems catalog row, and the root `README.md` "Documentation" list if the page is on it.
- **Inbound links from outside `docs/`** break on every move. The mover rewrites Markdown links. This grep finds the rest, skipping `tools/` and `services/`, whose `docs/` links point at their own trees:
  ```bash
  git grep -n -E '(^|[^/A-Za-z0-9_.-]|\.\./)docs/[A-Za-z0-9/_.#-]+' -- ':!docs/' ':!tools/' ':!services/' ':!**/test/**'
  ```
  A Markdown link resolves relative to the file that holds it, as on GitHub, so a nested README writes `../../docs/...`. Code comments often cite a page by bare file name ("per `CONVENTIONS.md`"), which no tool resolves, so also run `git grep -n -F '<file name>'` for each moved page.

## Workflows

**New or changed page.** Place it with "Where documentation lives" and "Where a page goes". Follow "Read the code, then write". Update the indexes and catalog row, and link it from the package or area README if one covers the topic.

**After a code change.** List what changed (`git diff --name-only <base>...HEAD`, plus renamed or removed symbols, flags, commands and config keys). Grep `docs/`, the READMEs and `AGENTS.md` files for each old name and path, re-read the new code, and correct every hit, or delete the claim if the thing is gone.

**Restructure.** Build the full mapping (current path, new path, the rule that places it) and **show it to the user before moving anything**. On a branch with no other uncommitted docs edits, write the moves as `old -> new` lines relative to `docs/` in a scratch file outside the repository, then let the mover do the mechanical part. It prints the plan by default; with `--apply` it moves each file with `git mv` and rewrites relative links inside `docs/`, backticked path mentions, and `docs/` references in Markdown outside it, and lists references in code and config to fix by hand:

```bash
bun .agents/skills/turen-documentation/scripts/move.ts <moves-file>           # plan
bun .agents/skills/turen-documentation/scripts/move.ts <moves-file> --apply   # do it
```

**Audit** (when asked, or after a large restructure). Follow [Auditing](references/practices.md#auditing): read the code behind each page, report findings in severity order with `file:line` for the page and the source and a one-line fix, and fix only after the report is reviewed. Code bugs found along the way go in a separate note, not in the docs change.

**Finish.** Run the checker and fix what it reports:

```bash
bun .agents/skills/turen-documentation/scripts/check.ts docs
```

It proves structure: allowed sections and file names, every link and `#anchor` inside `docs/` resolves, every page is reachable from `docs/README.md` and every system page from the catalog, folder READMEs link their pages, backticked repository paths exist, `docs/` paths cited from Markdown elsewhere resolve, system pages have `## Source`, and experimental pages have a status line. Then re-read each changed page against the branding rule and confirm each edited claim once more against the code.
