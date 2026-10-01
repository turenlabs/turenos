# installer-inspect

Bounded Windows installer inspection WebAssembly module for Turen agent tools.
Built for malware-dropper triage: it reads MSI/OLE compound files and Microsoft
Cabinet archives entirely in memory, decodes what is structurally interesting,
and never writes to a filesystem, opens a socket, or executes inspected input.

## Operations

All four operations take `(bytes, options_json)` and return a JSON string.
Expected failures throw a `JsError` whose message is the shared error envelope
`{"schema_version":1,"error":"<code>", ...}`.

### `msi_inspect(bytes, options)`

Treats the input as an OLE/CFB compound file and decodes it as a Windows
Installer database:

- `cfb` — container listing: every directory entry with path, kind
  (`root`/`storage`/`stream`), size, and CLSID, plus the root CLSID and CFB
  version. A CFB file that is not an MSI database still returns the container
  listing with `isMsi: false` and a warning.
- `package` — MSI package type (`installer`/`patch`/`transform` from the root
  CLSID), database code page, digital-signature presence (presence only;
  validity is not verified), and SummaryInformation fields.
- `tables` — every database table decoded into JSON rows (`rowCount`,
  `rowsTruncated`, column metadata). MSI `Binary` cells are reported as
  `<binary stream>` markers, never inlined.
- `streams` — embedded binary streams (Binary-table payloads, embedded
  cabinets) with decoded name, size, and SHA-256.
- `customActions` — every `CustomAction` row with the `Type` bitfield decoded
  into `kind` (`dll`/`exe`/`jscript`/`vbscript`/`install`, or `unknown-<n>`),
  `location` (`binary`/`installedFile`/`directoryPath`/`inlineText`/
  `propertyValue`), and scheduling flags (`inScript`, `rollback`, `commit`,
  `noImpersonate`, `64bitScript`, `hideTarget`, `tsAware`, `patchUninstall`,
  ...).
- `serviceInstalls` — decoded `ServiceInstall` rows (service name, start
  type, account, component).
- `sequences` — sorted action order for `InstallExecuteSequence`,
  `InstallUISequence`, `AdminExecuteSequence`, `AdminUISequence`.
- `properties` — `ProductCode`, `ProductName`, `ProductVersion`,
  `Manufacturer`, `UpgradeCode`, `PackageCode`, `ProductLanguage`, `ALLUSERS`,
  `REBOOT`.
- `findings` — triage findings: `customActionPayload` (DLL/EXE/script/install
  payloads), `suspiciousCustomActionTarget` (powershell, cmd.exe, mshta,
  rundll32, certutil, URLs, ...), `serviceInstall`, `registryPersistenceKey`
  (Run/RunOnce/Winlogon writes), `digitalSignaturePresent`.

Options: `maxRowsPerTable` (default/ceiling 4096), `maxTables`
(default/ceiling 4096), `tableFilter` (decode only the named table),
`includeStreamHashes` (default true).

### `msi_stream_read(bytes, options)`

Reads one embedded stream and returns
`{schema_version, stream, size, declaredSize, sha256, contentBase64,
truncated}`.

Options: `stream` (required) — a decoded stream name from
`msi_inspect`'s `streams[].name` (e.g. `evil.dll`), or a raw CFB path such as
`\u0005SummaryInformation`; `maxBytes` (optional) — bounded preview cap,
clamped to the ~3 MiB serialized-content ceiling.

Errors: `stream_not_found`, `stream_too_large` (declared over 8 MiB, or over
the JSON transport budget without `maxBytes`), `not_cfb`, `invalid_cfb`.

### `cab_list(bytes, options)`

Parses the MSCF header, folder table, and file table directly (hand-rolled in
`src/cab.rs`) and reports:

- header fields: version, `totalSize`, `filesOffset`, `flags`, `setId`,
  `setIndex`, `prevCabinet`/`nextCabinet` names for multi-cabinet sets,
  non-zero reserved fields (`nonZeroReservedFields`), and reserve bytes;
- `folders` — index, `dataOffset`, `dataBlocks`, decoded `compression`
  (`none`/`mszip`/`quantum`/`lzx`/`unknown` with level/window bits), and
  `compressionSupported`;
- `files` — name, uncompressed `size`, `folderOffset`, `folderIndex`,
  `compression`, `spansCabinet` (`fromPrevious`/`toNext` continuation
  markers), DOS `dateTime`, `attributes`, `isExec`, `nameIsUtf`.

Options: `maxFiles` (default/ceiling 4096).

### `cab_extract(bytes, options)`

Decompresses one named member and returns `{schema_version, file,
compression, size, declaredSize, sha256, contentBase64, truncated}`.

- `none` (stored), `mszip` (flate2/miniz_oxide), and `lzx` (lzxd) folders
  decode fully.
- `quantum` always reports `unsupported_compression`.
- Files spanning cabinet boundaries report `file_continued_from_previous` /
  `file_continues_in_next`; a set containing any spanning entry reports
  `unsupported_cabinet`.
- Members declaring more than 128 MiB report `entry_too_large` before any
  decompression work.

Options: `file` (required, exact name from `cab_list`), `maxBytes`
(optional) — bounded preview cap, clamped to the ~3 MiB serialized-content
ceiling.

## Hard bounds

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options JSON | 4 KiB |
| JSON output | 4 MiB |
| Listed entries / table rows | 4,096 |
| `msi_stream_read` stream | 8 MiB (declared) |
| `cab_extract` member | 128 MiB (declared) |
| Serialized `contentBase64` payload | ~3 MiB (JSON budget) |
| String cells | 4,096 chars |

Limits are enforced before unbounded allocation or serialization.

## Build

```sh
export PATH="$HOME/.cargo/bin:$PATH"
DUMP_FIXTURES=1 cargo test --manifest-path tools/installer-inspect/Cargo.toml
wasm-pack build tools/installer-inspect --target web --release --out-dir pkg
node tools/installer-inspect/script/pack.mjs tools/installer-inspect/pkg artifact/installer-inspect-wasm
node tools/installer-inspect/test/verify.mjs artifact/installer-inspect-wasm/dist
cd artifact/installer-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

Rust 1.97.1 and wasm-pack 0.15.0 are pinned in
`.github/workflows/build-installer-inspect.yml`. Unit-test fixtures are built
in code; `DUMP_FIXTURES=1` also writes them to `test/fixtures/` (gitignored)
for the real-WASM verifier, which loads `test/fixtures/*.msi|*.cab|*.cfb` —
not mocks.
