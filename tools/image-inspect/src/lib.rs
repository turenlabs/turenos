//! Bounded, offline image and image-container metadata inspection for
//! TurenOS triage. Structure walkers are parse-only: pixel payloads are
//! measured, never decoded, except inside `image_pixel_stats` which is
//! dimension-capped before decode. The module has no network, filesystem,
//! or process access and never executes inspected content.

mod exif_op;
mod gif;
mod inspect;
mod jpeg;
mod misc;
mod model;
mod pixels;
mod png;
mod text;
mod webp;

#[cfg(test)]
mod tests;

use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

/// Hard input bound enforced before any parsing or allocation.
pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Hard bound on the JSON options string.
pub(crate) const MAX_OPTIONS_BYTES: usize = 4 * 1024;
/// Hard bound on serialized JSON output.
pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Hard bound on structure records, text entries, and field lists.
pub(crate) const MAX_RESULTS: usize = 4096;
/// Per-value cap on returned text (spec: 2 KiB).
pub(crate) const MAX_TEXT_BYTES: usize = 2048;
/// Bound on a single zTXt/iTXt inflate.
pub(crate) const MAX_INFLATE_BYTES: u64 = 256 * 1024;
/// Bound on anomaly/warning strings.
pub(crate) const MAX_WARNINGS: usize = 64;
/// Bound on a single reported metadata string.
pub(crate) const MAX_STRING_CHARS: usize = 1024;

/// Failure carrying a stable machine-readable code plus optional detail
/// fields merged into the error JSON object.
pub(crate) struct Fail {
    code: &'static str,
    extra: serde_json::Map<String, serde_json::Value>,
}

impl Fail {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code,
            extra: serde_json::Map::new(),
        }
    }

    pub(crate) fn with(mut self, key: &str, value: impl Into<serde_json::Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }
}

pub(crate) type OpResult = Result<serde_json::Value, Fail>;

pub(crate) fn error_json(code: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": code }).to_string()
}

fn fail_json(fail: Fail) -> String {
    let mut object = serde_json::Map::new();
    object.insert("schema_version".to_string(), 1.into());
    object.insert("error".to_string(), fail.code.into());
    object.extend(fail.extra);
    serde_json::Value::Object(object).to_string()
}

/// Parse the options JSON. An empty string means defaults; anything else must
/// be a valid JSON object (never an array — that would allow positional
/// option smuggling). Size is checked by the dispatcher before this runs.
fn parse_options<T: DeserializeOwned + Default>(options_json: &str) -> Result<T, Fail> {
    let trimmed = options_json.trim();
    if trimmed.is_empty() {
        return Ok(T::default());
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|_| Fail::new("invalid_options"))?;
    if !value.is_object() {
        return Err(Fail::new("invalid_options"));
    }
    serde_json::from_value(value).map_err(|_| Fail::new("invalid_options"))
}

/// Shared dispatcher: enforce input/options bounds before any allocation,
/// run the operation under `catch_unwind` so a parser panic on malformed
/// input degrades to `internal_error` instead of trapping the worker, then
/// bound serialized output.
fn dispatch<T, F>(bytes: &[u8], options_json: &str, op: F) -> String
where
    T: DeserializeOwned + Default,
    F: FnOnce(&[u8], &T) -> OpResult,
{
    if bytes.is_empty() {
        return error_json("empty_input");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return error_json("input_too_large");
    }
    if options_json.len() > MAX_OPTIONS_BYTES {
        return error_json("options_too_large");
    }
    let options = match parse_options::<T>(options_json) {
        Ok(options) => options,
        Err(fail) => return fail_json(fail),
    };
    let value = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        op(bytes, &options)
    })) {
        Ok(Ok(value)) => value,
        Ok(Err(fail)) => return fail_json(fail),
        Err(_) => return fail_json(Fail::new("internal_error")),
    };
    match serde_json::to_string(&value) {
        Ok(json) if json.len() <= MAX_OUTPUT_BYTES => json,
        Ok(_) => error_json("output_too_large"),
        Err(_) => error_json("serialization_error"),
    }
}

/// Format detection plus per-format structure: chunk/segment/block tables,
/// dimensions, bit depth, color type, decoded text chunks, EXIF/XMP/ICC
/// presence, trailing bytes past the end-of-image marker, and anomaly flags.
///
/// Options: `max_entries` (default and cap 4096), `max_text_bytes` (default
/// and cap 2048), `include_text` (default true).
#[wasm_bindgen]
pub fn image_inspect(bytes: &[u8], options_json: &str) -> String {
    dispatch::<inspect::InspectOptions, _>(bytes, options_json, |b, o| inspect::run(b, o))
}

/// EXIF/TIFF tag extraction from the container's EXIF block (JPEG APP1, PNG
/// eXIf, WebP EXIF, AVIF Exif item, or a TIFF file itself). GPS coordinates,
/// camera fields, and thumbnail presence (bytes only when <= 256 KiB, else
/// size + SHA-256 + offset). `exif_present: false` when the container has no
/// EXIF block; `invalid_exif` when a found block fails to parse.
///
/// Options: `max_fields` (default 512, cap 4096).
#[wasm_bindgen]
pub fn image_exif(bytes: &[u8], options_json: &str) -> String {
    dispatch::<exif_op::ExifOptions, _>(bytes, options_json, |b, o| exif_op::run(b, o))
}

/// All textual metadata across formats — PNG tEXt/zTXt/iTXt, JPEG COM and
/// XMP, GIF comments and plain text, WebP XMP, TIFF ASCII tags — as
/// `{location, keyword, text<=2KiB}`. Non-UTF-8 payloads surface as hex so
/// prompt-injection and stego carriers stay inspectable.
///
/// Options: `max_entries` (default and cap 4096), `max_text_bytes` (default
/// and cap 2048).
#[wasm_bindgen]
pub fn image_text_chunks(bytes: &[u8], options_json: &str) -> String {
    dispatch::<text::TextOptions, _>(bytes, options_json, |b, o| text::run(b, o))
}

/// Bounded pixel statistics: 16-bin luma histogram plus per-channel means.
/// PNG and JPEG only; dimensions are checked from the header before decode
/// and anything over `max_dimension` (default and cap 4096) is refused.
#[wasm_bindgen]
pub fn image_pixel_stats(bytes: &[u8], options_json: &str) -> String {
    dispatch::<pixels::PixelOptions, _>(bytes, options_json, |b, o| pixels::run(b, o))
}

/// Truncate to `limit` bytes on a char boundary.
pub(crate) fn clean(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let end = value
        .char_indices()
        .take_while(|(index, _)| *index < limit)
        .last()
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    value[..end].to_string()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(TABLE[(byte >> 4) as usize] as char);
        output.push(TABLE[(byte & 15) as usize] as char);
    }
    output
}

/// Standard base64 (shared convention with tools/pdf-inspect).
pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        output.push(TABLE[a >> 2] as char);
        output.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((b & 15) << 2) | (c >> 6)] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[c & 63] as char);
        } else {
            output.push('=');
        }
    }
    output
}
