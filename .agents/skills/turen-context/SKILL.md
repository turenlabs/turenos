---
name: turen-context
description: Audit, place and maintain the AGENTS.md files that coding agents load while developing TurenOS, and the root CLAUDE.md shim that lets Claude Code read them. Verifies every path and package script they cite, keeps each directory chain inside Codex's 32 KiB instruction budget, checks that ancestor files point to nested ones, flags stray @mentions and repeated lines, and proposes new AGENTS.md files only where the evidence says an area needs its own rules. Use it when adding, editing, splitting or moving any AGENTS.md or CLAUDE.md, when an agent keeps missing a repo convention, when a package gains its own commands or gotchas, or for a periodic audit. Not for docs/ (use turen-documentation), and not for how the TurenOS product loads its users' instruction files.
---

# turen-context

`AGENTS.md` files are instructions for the coding agents (Codex, OpenCode, Claude Code, TurenOS and others) that developers use to build TurenOS. They are harness configuration: loaded into an agent's context automatically, paid for in every session, and followed as rules. They are not documentation. `AGENTS.md` is the one format every agent shares, so rules are written only there; the root `CLAUDE.md` exists only to import it. Run every command from the repository root; Bun is the only prerequisite.

The default is diagnose, then propose, then edit only after the user approves.

## How agents load AGENTS.md

As of 2026-09-25, from each tool's documentation:

| Agent       | Loads at session start                                                                                   | Loads deeper files                               | Limit                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Codex       | `AGENTS.md` from the root down to the working directory, concatenated, deeper files last                 | never                                            | stops adding files once the chain reaches 32 KiB (`project_doc_max_bytes` default) |
| Claude Code | `CLAUDE.md` (never `AGENTS.md`) in the working directory and every folder above it, plus its `@` imports | `CLAUDE.md` when it reads a file in that subtree | about 200 lines per file for good adherence                                        |
| OpenCode    | `AGENTS.md`, walking up from the working directory; `CLAUDE.md` only as a fallback                       | not documented                                   | none documented                                                                    |

TurenOS's own loaders, inherited from OpenCode, stack every `AGENTS.md` from the working directory up to the project root and read `CLAUDE.md` only where no `AGENTS.md` exists, so the shim below never loads twice (`packages/forge/src/session/instruction.ts`, `packages/core/src/instruction-context.ts`). The legacy loader also attaches deeper files when a file is read. If a tool's behavior matters to a decision, re-check its current docs.

What follows from the table:

1. **Rules every change must follow go in the root file.** It's the only file every agent loads no matter where a session starts.
2. **A nested file holds only what is true in its subtree and not above it.** Restating the root costs each agent's budget twice and lets copies drift into contradictions. A convention that differs between packages (for example, where a module's self-export goes) lives in each package's file, never as a root rule that one package silently breaks.
3. **Every nested file is named by an ancestor file**, normally its parent, with a line like "follow `tools/AGENTS.md` when working in `tools/`". Codex sessions started above the folder and every Claude Code session never load the nested file on their own, so this line is how they learn it exists.
4. **Each root-to-file chain stays under 32 KiB, ideally under about 26 KiB.** Past the budget, Codex drops or cuts the deepest instructions, which are the most specific ones.
5. **The root has a `CLAUDE.md` whose only line is `@AGENTS.md`.** Claude Code reads `CLAUDE.md` and its imports, never `AGENTS.md` directly, so without this shim it loads none of the rules. Don't add rules to `CLAUDE.md`, where only Claude Code would see them, and don't add nested `CLAUDE.md` files: rule 3 already points every agent at nested files. A nested shim, if one is ever needed, also contains only `@AGENTS.md`.
6. **Wrap `@` mentions in backticks.** Claude Code treats a bare `@path` or `@scope/package` as a file import.

Skills follow the same idea. Repository skills live in `.agents/skills/<name>/SKILL.md`, which Codex discovers natively. Every other agent reaches them through a pointer line in the root `AGENTS.md` ("follow `.agents/skills/turen-context/SKILL.md`"), so each skill must have one.

Vendored `AGENTS.md` files (for example under `tools/*/vendor/`) belong to upstream projects. They load for agents working in those folders, but don't grade or edit them.

## What belongs in an AGENTS.md

Keep:

