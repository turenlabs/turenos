# image-inspect

Bounded, offline image and image-container metadata inspection WebAssembly
module for TurenOS triage. It is byte-only and parse-first: structure walkers
measure payloads rather than decoding them, and the single optional pixel
decode is dimension-capped before allocation.

## Operations

All operations take `(bytes: &[u8], options_json: &str) -> String` and return
deterministic JSON. Every result carries `schema_version: 1`; failures return
`{"schema_version":1,"error":"<code>"}` instead of trapping.

### `image_inspect`

Detects the container by magic bytes and runs the per-format structure
walker:

| Format | Detects | Reports |
| --- | --- | --- |
| PNG | `\x89PNG\r\n\x1a\n` | Chunk table (type, offset, length, CRC-valid, critical), IHDR dimensions/bit-depth/color, decoded tEXt/zTXt/iTXt, eXIf/iCCP locations, APNG flag, non-consecutive IDAT, chunks after IEND, unknown critical chunks, oversized metadata |
| JPEG | `\xff\xd8\xff` | Marker segment table (SOI, APPn, COM, DQT, DHT, SOFn, SOS, EOI), dimensions from SOF, EXIF/XMP/ICC locations in APPn, trailing bytes after EOI |
| GIF | `GIF87a`/`GIF89a` | Logical screen descriptor, frame and extension counts, comment/plain-text payloads, trailer position |
| BMP | `BM` | Header fields, dimensions, bit depth, compression, palette/pixel-data offsets |
| WebP | `RIFF....WEBP` | RIFF chunk list, VP8/VP8L/VP8X dimensions and feature flags, ICCP/EXIF/XMP locations, ANIM frame counting |
| TIFF | `II*\x00`, `MM\x00*`, BigTIFF | IFD table with tag counts, dimensions, EXIF tag values, thumbnail offsets |
| ICO | `\x00\x00\x01\x00`/`\x00\x00\x02\x00` | Directory entries, per-image dimensions and format (PNG/BMP payload detection) |
| AVIF/HEIC | `ftyp` box brands | ISO BMFF box table, `avif` brand detection, Exif item location, dimension items |

Cross-cutting: `input_sha256`, `input_size`, trailing bytes after the
end-of-image marker (offset, length, hex preview), structural `anomalies`,
`warnings`, and `truncated` flags when collection caps engaged.

Options: `max_entries` (cap 4096), `max_text_bytes` (cap 2048),
`include_text` (default true).

### `image_exif`

Parses the container's EXIF/TIFF block (JPEG APP1, PNG eXIf, WebP EXIF, AVIF
Exif item, or a TIFF file itself) with the pinned `kamadak-exif` crate.
Reports `exif_present`, camera fields (`make`, `model`, `software`,
`datetime`, `datetime_original`, `orientation`, `lens_model`, `artist`,
`copyright`, `image_description`), signed-decimal GPS coordinates, and a
bounded `fields` table. Thumbnail bytes are returned only when <= 256 KiB;
larger thumbnails report size, offset, and SHA-256 instead.

Options: `max_fields` (default 512, cap 4096).

### `image_text_chunks`

Every textual metadata value across the container as
`{location, keyword, text, encoding, truncated}` — PNG tEXt/zTXt/iTXt, JPEG
COM and XMP, GIF comment/plain-text extensions, WebP XMP, TIFF ASCII tags.
Non-UTF-8 payloads surface as hex so binary carriers remain inspectable.
This is the hidden-payload and prompt-injection hunting surface.

Options: `max_entries` (cap 4096), `max_text_bytes` (cap 2048).

### `image_pixel_stats`

Optional bounded pixel decode via the `image` crate (built with PNG/JPEG
features only). Dimensions are read from the container header and anything
over `max_dimension` (default and cap 4096) is refused before decode.
Returns a 16-bin luma histogram plus per-channel means computed over a
deterministic strided sample (at most ~4,000,000 pixels). Other formats
return `unsupported_format`.

## Limits

| Bound | Value |
| --- | --- |
| Input bytes | 32 MiB |
| Options JSON | 4 KiB |
| JSON output | 4 MiB |
| Result entries (chunks, texts, fields) | 4,096 |
| Single text value | 2 KiB |
| zTXt/iTXt inflate output | 256 KiB |
| EXIF thumbnail bytes returned | 256 KiB |
| Pixel decode dimensions | 4096 x 4096 |
| Pixel samples for statistics | 4,000,000 |

Limits are enforced before allocation and before result serialization.
Malformed or offset-dense input degrades to anomaly flags or stable error
JSON; the dispatcher also wraps each operation in `catch_unwind` so an
unexpected parser panic returns `internal_error` instead of trapping the
worker.

## Build and verify

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path tools/image-inspect/Cargo.toml
wasm-pack build tools/image-inspect --target web --release --out-dir pkg
node tools/image-inspect/script/pack.mjs tools/image-inspect/pkg artifact/image-inspect-wasm
node tools/image-inspect/test/verify.mjs artifact/image-inspect-wasm/dist
cd artifact/image-inspect-wasm && shasum -a 256 -c SHA256SUMS
```

Toolchain: Rust 1.97.1, wasm-pack 0.15.0, `wasm32-unknown-unknown`. The
release profile uses `lto`, `opt-level = "s"`, and wasm-opt
`-Os --enable-bulk-memory --enable-nontrapping-float-to-int`.

## Boundary

No network, filesystem, process, or environment access; inspected content is
never executed. No archive extraction, no path handling, no writes. Pixel
payloads are decoded only inside `image_pixel_stats` under the dimension cap.
