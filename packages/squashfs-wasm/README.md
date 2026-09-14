# squashfs-wasm

Bounded SquashFS listing and single-entry extraction for Turen agent tools —
the extraction counterpart to `binwalk-scan` for firmware analysis.

Built on [`backhand`](https://github.com/wcampbell0x2a/backhand) `0.25.3`
(commit `eccf81b6f599cb90245d7c9694e95ee6023cad06`) compiled to
`wasm32-unknown-unknown` with a pure-Rust dependency closure.

## API

```text
squashfs_list(bytes, options_json)    -> JSON string
squashfs_extract(bytes, options_json) -> JSON string
```

Both take the image bytes plus a JSON options object and return a JSON report.
Expected failures are thrown as `JsError` whose message is a JSON object
`{"schema_version":1,"error":"<code>", ...}`.

Nothing is ever written to a filesystem: `squashfs_extract` returns one
entry's bytes as base64 inside the JSON report, and paths in the image are
never interpreted as host paths. Symlinks are reported, never followed, and
extraction is exact-normalized-path only — no traversal semantics.

### `squashfs_list(bytes, options)`

Options: `offset` (byte offset of the image inside `bytes`, for firmware
containers with leading padding), `pathFilter` (directory-prefix filter),
`maxResults` (entry cap override, still bounded by 4096).

Report: superblock metadata (`kind`, `magic`, endianness, `versionMajor`,
`versionMinor`, `compression`, `compressionSupported`, `blockSize`,
`blockLog`, `inodeCount`, `fragmentCount`, `flags`, `idCount`, `modTime`,
`bytesUsed`, `rootInode`) plus `entries`, sorted by path:

```json
{ "path": "/etc/passwd", "type": "file", "size": 121,
  "mode": "0644", "uid": 0, "gid": 0, "mtime": 1704067210 }
```

`type` is one of `file`, `dir`, `symlink` (with `linkTarget`), `chardev`,
`blockdev` (both with `deviceNumber`), `fifo`, or `socket`. `truncated` marks
entries beyond the cap; `entryCount` and `imageNodes` give the totals.

### `squashfs_extract(bytes, options)`

Options: `path` (required), `offset`, `maxBytes` (preview cap).

Extracts exactly one regular file by exact normalized path and returns:

```json
{ "path": "/etc/passwd", "type": "file", "size": 121, "declaredSize": 121,
  "mode": "0644", "uid": 0, "gid": 0, "mtime": 1704067210,
  "sha256": "…", "truncated": false,
  "bytesHex": "…first 64 bytes…", "contentBase64": "…" }
```

With `maxBytes` set, at most that many bytes are returned and `truncated`
is `true` when the entry was clipped. Without it, an entry that cannot fit
the JSON output budget fails `entry_too_large`. Directories, symlinks,
devices, FIFOs, and sockets fail `entry_not_file` with `entryType`.

### Error codes

`input_too_large`, `options_too_large`, `invalid_options`, `not_squashfs`,
`unsupported_kind`, `unsupported_version`, `unsupported_compression`,
`invalid_image`, `truncated_image`, `invalid_path`, `not_found`,
`entry_not_file`, `entry_too_large`, `output_too_large`,
`allocation_failed`, `internal`.

## Supported images

- SquashFS 4.0 little-endian (`hsqs`), big-endian (`sqsh`), and the AVM
  mixed-endian variant.
- SquashFS 3.x little- and big-endian (gzip only).
- Compressors: `none`, `gzip`, `lz4`.

Images using `xz`, `zstd`, `lzo`, or `lzma` (including the `v3_lzma` vendor
kinds `qshs`/`shsq`) are detected but report `unsupported_compression` /
`unsupported_kind`: the corresponding backhand features pull in C code
(`liblzma-sys`, `zstd-sys`, `lzma-adaptive-sys`) or GPL-licensed code
(`lzo`, `lzma-adaptive-sys`), which does not fit this artifact's pure-Rust,
MIT/Apache-only closure.

## Bounds

| Limit | Value |
| --- | --- |
| input | 32 MiB |
| options JSON | 4 KiB |
| JSON output | 4 MiB |
| listed entries | 4,096 |
| extracted entry | 128 MiB declared, ~3 MiB serialized payload |

Extraction is additionally bounded by the 4 MiB JSON output cap: the
serialized `contentBase64` payload is limited to roughly 3 MiB. Larger
entries require `maxBytes` previews. The hard per-entry cap stays 128 MiB.

## Build

```sh
export PATH="$HOME/.cargo/bin:$PATH"
sh tools/squashfs/script/import-upstream.sh   # vendored pinned backhand + patch
DUMP_FIXTURES=1 cargo test --locked --manifest-path tools/squashfs/Cargo.toml
wasm-pack build tools/squashfs --target web --release --out-dir pkg
node tools/squashfs/test/verify.mjs tools/squashfs/pkg
node tools/squashfs/script/pack.mjs tools/squashfs/pkg artifact/squashfs-wasm
node tools/squashfs/test/verify.mjs artifact/squashfs-wasm/dist
cd artifact/squashfs-wasm && shasum -a 256 -c SHA256SUMS
```

Requires Rust 1.97.1, wasm-pack 0.15.0, and Node 24. Test fixtures are
generated in-memory by the Rust tests (`FilesystemWriter`); `DUMP_FIXTURES=1`
additionally writes `test/fixtures/*.sqfs` (gitignored) for the real-WASM
verification harness.

## Provenance

See `SOURCE.json`. The vendored upstream lives in the gitignored
`tools/squashfs/upstream/` directory; `patches/0001-wasm-osstr.patch` adds the
non-unix/non-Windows `OsStr` byte fallback required to compile backhand for
`wasm32-unknown-unknown`.