- **Commands agents run repeatedly**: build, test, typecheck, lint, codegen, with the exact string and the folder it runs from, for example: run `bun run generate` from `packages/client`.
- **Conventions the code doesn't show**: "don't extract single-use helpers", "tests run from the package folder, never the root".
- **Gotchas that bit before**: "copying a packaged app's `package.json` over `packages/desktop/package.json` breaks `bun dev`".
- **Local scope rules**: what is generated, vendored or legacy in this subtree, and how to change it instead.
- **One-line pointers** to the docs page, spec or nested `AGENTS.md` that holds the detail.

Leave out:

- General programming advice, and anything `ls`, the formatter or the linter already shows.
- Documentation. Link the `docs/` page instead (the docs never link back, per the turen-documentation skill).
- History and decision records ("we switched in September because..."). State the current rule; the reasons belong in the commit or PR.
- Rules that tooling can enforce. A lint rule, test or CI check beats a sentence an agent may skip. Keep one line saying why the check exists.
- Personal preferences and secrets.

## Grading a file

Apply these to every graded file and give it a verdict: **keep**, **edit** (list the lines), **split** (move subtree content into a nested file), **consolidate** (merge into the parent and delete), or **delete**.

1. **It loads.** The load rules above hold, and the chain fits the budget.
2. **Every claim is true.** `scripts/check.ts` proves paths, package scripts, links and `@` mentions, and warns on lines naming OpenCode (inherited commands and APIs such as `opencode dev web` that TurenOS never shipped). Verify the rest by reading the code: symbol names, flags and env vars (`rg` for them), versions (manifests and lockfiles), and invariants ("the runner reloads projected history before continuing"). Claims that something is "not yet wired", "not enabled" or registered "only" in one place go stale fastest; grep for the registration before keeping them. Prefer fixing a stale claim to deleting it when the rule still applies.
3. **It's concrete and terse.** Bullets over paragraphs, real paths and commands, and no filler. Save emphasis (`NEVER`, `MUST`) for the few rules whose violation is expensive.
4. **It's the only copy.** Each rule lives in the deepest file where it is true. A contradiction between files is a bug even when both read well.
5. **It fits.** Root under 200 lines and inside the budget; nested files aim for under 80 lines. Use headings such as `## Commands`, `## Conventions` and `## Gotchas`, and no table of contents.

## Placing new files

Run `scripts/candidates.ts` for the evidence: each code area's commits, fix/revert commits, languages, script count, and whether it has its own `AGENTS.md` or inherits one. Then read the area. Propose a nested file only when the area has at least one of:

- commands or tooling that differ from the root (its own scripts, a different language, a separate build);
- generated, vendored-adjacent or legacy code with rules for changing it;
- a gotcha that repeated fix or revert commits show agents keep hitting;
- conventions a new agent couldn't derive from the code.

Size and churn alone are not enough. `ls` shows size, and a busy area with no special rules is served by the root.

Moving content deeper is a tradeoff. It frees budget in every other chain, but Codex sessions started above the folder then see only the parent's pointer line. Move a section down when it applies to one area. Keep it in the root when changes elsewhere must obey it.

For each proposal, give the path, a 3 to 6 bullet draft, why the parent can't hold it, the parent pointer line, and the resulting chain size.

## Workflow

1. **Audit.** `bun .agents/skills/turen-context/scripts/check.ts` reports every `AGENTS.md` with its lines, bytes and chain bytes, plus errors, warnings and notes. Errors mean the file doesn't load or cites something that doesn't exist. Warnings need a decision. Notes are tokens that may not be paths at all (package names, routes, repo slugs); judge each one.
2. **Evidence.** `bun .agents/skills/turen-context/scripts/candidates.ts` for placement.
3. **Read and verify by hand** what no script can: the symbols, versions and invariants each file asserts.
4. **Report** in the format below, and stop. Offer to apply the edits.
5. **After approval**, make targeted edits (never a wholesale rewrite), create approved files with their parent pointer line, and confirm before deleting any file. Re-run `check.ts` until it reports no errors.

## Report format

```
# AGENTS.md audit

## Load problems (<n>)
- <file>: <what doesn't load and for which agent>. Fix: <one line>

## Files (<n> graded, <m> claims checked)

### <path> - <verdict>
- <finding, with the line and the current reality>
- Suggested change: <one line>

## Proposed files (<n>)

### <path>
Why: <what the parent can't hold>
Parent pointer: "<line to add>"
Chain after: <bytes> B
Draft:
- <bullet>

## Across files
- <repeats, contradictions, missing parent pointers>

## Next step
<"Apply these edits?" / "Create the proposed files?">
```

Keep the report terse. A file with no findings gets one line: "keep: no issues".
