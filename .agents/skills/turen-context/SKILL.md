---
name: turen-context
description: Audit, place and maintain the AGENTS.md files that coding agents load while developing TurenOS, and the root CLAUDE.md shim that lets Claude Code read them. Every rule is checked by reading the code it describes (symbols, commands, flags, invariants and "not wired"/"only" claims), and a small checker proves what a script can: load budget, parent pointers, cited paths and scripts, and the CLAUDE.md shim. Covers how Codex, Claude Code, OpenCode and TurenOS load instruction files, what belongs in one, and when an area deserves its own. Use it when adding, editing, splitting or moving any AGENTS.md or CLAUDE.md, when an agent keeps missing a repo convention, when a package gains its own commands or gotchas, or for a periodic audit. Not for docs/ (use turen-documentation), and not for how the TurenOS product loads its users' instruction files.
---

# turen-context

`AGENTS.md` files are instructions for the coding agents (Codex, OpenCode, Claude Code, TurenOS and others) that developers use to build TurenOS. They are harness configuration: loaded into every session, paid for in context, and followed as rules. They are not documentation. `AGENTS.md` is the one format every agent shares, so rules are written only there; the root `CLAUDE.md` exists only to import it. Run commands from the repository root; Bun is the only prerequisite.

A rule an agent follows but the code contradicts does more harm than no rule, so every rule is verified against the code. The default is diagnose, then propose, then edit only after the user approves.

## How agents load AGENTS.md

As of 2026-09-25, from each tool's documentation:

| Agent       | Loads at session start                                                                                   | Loads deeper files                               | Limit                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Codex       | `AGENTS.md` from the root down to the working directory, concatenated, deeper files last                 | never                                            | stops adding files once the chain reaches 32 KiB (`project_doc_max_bytes` default) |
| Claude Code | `CLAUDE.md` (never `AGENTS.md`) in the working directory and every folder above it, plus its `@` imports | `CLAUDE.md` when it reads a file in that subtree | about 200 lines per file for good adherence                                        |
| OpenCode    | `AGENTS.md`, walking up from the working directory; `CLAUDE.md` only as a fallback                       | not documented                                   | none documented                                                                    |

TurenOS's own loaders, inherited from OpenCode, stack every `AGENTS.md` from the working directory up to the project root and read `CLAUDE.md` only where no `AGENTS.md` exists, so the shim never loads twice (`packages/forge/src/session/instruction.ts`, `packages/core/src/instruction-context.ts`). The legacy loader also attaches deeper files when a file is read. If a tool's behavior matters to a decision, re-check its current docs.

What follows:

1. **Rules every change must follow go in the root file.** It's the only file every agent loads wherever a session starts.
2. **A nested file holds only what is true in its subtree and not above it.** Restating the root costs budget twice and lets copies drift. A convention that differs between packages lives in each package's file, never as a root rule one package silently breaks.
3. **Every nested file is named by an ancestor**, normally its parent, with a line like "follow `tools/AGENTS.md` when working in `tools/`". Codex sessions started above the folder and every Claude Code session learn it exists only from that line.
4. **Each root-to-file chain stays under 32 KiB, ideally about 26 KiB.** Past the budget, Codex drops the deepest, most specific instructions.
5. **The root has a `CLAUDE.md` whose only line is `@AGENTS.md`.** Without it Claude Code loads none of the rules. Don't add rules to `CLAUDE.md`, where only Claude Code sees them, and don't add nested shims: rule 3 already reaches nested files.
6. **Wrap `@` mentions in backticks.** Claude Code treats a bare `@path` or `@scope/package` as a file import.

Repository skills live in `.agents/skills/<name>/SKILL.md`, which Codex discovers natively. Other agents reach a skill through a pointer line in the root `AGENTS.md`, so each skill needs one. Vendored `AGENTS.md` files (for example under `tools/*/vendor/`) belong to upstream projects: they load for agents in those folders, but don't grade or edit them.

## What belongs in an AGENTS.md

Keep:

- **Commands agents run repeatedly**: build, test, typecheck, lint, codegen, with the exact string and the folder it runs from, for example: run `bun run generate` from `packages/client`.
- **Conventions the code doesn't show**: "don't extract single-use helpers", "tests run from the package folder, never the root".
- **Gotchas that bit before**: "shells inside another Electron app inherit `ELECTRON_RUN_AS_NODE=1`".
- **Local scope rules**: what is generated, vendored or legacy in this subtree, and how to change it instead.
- **One-line pointers** to the docs page, spec or nested `AGENTS.md` with the detail.

