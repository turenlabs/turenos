# turen-text-diff-wasm

Bounded line differencing for Turen agent tools: added and removed line counts
plus a unified patch between two byte strings, built on the
[similar](https://github.com/mitsuhiko/similar) crate's Myers diff and compiled
to `wasm32-unknown-unknown` with `wasm-bindgen`.

The patch is byte-compatible with the `diff` npm package's
`createTwoFilesPatch`, the format the edit tools and the review tab already
consume: an `Index:` line when both names match, a 67-character `=` rule,
`---`/`+++` names, hunks whose counts are always printed, removals before
additions, and `\ No newline at end of file` after a final line that lacks one.
Every operation is deterministic and offline: no filesystem, network,
environment, clock, or subprocess access is exposed.

## API

### `diff_text(before, after, options_json) -> string`

`before` and `after` are `Uint8Array`s. `options_json` is optional:

```json
{
  "oldName": "string, default \"a\"",
  "newName": "string, default \"b\"",
  "context": "number, default 4, clamped to 0..64",
  "patch":   "bool, default true; false returns counts only"
}
```

Returns JSON with `"schema_version": 1`:

```json
{
  "schema_version": 1,
  "binary": false,
  "additions": 2,
  "deletions": 1,
  "approximate": false,
  "lossy": false,
  "patchTruncated": false,
  "patch": "Index: a.txt\n=====...\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,4 @@\n..."
}
```

- `binary`: either input contains a NUL byte, as in git. Counts are zero and there is no patch.
- `approximate`: the diff is valid, and its counts are accurate for it, but it is not guaranteed
  minimal. A differing region of up to about 28,000 lines is diffed exactly. A larger one is split
  at lines that occur once on each side, and each gap is diffed exactly from a shared work budget; a
  gap that does not fit becomes one replaced block. There is no time-based deadline, so a result
  never depends on how fast the host is.
- `lossy`: an input was not valid UTF-8 and invalid sequences were replaced.
- `patchTruncated`: the patch would exceed 4 MiB and is omitted; counts are still correct.

Errors are returned as JSON, never thrown:
`{"schema_version": 1, "error": "<code>", "message": "<detail>"}` with codes
`options_too_large`, `options_invalid`, `input_too_large`.

## Limits

| Limit | Value |
|---|---|
| Each input | 32 MiB |
| Options | 4 KiB |
| Names | 1 KiB each |
| Work budget | 8×10⁸ Myers steps, counted as (old+new lines)² per region |
| Context lines | 64 |
| Patch output | 4 MiB |

## Build

```sh
bun run build:wasm text-diff
```
