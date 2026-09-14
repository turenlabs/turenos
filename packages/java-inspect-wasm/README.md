# java-inspect

Bounded, offline Java `.class` and `.jar` static-inspection WebAssembly
module for TurenOS triage — the JVM counterpart to the `monodis` (.NET CIL)
target. It is byte-only and parse-first: no class is ever loaded, linked,
verified, or executed, and the module has no network, filesystem, process,
or environment access.

## Parser choice

The `.class` parser is **hand-rolled** (~500 lines of bounds-checked Rust)
rather than `cafebabe` or `noak`. Both crates were evaluated; a focused
parser was chosen because (a) the JVMS class-file format is compact and
stable, (b) we need lenient constant-pool *resolution* — unresolvable
indices degrade to `<bad ref #N>` strings plus a warning instead of failing
the whole parse — which neither crate exposes, and (c) it keeps the
dependency closure minimal. JAR (ZIP) reading delegates to the pinned `zip`
crate with its pure-Rust deflate backend (`flate2`/`miniz_oxide`); entries
are read one at a time and never written to disk.

## Operations

All operations take `(bytes: &[u8], options_json: &str) -> String` and return
deterministic JSON. Every result carries `schema_version: 1`; failures return
`{"schema_version":1,"error":"<code>"}` instead of trapping.

### `class_inspect`

Parses one `.class` file and reports:

- `major_version`/`minor_version`/`jdk` (JDK release name for the version),
  `kind` (class | interface | annotation | enum | module), `access_flags`
  (hex) plus named `access` list, `this_class`, `super_class`, `interfaces`.
- `constant_pool`: `count`, `entries`, `by_tag` counts; full dump via
  `{"dump_constant_pool":true}` capped at 4096 rows with UTF-8/string
  truncation (per-value 1024 chars).
- `fields`: name, descriptor, access flags, attribute names, annotations,
  `constant_value` when present.
- `methods`: name, descriptor, access flags, `code` metrics
  (`max_stack`, `max_locals`, `code_length`, `exception_table_length`,
  nested attribute names), checked `exceptions`, annotations.
- Class attributes: `attributes` (name+length table), `source_file`,
  `signature`, `inner_classes`, `annotations` (Runtime*Annotations summary
  with element previews), `nest_members`, `permitted_subclasses`,
  `record_components`, `bootstrap_methods` (target + resolved owner +
  arguments) and `uses_invokedynamic`/`uses_lambdas`/`uses_string_concat`
  flags.
- `findings`: security-relevant references detected from constant-pool
  Methodref/Fieldref entries (and declared members), each with `kind`,
  `detail`, and `cp_index`:
  `reflection` (java.lang.Class.forName/getMethod..., java.lang.reflect.*),
  `unsafe_usage` (sun/misc/Unsafe, jdk/internal/misc/Unsafe),
  `class_loader_define` (ClassLoader.defineClass/definePackage),
  `process_spawn` (Runtime.exec, ProcessBuilder),
  `serialization_call` (ObjectInputStream/ObjectOutputStream read/write),
  `serialization_method` (declared readObject/writeObject/readResolve/
  writeReplace/readExternal/writeExternal), `native_method`,
  `serializable` (implements java/io/Serializable|Externalizable),
  `script_engine` (javax/script/*, Nashorn, Rhino, GraalVM), and
  `method_handle_sink` (MethodHandles to define/exec sinks).

### `class_disassemble`

javap-style bytecode listing. `method_index` selects one method by index;
`method_name` selects all overloads of a name; absent both, every method is
listed in file order. Constant-pool operands resolve inline as `//` comments
(`invokespecial #5   // Method java/lang/Object.<init>:()V`), branch targets
print as absolute offsets, and `tableswitch`/`lookupswitch` render
javap-style case blocks (case display capped at 4096, payload always
skipped correctly). A 2 MiB `text` cap applies across the whole listing.

Degradation is explicit, matching `monodis`: unknown opcodes, truncated
operands, malformed Code attributes, and missing Code attributes all emit
`// WARNING: ...` lines (also collected into `warnings`) — bytecode is never
silently skipped.

### `jar_inspect`

JAR = ZIP inspection via the `zip` crate: `entries` table (index, name,
size, compressed_size, method, is_dir, is_class) capped at 4096 rows over a
65536-entry statistics scan, `manifest` (`META-INF/MANIFEST.MF` decoded with
a 256 KiB bound: `main_attributes`, `digest_attributes`, `section_count`,
raw `text`), `signing_files` (META-INF/*.SF/.RSA/.DSA/.EC), `class_entries`
count, `multi_release`/`versioned_entries`/`versions`, `module_info`, and
`signed`.

`{"entry_index":N}` retrieves exactly one entry: it is decompressed under a
32 MiB cap and, when it carries `CAFEBABE`, its full `class_inspect` report
is embedded as `selected_entry.class`. This is the retrieve-one-entry
surface — the module never extracts paths and never writes to disk.

## Limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options JSON | 4 KiB |
| JSON output | 4 MiB |
| Result lists (fields, methods, entries, findings, CP dump) | 4,096 |
| Reported string value | 1,024 chars |
| Annotation elements decoded | 512 |
| Switch cases rendered | 4,096 |
| JAR entries walked for stats | 65,536 |
| MANIFEST.MF decompressed | 256 KiB |
| Selected entry decompressed | 32 MiB |
| Disassembly text | 2 MiB |

Limits are enforced before allocation and before serialization. Malformed
input degrades to `warnings`/`// WARNING` markers or stable error JSON; the
dispatcher wraps every op in `catch_unwind` so a parser panic becomes
`internal_error` instead of trapping the worker.

## Error codes

`empty_input`, `input_too_large`, `options_too_large`, `invalid_options`,
`bad_magic`, `truncated_class`, `bad_constant_pool`, `bad_annotation`,
`annotation_too_deep`, `method_not_found`, `bad_zip`, `bad_zip_entry`,
`entry_not_found`, `entry_too_large`, `output_too_large`,
`serialization_error`, `internal_error`.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/java-inspect/Cargo.toml
wasm-pack build tools/java-inspect --target web --release --out-dir pkg
node tools/java-inspect/script/pack.mjs tools/java-inspect/pkg artifact/java-inspect-wasm
node tools/java-inspect/test/verify.mjs artifact/java-inspect-wasm/dist
cd artifact/java-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain: Rust 1.97.1, wasm-pack 0.15.0, `wasm32-unknown-unknown`. The
release profile uses `lto`, `opt-level = "s"`, and wasm-opt
`-Os --enable-bulk-memory --enable-nontrapping-float-to-int`.

## Boundary

No network, filesystem, process, or environment access; inspected bytecode
is never executed. ZIP handling is listing plus bounded single-entry
decompression only — no path handling, no writes.
