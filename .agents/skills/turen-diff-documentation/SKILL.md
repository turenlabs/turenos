---
name: turen-diff-documentation
description: Checks TurenOS documentation against one branch or pull request diff. A script maps the diff to the Markdown it can make wrong (docs/ pages, specs, READMEs and AGENTS.md files that cite a changed, deleted or renamed file, or name an env var, CLI option, export or constant the diff removed or changed) and lists new env vars and CLI options nothing documents; the agent then reads the diff for behavior changes no name reveals and verifies each affected page, and every docs edit in the diff, against the new code. Use it before opening or merging a PR, when reviewing someone else's PR, or when asked whether a change needs docs. Writing and placing the fixes follows turen-documentation; AGENTS.md fixes follow turen-context.
---

# turen-diff-documentation

A pull request is done when the documentation says what its code does. This skill checks one diff for three things: docs the change made wrong, behavior it added that nothing documents, and docs it edits that the code doesn't support. It works with any coding agent. Run commands from the repository root; Bun is the only prerequisite.

How to write a page, where it goes, and how to verify a claim come from [turen-documentation](../turen-documentation/SKILL.md) and its [practices](../turen-documentation/references/practices.md). This skill decides _which_ claims a diff puts at risk.

Copy this checklist into your notes and tick it off as you go:

```
- [ ] 1. Map the diff with affected.ts
- [ ] 2. List the diff's behavior changes, each with path:line
- [ ] 3. Verify every affected page against the new code
- [ ] 4. Report the findings, then fix them (or post them as review comments)
- [ ] 5. affected.ts reports no stale references, and both checkers pass
```

## 1. Map the diff

```bash
bun .agents/skills/turen-diff-documentation/scripts/affected.ts                      # this branch vs origin/main, including uncommitted and new files
bun .agents/skills/turen-diff-documentation/scripts/affected.ts <base>               # against another base branch
bun .agents/skills/turen-diff-documentation/scripts/affected.ts --head <rev>         # a commit or branch that isn't checked out
```

The diff runs from the merge base, so commits that landed on the base after the branch point don't count. Fetch the base first. To check a GitHub pull request without checking it out, run `git fetch origin pull/<number>/head:pr-<number>` and pass `--head pr-<number>`. If the base has moved or renamed docs since the branch point, merge it first; the map reads the docs as they are at the head of the diff.

The script reads git only and prints:

| Section                       | Meaning                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale references              | Markdown citing a file or folder the diff deleted or renamed, or naming an env var, CLI option, export or upper-case constant the diff removed from all code. Wrong today. The script exits 1 while any remain. |
| Pages citing changed code     | Pages whose cited source files changed, with each changed constant. Any claim near the citation may now be wrong.                                                                                               |
| Changed constants             | Old and new values. Pages usually state the value (`5 minutes`, `16 MiB`), not the name, so search for the old value too.                                                                                       |
| New env vars and CLI options  | Names the diff introduced that no Markdown mentions.                                                                                                                                                            |
| Markdown changed in this diff | Every docs, spec, README and `AGENTS.md` edit in the diff. Each edited claim needs the same verification as old text.                                                                                           |

It searches all tracked and new Markdown except vendored trees and generated notices. It skips tests, lockfiles and generated code when collecting names, so it misses names those files introduce.

Exit code 2 means the script couldn't read the diff: not a git repository, an unknown base or `--head`, or no shared history. It prints the git error instead of an empty report.

## 2. Read the diff for behavior

The map finds references. It can't see a behavior change that renames nothing. Read the source diff (`git diff <merge base>`, using the merge base the script prints, or `<merge base> <rev>` with `--head`) and list each observable change in one line with its `path:line`:

- a default, limit, timeout, retry count or ordering that changed;
- a new or changed failure branch, error message, fallback or recovery;
- a permission, approval, authentication or trust decision;
- a registration: an agent tool, route, CLI command, config key, setting or Desktop UI path;
- anything that now runs by itself, downloads something or opens a network connection (each needs a systems catalog row);
- a removal or rename the map didn't catch, such as a config key or a tool name in a string.

A refactor with no observable change needs no docs. For each listed change, find where a reader would look: grep `docs/`, the READMEs and the `AGENTS.md` files for the concept words, the old value and the identifiers, and read the systems catalog row of the system it belongs to (`docs/systems/README.md`).

## 3. Verify each affected page

For every page from steps 1 and 2, read the claims around each citation and check them against the code at the head of the diff, using the [verification table](../turen-documentation/references/practices.md#verifying-claims). Check every copy of a shared fact: the page, its catalog row, the READMEs and the `AGENTS.md` files must agree.

Give Markdown the diff itself edits the same reading. New text is as likely to be wrong as old text, and agreeing with the PR description is not verification.

## 4. Report, then fix

List findings in this order, each with the page's `file:line`, what it says, what the code shows (`path:line`), and a one-line fix:

1. **Stale**: cites or names something the diff removed or renamed.
2. **Wrong**: a claim the diff made untrue, or a docs edit the code doesn't support.
3. **Missing**: new behavior from step 2 with no page, catalog row or mention.
4. **Unclear**: wording a reader would now misapply.

On your own branch, fix them in the same change, following turen-documentation for pages and turen-context for `AGENTS.md` files. On someone else's pull request, post them as review comments instead of pushing to their branch. If nothing needs changing, say so and name what you checked.

## 5. Finish

Re-run the map until it reports no stale references, then run both checkers:

```bash
bun .agents/skills/turen-documentation/scripts/check.ts docs
bun .agents/skills/turen-context/scripts/check.ts
```

They prove links, paths and indexes. Only step 3 proves the pages are true.
