//! Shared data model, bounds-checked byte reader, format detection, and the
//! `parse_image` dispatcher used by every operation. All structure walkers are
//! parse-only: they never decode pixel data and never allocate on claimed
//! lengths — every read is bounds-checked against the real input first.

use serde::Serialize;

use crate::{clean, hex, Fail, MAX_WARNINGS};

/// One structural record inside a container: a PNG chunk, a JPEG segment, a
/// GIF block, a WebP RIFF chunk, a BMFF box, an ICO directory entry, or a TIFF
/// IFD. `offset`/`length` describe the record's payload; `offset` points at
/// the record header (length/type field) so consumers can re-slice the input.
#[derive(Serialize)]
pub(crate) struct Region {
    pub name: String,
    pub offset: u64,
    pub length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crc_valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub critical: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// One textual metadata value recovered from the container.
#[derive(Serialize)]
pub(crate) struct TextEntry {
    pub location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
    pub text: String,
    /// `latin-1` for PNG tEXt/zTXt, `utf-8` for iTXt/XMP/comments that decoded
    /// cleanly, `hex` for the raw-bytes fallback on non-UTF-8 payloads.
    pub encoding: String,
    pub truncated: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct ByteRange {
    pub offset: u64,
    pub length: u64,
}

pub(crate) struct Trailing {
    pub offset: u64,
    pub length: u64,
    pub hex_preview: String,
}

pub(crate) struct Report {
    pub format: &'static str,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub bit_depth: Option<u32>,
    pub color_type: Option<String>,
    /// Format-specific scalars merged into the top-level JSON object.
    pub extra: serde_json::Map<String, serde_json::Value>,
    /// Key under which `regions` is serialized: "chunks", "segments",
    /// "blocks", "boxes", "entries", or "ifds".
    pub region_kind: &'static str,
    pub regions: Vec<Region>,
    pub regions_total: usize,
    pub texts: Vec<TextEntry>,
    pub texts_total: usize,
    /// Location of an embedded TIFF/EXIF block, when the container carries one.
    pub exif: Option<ByteRange>,
    pub icc: Option<ByteRange>,
    pub xmp_present: bool,
    pub trailing: Option<Trailing>,
    pub anomalies: Vec<String>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

/// Per-call collection bounds, derived from options and hard caps.
pub(crate) struct Limits {
    pub max_regions: usize,
    pub max_texts: usize,
    /// Maximum bytes of source text kept per value before `truncated`.
    pub max_text_bytes: usize,
    /// Upper bound on a single inflate for zTXt/iTXt payloads.
    pub max_inflate_bytes: u64,
    pub collect_text: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_regions: crate::MAX_RESULTS,
            max_texts: crate::MAX_RESULTS,
            max_text_bytes: crate::MAX_TEXT_BYTES,
            max_inflate_bytes: crate::MAX_INFLATE_BYTES,
            collect_text: true,
        }
    }
}

impl Report {
    pub fn new(format: &'static str, region_kind: &'static str) -> Self {
        Self {
            format,
            width: None,
            height: None,
            bit_depth: None,
            color_type: None,
            extra: serde_json::Map::new(),
            region_kind,
            regions: Vec::new(),
            regions_total: 0,
            texts: Vec::new(),
            texts_total: 0,
            exif: None,
            icc: None,
            xmp_present: false,
            trailing: None,
            anomalies: Vec::new(),
            warnings: Vec::new(),
            truncated: false,
        }
    }

    pub fn region(
        &mut self,
        limits: &Limits,
        name: impl Into<String>,
        offset: usize,
        length: usize,
    ) {
        self.regions_total += 1;
        if self.regions.len() >= limits.max_regions {
            self.truncated = true;
            return;
        }
        self.regions.push(Region {
            name: name.into(),
            offset: offset as u64,
            length: length as u64,
            crc_valid: None,
            critical: None,
            detail: None,
        });
    }

    /// Mutate the most recently pushed region (sets crc/critical/detail).
    pub fn last_region(&mut self) -> Option<&mut Region> {
        self.regions.last_mut()
    }

    pub fn anomaly(&mut self, value: impl Into<String>) {
        if self.anomalies.len() < MAX_WARNINGS {
            self.anomalies.push(value.into());
        }
    }

    pub fn warning(&mut self, value: impl Into<String>) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(value.into());
        }
    }
}

/// How a recovered text payload is turned into a capped JSON string.
#[derive(Clone, Copy)]
pub(crate) enum TextEncoding {
    /// PNG tEXt/zTXt: every byte maps to the same code point (never invalid).
    Latin1,
    /// Try UTF-8; on failure emit hex of the raw bytes so binary payloads
    /// (prompt-injection carriers, stego blobs) remain inspectable.
    Utf8OrHex,
}

/// Append a bounded text entry. `raw` is the already-located payload; this
/// function applies the per-value cap and the entries cap.
pub(crate) fn push_text(
    report: &mut Report,
    limits: &Limits,
    location: impl Into<String>,
    keyword: Option<String>,
    raw: &[u8],
    encoding: TextEncoding,
) {
    report.texts_total += 1;
    if !limits.collect_text {
        return;
    }
    if report.texts.len() >= limits.max_texts {
        report.truncated = true;
        return;
    }
    let cap = limits.max_text_bytes;
    let (text, encoding_name, truncated) = match encoding {
        TextEncoding::Latin1 => {
            let kept = raw.len().min(cap);
            (
                raw[..kept].iter().map(|byte| *byte as char).collect(),
                "latin-1",
                raw.len() > kept,
            )
        }
        TextEncoding::Utf8OrHex => match std::str::from_utf8(raw) {
            Ok(value) => {
                let kept = clean(value, cap);
                let truncated = kept.len() < value.len();
                (kept, "utf-8", truncated)
            }
            Err(_) => {
                // hex doubles the size; halve the byte budget so the emitted
                // value still stays under the caller's text cap.
                let kept = raw.len().min(cap / 2);
                (hex(&raw[..kept]), "hex", raw.len() > kept)
            }
        },
    };
    report.texts.push(TextEntry {
        location: location.into(),
        keyword,
        text,
        encoding: encoding_name.to_string(),
        truncated,
    });
}