Leave out:

- General programming advice, and anything `ls`, the formatter or the linter already shows.
- Documentation: architecture explanations, "current gaps", design backlogs. Link the `docs/` page instead; if the page doesn't exist, the explanation belongs in `docs/`, not here.
- History ("we switched because...", "formerly", "was removed"). State the current rule.
- Rules tooling can enforce. A lint rule, test or CI check beats a sentence; keep one line saying why the check exists.
- Personal preferences and secrets.

## Verifying a file

Read each file line by line and check every claim against the code, the way the turen-documentation skill checks a page:

- **Symbols, types and APIs**: grep for them and read the definition. A renamed service or helper (`makeRuntime`, `Effect.forkDetach`) makes the rule wrong even if the file still reads well.
- **Commands**: confirm the script exists in the `package.json` of the folder the rule says to run it from, and that the flags it passes still exist.
- **Flags, env vars and config keys**: find where they're read and what their default is.
- **Invariants and "how it works" claims**: read the code path and its tests.
- **"Not yet wired", "only", "never", "all"**: grep for registrations and callers across the repository. "Every module does X" is usually false; say "new modules do X".
- **Pointers**: open the linked docs page or nested file and confirm it still says what the rule relies on.

Prefer fixing a stale claim to deleting it when the rule still applies. Record a code bug found along the way separately; don't encode the bug as a rule.

Then run the checker for what a script can prove:

```bash
bun .agents/skills/turen-context/scripts/check.ts
```

It reports each `AGENTS.md` with its lines, bytes and chain bytes, and flags: chains over or near the 32 KiB budget, files over 200 lines, nested files no ancestor names, bare `@` mentions, backticked paths that don't exist, package-script commands no `package.json` defines (or defines elsewhere), broken links, and a missing or extended root `CLAUDE.md`. Errors mean a file doesn't load or cites something that doesn't exist. Notes are tokens that may not be paths (package names, routes, repo slugs); judge each one.

## Grading a file

Give each graded file a verdict: **keep**, **edit** (list the lines), **split** (move subtree content into a nested file), **consolidate** (merge into the parent and delete), or **delete**.

1. **It loads.** The load rules hold and the chain fits the budget.
2. **Every claim is true**, verified against the code as above.
3. **It's concrete and terse.** Bullets, real paths and commands, no filler. Save `NEVER`/`MUST` for the few rules whose violation is expensive.
4. **It's the only copy.** Each rule lives in the deepest file where it is true; grep the other `AGENTS.md` files for repeats. A contradiction between files is a bug even when both read well.
5. **It fits.** Root under 200 lines; nested files aim for under 80. Use headings such as `## Commands`, `## Conventions` and `## Gotchas`.

## Placing new files

Read the area first: its `package.json` scripts, build setup, generated or vendored code, and recent history (`git log --oneline --since="6 months ago" -- <folder>`, looking for repeated `fix` or `revert` commits). Propose a nested file only when the area has at least one of:

- commands or tooling that differ from the root (its own scripts, a different language, a separate build);
- generated, vendored-adjacent or legacy code with rules for changing it;
- a gotcha that repeated fix or revert commits show agents keep hitting;
- conventions a new agent couldn't derive from the code.

Size and churn alone are not enough. Moving content deeper frees budget in every other chain, but Codex sessions started above the folder then see only the parent's pointer. Move a section down when it applies to one area; keep it in the root when changes elsewhere must obey it.

For each proposal, give the path, a 3 to 6 bullet draft, why the parent can't hold it, the parent pointer line, and the resulting chain size.

## Workflow

1. **Read and verify** each file against the code, then run the checker.
2. **Report** in the format below, and stop. Offer to apply the edits.
3. **After approval**, make targeted edits (never a wholesale rewrite), create approved files with their parent pointer line, and confirm before deleting any file. Re-run the checker until it reports no errors.

## Report format

```
# AGENTS.md audit

## Load problems (<n>)
- <file>: <what doesn't load and for which agent>. Fix: <one line>

## Files (<n> graded, <m> claims checked)

### <path> - <verdict>
- <line>: <what it says> — <what the code shows, path:line>
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
