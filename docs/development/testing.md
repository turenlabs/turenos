# Test selection

Run the affected-package plan from the repository root:

```sh
bun run test:affected
bun packages/script/src/test-affected.ts --json
bun packages/script/src/test-affected.ts --base main --json
bun packages/script/src/test-affected.ts --head HEAD --json
```

`--head` compares committed changes only. It ignores the working tree. If refs are unknown, selection falls back to all test packages.

Add `-- --run` to `bun run test:affected` to opt in to running selected package tests. Do not combine `--run` with `--head`.

The selector maps changed paths to workspace packages and their declared workspace consumers. It cannot detect undeclared imports or provide file-level coverage. A plan does not prove that tests cover changed files or that failures were not missed.

Measure false negatives by comparing selected packages with packages that fail in full-suite runs. Package counts provide selection context, not evidence of time savings.

CI reports an affected-package plan only. It does not run selected tests or change full-suite coverage. Changes confined to `docs/` are ignored by `test.yml` path filters.