/// Decode a PNG-style `keyword\0value` field into `(keyword, value)`.
/// Keywords are Latin-1 printable text; NUL inside the value is preserved.
pub(crate) fn split_keyword(raw: &[u8]) -> (Option<String>, &[u8]) {
    match raw.iter().position(|byte| *byte == 0) {
        Some(index) => {
            let keyword: String = raw[..index].iter().map(|byte| *byte as char).collect();
            (Some(clean(&keyword, 128)), &raw[index + 1..])
        }
        None => (None, raw),
    }
}

/// Bounded zlib inflate for zTXt/iTXt payloads. `limit` bounds the output;
/// exceeding it reports `None` (the caller records a warning) rather than
/// materializing an unbounded buffer.
pub(crate) fn inflate_bounded(raw: &[u8], limit: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::bufread::ZlibDecoder::new(raw).take(limit + 1);
    let mut out = Vec::new();
    if decoder.read_to_end(&mut out).is_err() {
        return None;
    }
    if out.len() as u64 > limit {
        return None;
    }
    Some(out)
}

/// Detect the container format from magic bytes. Returns "unknown" when no
/// signature matches; the inspect op turns that into `unknown_format`.
pub(crate) fn detect_format(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"II*\x00")
        || bytes.starts_with(b"MM\x00*")
        || bytes.starts_with(b"II+\x00")
        || bytes.starts_with(b"MM\x00+")
    {
        "tiff"
    } else if bytes.starts_with(b"\x00\x00\x01\x00") || bytes.starts_with(b"\x00\x00\x02\x00") {
        "ico"
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        // ISO BMFF family: AVIF/HEIC/HEIF share the box structure.
        if bmff_has_brand(bytes, b"avif") || bmff_has_brand(bytes, b"avis") {
            "avif"
        } else {
            "bmff"
        }
    } else {
        "unknown"
    }
}

/// Scan the `ftyp` box for a brand: major brand at offset 8, compatible
/// brands from offset 16 in 4-byte steps (bounded scan — the brand list is
/// conventionally small and always near the file start).
fn bmff_has_brand(bytes: &[u8], brand: &[u8; 4]) -> bool {
    if bytes.len() >= 12 && &bytes[8..12] == brand {
        return true;
    }
    let mut index = 16;
    while index + 4 <= bytes.len() && index < 16 + 512 {
        if &bytes[index..index + 4] == brand {
            return true;
        }
        index += 4;
    }
    false
}

/// Run the right structure walker for the detected format. Unknown signatures
/// produce `unknown_format`; malformed-but-recognized containers return a
/// partial report carrying `anomalies` instead of failing.
pub(crate) fn parse_image(bytes: &[u8], limits: &Limits) -> Result<Report, Fail> {
    let format = detect_format(bytes);
    let kind = match format {
        "png" | "webp" | "avif" | "bmff" => "chunks",
        "jpeg" => "segments",
        "gif" => "blocks",
        "bmp" => "regions",
        "tiff" => "ifds",
        "ico" => "entries",
        _ => "chunks",
    };
    let mut report = Report::new(format, kind);
    match format {
        "png" => crate::png::parse(bytes, &mut report, limits),
        "jpeg" => crate::jpeg::parse(bytes, &mut report, limits),
        "gif" => crate::gif::parse(bytes, &mut report, limits),
        "webp" => crate::webp::parse(bytes, &mut report, limits),
        "bmp" => crate::misc::parse_bmp(bytes, &mut report, limits),
        "tiff" => crate::misc::parse_tiff(bytes, &mut report, limits),
        "ico" => crate::misc::parse_ico(bytes, &mut report, limits),
        "avif" | "bmff" => crate::misc::parse_bmff(bytes, &mut report, limits),
        _ => Err(Fail::new("unknown_format").with(
            "magic",
            hex(&bytes[..bytes.len().min(16)]),
        )),
    }?;
    Ok(report)
}

/// Bounds-checked cursor over the input. Every primitive returns `Option` so
/// a truncated structure short-circuits instead of panicking; walkers record
/// an anomaly when a read fails mid-structure.
pub(crate) struct Reader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn at(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    pub fn u8(&mut self) -> Option<u8> {
        let byte = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(byte)
    }

    pub fn be16(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    pub fn be32(&mut self) -> Option<u32> {
        let bytes = self.take(4)?;
        Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn le16(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub fn le32(&mut self) -> Option<u32> {
        let bytes = self.take(4)?;
        Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// `n`-byte big-endian unsigned read for the variable-width iloc fields.
    pub fn be_uint(&mut self, n: usize) -> Option<u64> {
        if n > 8 {
            return None;
        }
        let bytes = self.take(n)?;
        let mut value = 0u64;
        for byte in bytes {
            value = (value << 8) | *byte as u64;
        }
        Some(value)
    }

    pub fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let slice = self.data.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(slice)
    }

    pub fn skip(&mut self, n: usize) -> Option<()> {
        self.take(n).map(|_| ())
    }
}
