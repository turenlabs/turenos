//! Hand-rolled RTF 1.x tokenizer and bounded single-pass document scanner.
//!
//! The tokenizer understands groups (`{`/`}`), control words (`\name` with an
//! optional signed integer parameter), control symbols (`\` plus one
//! non-alphabetic byte), escaped hex bytes (`\'hh`), `\binN` binary runs, and
//! literal text. The scanner walks tokens once and builds a bounded [`Doc`]
//! used by every operation: structure statistics, destination captures (font
//! table, style sheet, color table, info, generator, pictures, OLE objects,
//! file table, field instructions, data stores), codepage-resolved body text,
//! and the security-finding list. Every collection is capped while scanning;
//! nothing is copied out of the input except bounded captures.
//!
//! The parser never executes embedded content, never follows references, and
//! treats malformed input as data: corrupt hex streams, unbalanced groups,
//! and hostile nesting degrade to findings and warnings, not panics.

use sha2::Digest;
use std::collections::BTreeMap;

use crate::{clean, hex, MAX_STRING_CHARS};

/// Group depth at which `deep_nesting` findings start (spec: flag depth > 8).
pub(crate) const DEPTH_FLAG: usize = 8;
/// Groups deeper than this are scanned only for brace balance; their contents
/// are not interpreted ("stop descending that branch, keep scanning").
pub(crate) const MAX_GROUP_DEPTH: usize = 64;
/// Absolute frame-stack bound; deeper opens are counted but not tracked.
pub(crate) const MAX_TRACKED_DEPTH: usize = 512;
/// Recorded control-word name cap (RTF names are < 32 bytes per spec).
const NAME_CAP: usize = 32;
/// Destination collection caps, enforced while scanning.
pub(crate) const MAX_FONTS: usize = 1024;
pub(crate) const MAX_STYLES: usize = 512;
pub(crate) const MAX_COLORS: usize = 256;
pub(crate) const MAX_INFO_FIELDS: usize = 64;
pub(crate) const MAX_OBJECTS: usize = 1024;
pub(crate) const MAX_PICTS: usize = 1024;
pub(crate) const MAX_FILES: usize = 512;
pub(crate) const MAX_FIELDS: usize = 512;
/// Findings retained during the scan; `findings_total` counts all of them.
pub(crate) const MAX_FINDINGS: usize = 4096;
pub(crate) const MAX_WARNINGS: usize = 64;
/// Body text retained for `rtf_text` and previews; totals keep counting past
/// the cap.
pub(crate) const MAX_TEXT_CHARS: usize = 512 * 1024;
/// Per-capture bound (names, field instructions, templates, class names).
const CAPTURE_CAP: usize = 4096;
/// Decoded `\objdata` bytes retained per object for preview and the optional
/// hex dump.
pub(crate) const KEEP_PAYLOAD_BYTES: usize = 64 * 1024;
/// Aggregate retained-payload budget across all objects.
const KEEP_TOTAL_BYTES: usize = 4 * 1024 * 1024;
/// Codepage-decode scratch bound.
const PENDING_CAP: usize = 64 * 1024;
/// Consecutive `\'hh` escapes in body text that flag a hex-heavy region.
const HEX_RUN_FLAG: usize = 32;
/// Total `\'hh` escapes that flag whole-document hex obfuscation.
const HEX_TOTAL_FLAG: usize = 2048;
/// Alternating single-character/space splits inside one text run that flag
/// whitespace obfuscation.
const FRAG_SPLIT_FLAG: usize = 6;
/// Consecutive single-letter control words that flag control fragmentation.
const SINGLE_CHAR_RUN_FLAG: usize = 8;
/// `{\*\...}` ignorable groups above which we flag destination stuffing.
const IGNORABLE_FLAG: usize = 64;
/// Control words per KiB of input above which we flag control flooding.
const DENSITY_FLAG: usize = 512;

/// Effective destination of a group: where its content semantically lives.
/// Only `Text` contributes to the body-text stream; the rest are either
/// captured into bounded slots or skipped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Dest {
    Text,
    Skip,
    FontTbl,
    ColorTbl,
    StyleSheet,
    Info,
    Pict,
    Object,
    Result,
    ObjData,
    ObjClass,
    FldInst,
    FileTbl,
    File,
    FName,
    FRelative,
    Template,
    Generator,
    Password,
    Panose,
    DataStore,
}

/// Map a group's first control word to its destination kind. `starred` marks
/// `{\*\name ...}` ignorable destinations: unknown starred names are skipped;
/// unstarred unknown names keep the parent's destination.
fn dest_kind(name: &[u8], starred: bool, parent: Dest) -> Dest {
    match name {
        b"fonttbl" => Dest::FontTbl,
        b"colortbl" => Dest::ColorTbl,
        b"stylesheet" => Dest::StyleSheet,
        b"info" => Dest::Info,
        b"pict" => Dest::Pict,
        b"object" => Dest::Object,
        b"result" => Dest::Result,
        b"fldinst" | b"instrText" => Dest::FldInst,
        b"objdata" => Dest::ObjData,
        b"objclass" => Dest::ObjClass,
        b"filetbl" => Dest::FileTbl,
        b"file" if parent == Dest::FileTbl => Dest::File,
        b"fname" => Dest::FName,
        b"frelative" => Dest::FRelative,
        b"template" => Dest::Template,
        b"generator" => Dest::Generator,
        b"password" | b"passwordpp" => Dest::Password,
        b"panose" => Dest::Panose,
        b"datastore" => Dest::DataStore,
        // Destinations that never contribute body text for triage purposes.
        b"footnote" | b"annotation" | b"atnid" | b"atnauthor" | b"atntime" | b"atnicn"
        | b"atnparent" | b"atnref" | b"header" | b"headerl" | b"headerr" | b"headerf"
        | b"footer" | b"footerl" | b"footerr" | b"footerf" | b"ftnsep" | b"ftnsepc"
        | b"ftncont" | b"ftncn" | b"aftnsep" | b"aftnsepc" | b"aftncont" | b"aftncn"
        | b"xe" | b"tc" | b"docvar" | b"keycode" | b"latentstyles" | b"listtable"
        | b"listoverridetable" | b"revtbl" | b"rsidtbl" | b"datafield" | b"themedata"
        | b"colorschememapping" | b"nesttableprops" | b"xmlnstbl" | b"userprops"
        | b"shppict" | b"nonshppict" | b"shpinst" | b"shp" | b"sp" | b"objname"
        | b"objalias" | b"objsect" | b"filesig" | b"osnum" | b"falt" | b"pnseclvl"
        | b"pgdsc" | b"mailmerge" | b"ud" => Dest::Skip,
        _ => {
            if starred {
                Dest::Skip
            } else {
                parent
            }
        }
    }
}

/// One lexer token. Spans reference `input` offsets; nothing is copied.
#[derive(Debug)]
enum Tok {
    Open { at: usize },
    Close { at: usize },
    /// `\name` + optional signed parameter. `name_end` bounds the alphabetic
    /// name; `end` is past an optional single-space delimiter.
    Control { at: usize, name_end: usize, end: usize, param: Option<i64>, long_name: bool },
    /// `\` plus one non-alphabetic byte (`\*`, `\\`, `\{`, `\~`, `\<cr>` ...).
    Symbol { at: usize, ch: u8 },
    /// `\'hh`. `valid=false` marks a malformed escape (not two hex digits);
    /// the offending bytes are not consumed past `\'`.
    Hex { at: usize, byte: u8, valid: bool },
    /// Literal bytes up to the next `{`, `}`, or `\`.
    Text { at: usize, end: usize },
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Read the token at `pos`, returning the token and the next scan position.
/// Never fails: malformed constructs come back as explicit token variants.
fn next_token(input: &[u8], pos: usize) -> (Tok, usize) {
    let byte = input[pos];
    match byte {
        b'{' => (Tok::Open { at: pos }, pos + 1),
        b'}' => (Tok::Close { at: pos }, pos + 1),
        b'\\' => {
            let at = pos;
            let i = pos + 1;
            if i >= input.len() {
                return (Tok::Symbol { at, ch: 0 }, i);
            }
            let c = input[i];
            if c.is_ascii_alphabetic() {
                let name_start = i;
                let mut j = i;
                while j < input.len() && input[j].is_ascii_alphabetic() {
                    j += 1;
                }
                let name_end = j;
                let long_name = name_end - name_start > NAME_CAP;
                // Optional parameter: digits, or '-' followed by digits. A '-'
                // not followed by a digit is a separate control symbol (\-).
                let mut param = None;
                let mut k = j;
                if k < input.len() && input[k] == b'-' && k + 1 < input.len()
                    && input[k + 1].is_ascii_digit()
                {
                    k += 1;
                    let mut v: i64 = 0;
                    while k < input.len() && input[k].is_ascii_digit() {
                        v = v.saturating_mul(10).saturating_add((input[k] - b'0') as i64);
                        k += 1;
                    }
                    param = Some(-v);
                } else if k < input.len() && input[k].is_ascii_digit() {
                    let mut v: i64 = 0;
                    while k < input.len() && input[k].is_ascii_digit() {
                        v = v.saturating_mul(10).saturating_add((input[k] - b'0') as i64);
                        k += 1;
                    }
                    param = Some(v);
                }
                // A single space terminates (and is consumed by) a control
                // word; every other byte stays in the stream.
                if k < input.len() && input[k] == b' ' {
                    k += 1;
                }
                (
                    Tok::Control { at, name_end, end: k, param, long_name },
                    k,
                )
            } else if c == b'\'' {
                // \'<hex><hex>
                if i + 2 < input.len()
                    && hex_value(input[i + 1]).is_some()
                    && hex_value(input[i + 2]).is_some()
                {
                    let byte = (hex_value(input[i + 1]).unwrap() << 4)
                        | hex_value(input[i + 2]).unwrap();
                    (Tok::Hex { at, byte, valid: true }, i + 3)
                } else {
                    (Tok::Hex { at, byte: 0, valid: false }, i + 1)
                }
            } else {
                (Tok::Symbol { at, ch: c }, i + 1)
            }
        }
        _ => {
            let mut j = pos;
            while j < input.len() && !matches!(input[j], b'{' | b'}' | b'\\') {
                j += 1;
            }
            (Tok::Text { at: pos, end: j }, j)
        }
    }
}

/// A captured font-table entry.
pub(crate) struct Font {
    pub index: i64,
    pub name: String,
    pub family: Option<&'static str>,
    pub charset: Option<i64>,
    pub pitch: Option<i64>,
}

/// A captured style-sheet entry.
pub(crate) struct Style {
    pub index: i64,
    pub kind: &'static str,
    pub name: String,
}

/// One `{\colortbl}` entry; `None` channels mark the auto color.
pub(crate) struct Color {
    pub index: usize,
    pub r: Option<i64>,
    pub g: Option<i64>,
    pub b: Option<i64>,
}

/// A `{\pict}` group summary.
pub(crate) struct Pict {
    pub offset: usize,
    pub end: usize,
    pub pic_type: Option<&'static str>,
    pub type_param: Option<i64>,
    pub w: Option<i64>,
    pub h: Option<i64>,
    pub wgoal: Option<i64>,
    pub hgoal: Option<i64>,
    pub bin_bytes: usize,
    pub hex_nibbles: usize,
    pub bad_chars: usize,
}

/// Decoded `\objdata` payload summary. `keep` holds up to
/// `KEEP_PAYLOAD_BYTES` decoded bytes for preview/optional hex dump;
/// `keep_complete` says whether `keep` covers the whole payload.
pub(crate) struct ObjData {
    pub hex_chars: usize,
    pub decoded_bytes: usize,
    pub sha256: String,
    pub preview_hex: String,
    pub ole_magic: bool,
    pub bad_chars: usize,
    pub first_bad_offset: Option<usize>,
    pub odd_hex: bool,
    pub keep: Vec<u8>,
    pub keep_complete: bool,
}

/// A `{\object}` group summary.
pub(crate) struct Obj {
    pub offset: usize,
    pub end: usize,
    pub objtype: Option<&'static str>,
    pub update: bool,
    pub w: Option<i64>,
    pub h: Option<i64>,
    pub scalex: Option<i64>,
    pub scaley: Option<i64>,
    pub objclass: Option<String>,
    pub objdata: Option<ObjData>,
    pub result: Option<(usize, usize)>,
}

/// A `{\*\filetbl}` embedded-file entry.
pub(crate) struct FileEntry {
    pub offset: usize,
    pub fid: Option<i64>,
    pub name: String,
    pub path: Option<String>,
}

/// A captured field instruction (`{\*\fldinst}` / `\instrText`).
pub(crate) struct Field {
    pub offset: usize,
    pub instruction: String,
    pub keyword: String,
    pub url: Option<String>,
}

/// One security finding: kind taxonomy, byte offset, severity, detail.
pub(crate) struct Finding {
    pub kind: &'static str,
    pub offset: usize,
    pub severity: &'static str,
    pub detail: String,
}

/// The bounded document model produced by one scan pass.
pub(crate) struct Doc {
    pub input_len: usize,
    pub sha256: String,
    pub valid_rtf: bool,
    pub rtf_version: Option<i64>,
    pub charset: Option<&'static str>,
    pub codepage: u32,
    pub ansicpg: Option<u32>,
    pub codepages: Vec<u32>,
    pub deff: Option<i64>,
    pub groups_total: usize,
    pub max_depth: usize,
    pub unclosed: usize,
    pub stray_closes: usize,
    pub trailing_bytes: usize,
    pub trailing_offset: Option<usize>,
    pub leading_junk: usize,
    pub controls_total: usize,
    pub control_bytes: usize,
    pub hex_escapes: usize,
    pub hex_runs: usize,
    pub max_hex_run: usize,
    pub frag_regions: usize,
    pub single_char_runs: usize,
    pub bin_blobs: usize,
    pub bin_bytes: usize,
    pub u_chars: usize,
    pub u_anomalies: usize,
    pub text_bytes: usize,
    pub paragraphs: usize,
    pub text: String,
    pub text_stored: usize,
    pub text_total_chars: usize,
    pub text_capped: bool,
    pub skipped_groups: usize,
    pub ignorable_groups: usize,
    pub deep_groups: usize,
    pub over_cap_groups: usize,
    pub histogram: Vec<(String, u64)>,
    pub fonts: Vec<Font>,
    pub fonts_total: usize,
    pub styles: Vec<Style>,
    pub styles_total: usize,
    pub colors: Vec<Color>,
    pub colors_total: usize,
    pub info: Vec<(String, String)>,
    pub info_extra: usize,
    pub generator: Option<String>,
    pub template: Option<String>,
    pub password: Option<String>,
    pub panose: Option<String>,
    pub panose_count: usize,
    pub datastore_count: usize,
    pub datastore_bytes: usize,
    pub picts: Vec<Pict>,
    pub picts_total: usize,
    pub objects: Vec<Obj>,
    pub objects_total: usize,
    pub files: Vec<FileEntry>,
    pub files_total: usize,
    pub fields: Vec<Field>,
    pub fields_total: usize,
    pub findings: Vec<Finding>,
    pub findings_total: usize,
    pub finding_kinds: BTreeMap<&'static str, u64>,
    pub warnings: Vec<String>,
    keep_bytes: usize,
}

impl Doc {
    fn finding(&mut self, kind: &'static str, offset: usize, severity: &'static str, detail: String) {
        *self.finding_kinds.entry(kind).or_insert(0) += 1;
        self.findings_total += 1;
        if self.findings.len() < MAX_FINDINGS {
            self.findings.push(Finding {
                kind,
                offset,
                severity,
                detail: clean(&detail, 512),
            });
        }
    }

    fn warn(&mut self, msg: String) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(msg);
        }
    }
}

/// Streaming `\objdata` hex decoder: validates and decodes the hex text
/// stream, hashes all decoded bytes, and retains the first
/// `KEEP_PAYLOAD_BYTES` for preview/dump. Text offsets are tracked for the
/// first bad character.
struct HexDecoder {
    half: Option<u8>,
    hex_chars: usize,
    decoded: usize,
    hasher: sha2::Sha256,
    keep: Vec<u8>,
    bad_chars: usize,
    first_bad: Option<usize>,
}

impl HexDecoder {
    fn new() -> Self {
        Self {
            half: None,
            hex_chars: 0,
            decoded: 0,
            hasher: sha2::Sha256::new(),
            keep: Vec::new(),
            bad_chars: 0,
            first_bad: None,
        }
    }

    fn feed(&mut self, bytes: &[u8], base: usize) {
        for (i, &b) in bytes.iter().enumerate() {
            match hex_value(b) {
                Some(nib) => {
                    self.hex_chars += 1;
                    match self.half.take() {
                        Some(high) => {
                            let byte = (high << 4) | nib;
                            self.hasher.update([byte]);
                            if self.keep.len() < KEEP_PAYLOAD_BYTES {
                                self.keep.push(byte);
                            }
                            self.decoded += 1;
                        }
                        None => self.half = Some(nib),
                    }
                }
                None => {
                    if matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0b | 0x0c) {
                        continue;
                    }
                    self.bad_chars += 1;
                    if self.first_bad.is_none() {
                        self.first_bad = Some(base + i);
                    }
                }
            }
        }
    }

    fn finish(self) -> ObjData {
        let digest = self.hasher.finalize();
        let preview_len = self.keep.len().min(16);
        ObjData {
            hex_chars: self.hex_chars,
            decoded_bytes: self.decoded,
            sha256: hex(&digest),
            preview_hex: hex(&self.keep[..preview_len]),
            ole_magic: self.keep.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]),
            bad_chars: self.bad_chars,
            first_bad_offset: self.first_bad,
            odd_hex: self.hex_chars % 2 == 1,
            keep_complete: self.keep.len() == self.decoded,
            keep: self.keep,
        }
    }
}

/// Text-bearing capture attached to a destination frame.
enum Capture {
    /// {\info} subgroup: first control is the field name, text is the value,
    /// and \yr\mo\dy\hr\min\sec params arrive for *tim fields. Numeric fields
    /// ({\nofpages7}) carry the value as the name control's parameter.
    InfoField { name: Vec<u8>, param: Option<i64>, value: Vec<u8>, params: Vec<(u8, i64)> },
    /// {\fonttbl} subgroup: \fN index, family controls, name text up to ';'.
    Font { index: i64, family: Option<&'static str>, charset: Option<i64>, pitch: Option<i64>, name: Vec<u8>, alt: bool },
    /// {\stylesheet} subgroup: \sN/\csN/\tsN kind+index, name text up to ';'.
    Style { index: i64, kind: &'static str, name: Vec<u8> },
    /// Raw bounded text slot for single-value destinations.
    Text { slot: Slot, buf: Vec<u8>, total: usize },
    /// Streaming objdata decode.
    ObjData(HexDecoder),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    ObjClass,
    FName,
    FRelative,
    FieldInstr,
    Template,
    Generator,
    Password,
    Panose,
    DataStore,
}

impl Capture {
    fn text_slot(slot: Slot) -> Self {
        Capture::Text { slot, buf: Vec::new(), total: 0 }
    }

    /// Route decoded text into the capture (bounded).
    fn push_str(&mut self, s: &str) {
        match self {
            Capture::InfoField { value, .. } => {
                push_bounded(value, s.as_bytes(), CAPTURE_CAP);
            }
            Capture::Font { name, alt, .. } => {
                if *alt {
                    return;
                }
                if let Some(cut) = s.find(';') {
                    push_bounded(name, s[..cut].as_bytes(), 256);
                    *alt = true; // anything after ';' is ignored
                } else {
                    push_bounded(name, s.as_bytes(), 256);
                }
            }
            Capture::Style { name, .. } => {
                // A ';' terminates the style name; anything past it is ignored.
                if name.last() == Some(&b';') {
                    return;
                }
                match s.find(';') {
                    Some(cut) => push_bounded(name, s[..=cut].as_bytes(), 256),
                    None => push_bounded(name, s.as_bytes(), 256),
                }
            }
            Capture::Text { buf, total, .. } => {
                *total += s.len();
                push_bounded(buf, s.as_bytes(), CAPTURE_CAP);
            }
            Capture::ObjData(_) => {}
        }
    }

    /// Route a control word into the capture context.
    fn on_control(&mut self, name: &[u8], param: Option<i64>) {
        match self {
            Capture::InfoField { name: field, param: first, params, .. } => {
                if field.is_empty() {
                    let cap = name.len().min(32);
                    field.extend_from_slice(&name[..cap]);
                    *first = param;
                } else if params.len() < 16 {
                    // *tim fields: record \yr\mo\dy\hr\min\sec params.
                    match name {
                        b"yr" | b"mo" | b"dy" | b"hr" | b"min" | b"sec" => {
                            if let Some(p) = param {
                                let tag = match name {
                                    b"yr" => 0u8,
                                    b"mo" => 1,
                                    b"dy" => 2,
                                    b"hr" => 3,
                                    b"min" => 4,
                                    _ => 5,
                                };
                                params.push((tag, p));
                            }
                        }
                        _ => {}
                    }
                }
            }
            Capture::Font { family, charset, pitch, alt, .. } => match name {
                b"froman" => *family = Some("roman"),
                b"fswiss" => *family = Some("swiss"),
                b"fmodern" => *family = Some("modern"),
                b"fscript" => *family = Some("script"),
                b"fdecor" => *family = Some("decor"),
                b"ftech" => *family = Some("tech"),
                b"fbidi" => *family = Some("bidi"),
                b"fnil" => *family = Some("nil"),
                b"fcharset" => *charset = param,
                b"fprq" => *pitch = param,
                b"falt" => *alt = true,
                _ => {}
            },
            _ => {}
        }
    }
}

fn push_bounded(buf: &mut Vec<u8>, bytes: &[u8], cap: usize) {
    let room = cap.saturating_sub(buf.len());
    let take = room.min(bytes.len());
    buf.extend_from_slice(&bytes[..take]);
}

/// One open group on the frame stack.
struct Frame {
    dest: Dest,
    resolved: bool,
    starred: bool,
    over: bool,
    open: usize,
    capture: Option<Capture>,
    obj: bool,
    pict: bool,
    file: bool,
}

/// The bounded scanner. All limits are enforced while walking tokens, never
/// after materializing unbounded state.
struct Scanner<'a> {
    input: &'a [u8],
    stack: Vec<Frame>,
    phantom: usize,
    uc: usize,
    skip: usize,
    codepage: u32,
    ansicpg: Option<u32>,
    codepages: Vec<u32>,
    pending: Vec<u8>,
    pending_start: usize,
    cap_depth: Option<usize>,
    objects: Vec<Obj>,
    picts: Vec<Pict>,
    files: Vec<FileEntry>,
    doc: Doc,
    hist: BTreeMap<String, u64>,
    saw_rtf: bool,
    hex_streak: usize,
    hex_streak_start: usize,
    sc_run: usize,
    sc_run_start: usize,
    deep_flagged: bool,
    extreme_flagged: bool,
    overlong_flagged: usize,
    bad_hex_flagged: usize,
    color_pending: (Option<i64>, Option<i64>, Option<i64>),
}

impl<'a> Scanner<'a> {
    fn new(input: &'a [u8]) -> Self {
        let sha = sha2::Sha256::digest(input);
        Scanner {
            input,
            stack: Vec::new(),
            phantom: 0,
            uc: 1,
            skip: 0,
            codepage: 1252,
            ansicpg: None,
            codepages: Vec::new(),
            pending: Vec::new(),
            pending_start: 0,
            cap_depth: None,
            objects: Vec::new(),
            picts: Vec::new(),
            files: Vec::new(),
            doc: Doc {
                input_len: input.len(),
                sha256: hex(&sha),
                valid_rtf: false,
                rtf_version: None,
                charset: None,
                codepage: 1252,
                ansicpg: None,
                codepages: Vec::new(),
                deff: None,
                groups_total: 0,
                max_depth: 0,
                unclosed: 0,
                stray_closes: 0,
                trailing_bytes: 0,
                trailing_offset: None,
                leading_junk: 0,
                controls_total: 0,
                control_bytes: 0,
                hex_escapes: 0,
                hex_runs: 0,
                max_hex_run: 0,
                frag_regions: 0,
                single_char_runs: 0,
                bin_blobs: 0,
                bin_bytes: 0,
                u_chars: 0,
                u_anomalies: 0,
                text_bytes: 0,
                paragraphs: 0,
                text: String::new(),
                text_stored: 0,
                text_total_chars: 0,
                text_capped: false,
                skipped_groups: 0,
                ignorable_groups: 0,
                deep_groups: 0,
                over_cap_groups: 0,
                histogram: Vec::new(),
                fonts: Vec::new(),
                fonts_total: 0,
                styles: Vec::new(),
                styles_total: 0,
                colors: Vec::new(),
                colors_total: 0,
                info: Vec::new(),
                info_extra: 0,
                generator: None,
                template: None,
                password: None,
                panose: None,
                panose_count: 0,
                datastore_count: 0,
                datastore_bytes: 0,
                picts: Vec::new(),
                picts_total: 0,
                objects: Vec::new(),
                objects_total: 0,
                files: Vec::new(),
                files_total: 0,
                fields: Vec::new(),
                fields_total: 0,
                findings: Vec::new(),
                findings_total: 0,
                finding_kinds: BTreeMap::new(),
                warnings: Vec::new(),
                keep_bytes: 0,
            },
            saw_rtf: false,
            hist: BTreeMap::new(),
            hex_streak: 0,
            hex_streak_start: 0,
            sc_run: 0,
            sc_run_start: 0,
            deep_flagged: false,
            extreme_flagged: false,
            overlong_flagged: 0,
            bad_hex_flagged: 0,
            color_pending: (None, None, None),
        }
    }

    fn depth(&self) -> usize {
        self.stack.len() + self.phantom
    }

    /// Finalize a run of consecutive `\'hh` escapes in body text.
    fn end_hex_streak(&mut self) {
        if self.hex_streak >= HEX_RUN_FLAG {
            self.doc.hex_runs += 1;
            let (s, st) = (self.hex_streak, self.hex_streak_start);
            self.doc.finding(
                "hex_heavy_region",
                st,
                "low",
                format!("run of {s} consecutive \\'hh hex escapes"),
            );
        }
        self.hex_streak = 0;
    }

    /// Frames whose contents are still interpreted: inside a tracked,
        /// not-over-deep group (or at document level for global controls).
    fn live(&self) -> bool {
        self.phantom == 0 && self.stack.last().map_or(true, |f| !f.over)
    }

    fn top(&self) -> Option<&Frame> {
        if self.phantom == 0 {
            self.stack.last()
        } else {
            None
        }
    }

    fn top_mut(&mut self) -> Option<&mut Frame> {
        if self.phantom == 0 {
            self.stack.last_mut()
        } else {
            None
        }
    }

    /// Body-text context: inside a tracked live group whose destination is
    /// plain text.
    fn in_text(&self) -> bool {
        self.live() && self.top().map_or(false, |f| f.dest == Dest::Text)
    }

    fn cur_dest(&self) -> Dest {
        self.top().map_or(Dest::Text, |f| f.dest)
    }

    fn record_codepage(&mut self, cp: u32) {
        self.codepage = cp;
        if !self.codepages.contains(&cp) {
            self.codepages.push(cp);
        }
    }

    // ---- emission ------------------------------------------------------

    /// Decode the pending codepage byte run and route it out.
    fn flush_pending(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let bytes = std::mem::take(&mut self.pending);
        let at = self.pending_start;
        let enc = encoding_for(self.codepage);
        let (decoded, _, _) = enc.decode(&bytes);
        let s = decoded.into_owned();
        self.emit_str(&s, at);
    }

    fn emit_bytes(&mut self, bytes: &[u8], at: usize) {
        if self.pending.is_empty() {
            self.pending_start = at;
        }
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > PENDING_CAP {
            self.flush_pending();
        }
    }

    /// Route a decoded string: innermost capture wins; body text next; other
    /// destinations drop it (it is not body text).
    fn emit_str(&mut self, s: &str, at: usize) {
        if let Some(cd) = self.cap_depth {
            if let Some(frame) = self.stack.get_mut(cd) {
                if let Some(cap) = frame.capture.as_mut() {
                    match cap {
                        Capture::ObjData(dec) => dec.feed(s.as_bytes(), at),
                        _ => cap.push_str(s),
                    }
                }
            }
            return;
        }
        if self.in_text() {
            let doc = &mut self.doc;
            for c in s.chars() {
                doc.text_total_chars += 1;
                if doc.text_stored < MAX_TEXT_CHARS {
                    doc.text.push(c);
                    doc.text_stored += 1;
                }
            }
            doc.text_capped = doc.text_total_chars > MAX_TEXT_CHARS;
        }
    }

    fn emit_char(&mut self, c: char) {
        let mut buf = [0u8; 4];
        let s = c.encode_utf8(&mut buf);
        let at = self.pending_start;
        self.emit_str(s, at);
    }

    // ---- group handling -------------------------------------------------

    fn on_open(&mut self, at: usize) {
        // A nested group as first content resolves the parent as
        // non-destination (destinations start with a control word).
        if self.live() {
            // A nested group as first content resolves the parent as
            // non-destination (destinations start with a control word).
            self.resolve_text();
        }
        self.doc.groups_total += 1;
        let depth = self.depth() + 1;
        if depth > self.doc.max_depth {
            self.doc.max_depth = depth;
        }
        if depth > DEPTH_FLAG {
            self.doc.deep_groups += 1;
            if !self.deep_flagged {
                self.deep_flagged = true;
                self.doc.finding(
                    "deep_nesting",
                    at,
                    "low",
                    format!("group nesting exceeds {} levels (depth {})", DEPTH_FLAG, depth),
                );
            }
        }
        let over = depth > MAX_GROUP_DEPTH;
        if over {
            self.doc.over_cap_groups += 1;
            if !self.extreme_flagged {
                self.extreme_flagged = true;
                self.doc.finding(
                    "extreme_nesting",
                    at,
                    "medium",
                    format!("group nesting exceeds {} levels; deeper content is scanned but not interpreted", MAX_GROUP_DEPTH),
                );
            }
        }
        if self.stack.len() < MAX_TRACKED_DEPTH {
            let parent = self.cur_dest();
            self.stack.push(Frame {
                dest: parent,
                resolved: false,
                starred: false,
                over,
                open: at,
                capture: None,
                obj: false,
                pict: false,
                file: false,
            });
        } else {
            self.phantom += 1;
        }
    }

    fn on_close(&mut self, at: usize) {
        if self.phantom > 0 {
            self.phantom -= 1;
            return;
        }
        let Some(frame) = self.stack.pop() else {
            self.doc.stray_closes += 1;
            self.doc.finding(
                "stray_closing_brace",
                at,
                "low",
                "closing brace without a matching open".to_string(),
            );
            return;
        };
        // Recalculate the innermost capture position.
        self.cap_depth = self
            .stack
            .iter()
            .rposition(|f| f.capture.is_some());

        if let Some(cap) = frame.capture {
            self.commit(cap, frame.open, at);
        }
        if frame.pict {
            if let Some(mut p) = self.picts.pop() {
                p.end = at + 1;
                if self.doc.picts.len() < MAX_PICTS {
                    self.doc.picts.push(p);
                }
            }
        }
        if frame.obj {
            if let Some(mut o) = self.objects.pop() {
                o.end = at + 1;
                // Result-group byte span was recorded on its own close.
                if let Some(od) = o.objdata.as_ref() {
                    if od.ole_magic {
                        self.doc.finding(
                            "ole_compound_object",
                            frame.open,
                            "high",
                            format!(
                                "object at {} embeds an OLE compound file ({} decoded bytes)",
                                frame.open, od.decoded_bytes
                            ),
                        );
                    }
                    if od.bad_chars > 0 || od.odd_hex {
                        self.doc.finding(
                            "malformed_objdata",
                            frame.open,
                            "medium",
                            format!(
                                "objdata stream has {} non-hex characters{}",
                                od.bad_chars,
                                if od.odd_hex { " and odd hex length" } else { "" }
                            ),
                        );
                    }
                }
                if let Some(class) = o.objclass.as_deref() {
                    if let Some(sev) = suspicious_objclass(class) {
                        self.doc.finding(
                            "suspicious_objclass",
                            frame.open,
                            sev,
                            format!("object class \"{class}\" is a known exploit-container indicator"),
                        );
                    }
                }
                self.doc.objects_total += 1;
                if self.doc.objects.len() < MAX_OBJECTS {
                    // Retain payload bytes inside the aggregate budget.
                    if let Some(od) = o.objdata.as_mut() {
                        if self.doc.keep_bytes + od.keep.len() > KEEP_TOTAL_BYTES {
                            od.keep = Vec::new();
                            od.keep_complete = false;
                        } else {
                            self.doc.keep_bytes += od.keep.len();
                        }
                    }
                    self.doc.objects.push(o);
                }
            }
        }
        if frame.file {
            if let Some(mut fe) = self.files.pop() {
                fe.offset = frame.open;
                self.doc.files_total += 1;
                if self.doc.files.len() < MAX_FILES {
                    self.doc.finding(
                        "embedded_file",
                        frame.open,
                        "medium",
                        format!(
                            "file table embeds \"{}\"{}",
                            fe.name,
                            fe.path.as_deref().map_or(String::new(), |p| format!(" ({})", clean(p, 128)))
                        ),
                    );
                    self.doc.files.push(fe);
                }
            }
        }
        if frame.dest == Dest::Result {
            // Record the result extent on the enclosing object.
            if let Some(o) = self.objects.last_mut() {
                if o.result.is_none() {
                    o.result = Some((frame.open, at + 1));
                }
            }
        }
        if self.stack.is_empty() && self.doc.trailing_offset.is_none() {
            self.doc.trailing_offset = Some(at + 1);
        }
    }

    /// Resolve a group's destination from its first control word.
    fn resolve(&mut self, name: &[u8], param: Option<i64>) {
        let idx = self.stack.len() - 1;
        let parent = if idx > 0 { self.stack[idx - 1].dest } else { Dest::Text };
        let starred = self.stack[idx].starred;
        let open = self.stack[idx].open;
        self.stack[idx].resolved = true;

        // Parent-kind captures run before generic destination resolution so
        // {\*\cs10 ...} char styles and info subgroups work.
        if parent == Dest::FontTbl && name == b"f" {
            self.stack[idx].capture = Some(Capture::Font {
                index: param.unwrap_or(0),
                family: None,
                charset: None,
                pitch: None,
                name: Vec::new(),
                alt: false,
            });
            self.doc.fonts_total += 1;
            self.doc.skipped_groups += 1;
            if starred {
                self.doc.ignorable_groups += 1;
            }
            self.cap_depth = Some(idx);
            return;
        }
        if parent == Dest::StyleSheet {
            if let Some(kind) = style_kind(name) {
                self.stack[idx].capture = Some(Capture::Style {
                    index: param.unwrap_or(0),
                    kind,
                    name: Vec::new(),
                });
                self.doc.styles_total += 1;
                self.doc.skipped_groups += 1;
                if starred {
                    self.doc.ignorable_groups += 1;
                }
                self.cap_depth = Some(idx);
                return;
            }
        }
        if parent == Dest::Info && !starred {
            let mut fname = Vec::new();
            fname.extend_from_slice(&name[..name.len().min(32)]);
            self.stack[idx].capture = Some(Capture::InfoField {
                name: fname,
                param,
                value: Vec::new(),
                params: Vec::new(),
            });
            self.doc.skipped_groups += 1;
            self.cap_depth = Some(idx);
            return;
        }

        let dest = dest_kind(name, starred, parent);
        self.stack[idx].dest = dest;
        if starred {
            self.doc.ignorable_groups += 1;
        }
        if dest != Dest::Text {
            self.doc.skipped_groups += 1;
        }
        match dest {
            Dest::Object => {
                self.stack[idx].obj = true;
                self.objects.push(Obj {
                    offset: open,
                    end: 0,
                    objtype: None,
                    update: false,
                    w: None,
                    h: None,
                    scalex: None,
                    scaley: None,
                    objclass: None,
                    objdata: None,
                    result: None,
                });
            }
            Dest::Pict => {
                self.stack[idx].pict = true;
                self.picts.push(Pict {
                    offset: open,
                    end: 0,
                    pic_type: None,
                    type_param: None,
                    w: None,
                    h: None,
                    wgoal: None,
                    hgoal: None,
                    bin_bytes: 0,
                    hex_nibbles: 0,
                    bad_chars: 0,
                });
                self.doc.picts_total += 1;
            }
            Dest::File => {
                self.stack[idx].file = true;
                self.files.push(FileEntry {
                    offset: open,
                    fid: None,
                    name: String::new(),
                    path: None,
                });
            }
            Dest::ObjData => {
                self.stack[idx].capture = Some(Capture::ObjData(HexDecoder::new()));
                self.cap_depth = Some(idx);
                self.doc.finding(
                    "objdata_payload",
                    open,
                    "medium",
                    "group carries a \\objdata hex-encoded object payload".to_string(),
                );
            }
            Dest::ObjClass => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::ObjClass));
                self.cap_depth = Some(idx);
            }
            Dest::FName => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::FName));
                self.cap_depth = Some(idx);
            }
            Dest::FRelative => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::FRelative));
                self.cap_depth = Some(idx);
            }
            Dest::FldInst => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::FieldInstr));
                self.cap_depth = Some(idx);
            }
            Dest::Template => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::Template));
                self.cap_depth = Some(idx);
            }
            Dest::Generator => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::Generator));
                self.cap_depth = Some(idx);
            }
            Dest::Password => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::Password));
                self.cap_depth = Some(idx);
                self.doc.finding(
                    "password_protection",
                    open,
                    "low",
                    "document declares a \\password protection hash (obfuscation marker, not encryption)".to_string(),
                );
            }
            Dest::Panose => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::Panose));
                self.cap_depth = Some(idx);
            }
            Dest::DataStore => {
                self.stack[idx].capture = Some(Capture::text_slot(Slot::DataStore));
                self.cap_depth = Some(idx);
                self.doc.finding(
                    "datastore",
                    open,
                    "low",
                    "group carries a \\*\\datastore data block (common ActiveX/POSH storage)".to_string(),
                );
            }
            Dest::FileTbl => {
                self.doc.finding(
                    "file_table",
                    open,
                    "medium",
                    "document has a \\*\\filetbl embedded-file table".to_string(),
                );
            }
            _ => {}
        }
    }

    /// Resolve a group whose first content is plain text (or a control
    /// symbol other than `\*`): text-bearing unless `\*`-starred.
    fn resolve_text(&mut self) {
        if let Some(f) = self.top_mut() {
            if !f.resolved {
                f.resolved = true;
                if f.starred {
                    f.dest = Dest::Skip;
                    self.doc.ignorable_groups += 1;
                    self.doc.skipped_groups += 1;
                }
            }
        }
    }

    // ---- tokens ---------------------------------------------------------

    fn on_control(&mut self, at: usize, name_end: usize, end: usize, param: Option<i64>, long_name: bool, pos_after: usize) -> usize {
        let name = &self.input[at + 1..name_end];
        self.doc.controls_total += 1;
        self.doc.control_bytes += end - at;

        // Histogram and name stats are pure scanning: record them even in
        // suppressed regions.
        let key = if name.len() > NAME_CAP {
            String::from_utf8_lossy(&name[..NAME_CAP]).into_owned()
        } else {
            String::from_utf8_lossy(name).into_owned()
        };
        *self.hist.entry(key).or_insert(0) += 1;

        if !self.live() {
            // \bin must still skip its raw bytes to keep the stream synced.
            if name == b"bin" {
                if let Some(n) = param {
                    if n > 0 {
                        return self.skip_binary(pos_after, n as usize, at);
                    }
                }
            }
            return pos_after;
        }

        // Destination resolution: this control is the group's first content.
        if self.top().map_or(false, |f| !f.resolved) {
            self.resolve(name, param);
        }

        // Single-letter control-run fragmentation signal.
        if name.len() == 1 {
            if self.sc_run == 0 {
                self.sc_run_start = at;
            }
            self.sc_run += 1;
            if self.sc_run == SINGLE_CHAR_RUN_FLAG {
                self.doc.single_char_runs += 1;
                self.doc.finding(
                    "control_fragmentation",
                    self.sc_run_start,
                    "low",
                    format!("run of {} consecutive single-letter control words", self.sc_run),
                );
            }
        } else {
            self.sc_run = 0;
        }

        if long_name && self.overlong_flagged < 4 {
            self.overlong_flagged += 1;
            self.doc.finding(
                "overlong_control_name",
                at,
                "info",
                format!("control-word name exceeds {} bytes (possible fuzzing)", NAME_CAP),
            );
        }

        match name {
            b"u" => {
                self.flush_pending();
                self.doc.u_chars += 1;
                let mut n = param.unwrap_or(0);
                if n < 0 {
                    n += 65536;
                }
                match u32::try_from(n).ok().and_then(char::from_u32) {
                    Some(c) if (0..=0xffff).contains(&n) => self.emit_char(c),
                    _ => {
                        self.doc.u_anomalies += 1;
                        self.doc.finding(
                            "unicode_anomaly",
                            at,
                            "low",
                            format!("\\u{param:?} resolves outside the BMP scalar range"),
                        );
                        self.emit_char('\u{FFFD}');
                    }
                }
                self.skip = self.uc;
            }
            b"uc" => {
                self.uc = param.unwrap_or(1).clamp(0, 64) as usize;
            }
            b"bin" => {
                if let Some(n) = param {
                    if n > 0 {
                        return self.skip_binary(end, n as usize, at);
                    }
                }
            }
            b"rtf" => {
                if self.stack.len() == 1 && self.doc.groups_total == 1 && !self.saw_rtf {
                    self.saw_rtf = true;
                    self.doc.rtf_version = param;
                    if param != Some(1) {
                        self.doc.finding(
                            "unusual_rtf_version",
                            at,
                            "info",
                            format!("\\rtf parameter is {param:?} (expected 1)"),
                        );
                    }
                }
            }
            b"ansi" => {
                self.doc.charset.get_or_insert("ansi");
                if self.ansicpg.is_none() {
                    self.record_codepage(1252);
                }
            }
            b"mac" => {
                self.doc.charset = Some("mac");
                if self.ansicpg.is_none() {
                    self.record_codepage(10000);
                }
            }
            b"pc" => {
                self.doc.charset = Some("pc");
                if self.ansicpg.is_none() {
                    self.record_codepage(437);
                }
            }
            b"pca" => {
                self.doc.charset = Some("pca");
                if self.ansicpg.is_none() {
                    self.record_codepage(850);
                }
            }
            b"ansicpg" => {
                if let Some(cp) = param {
                    if (0..=65535).contains(&cp) {
                        self.ansicpg = Some(cp as u32);
                        self.doc.ansicpg = Some(cp as u32);
                        self.record_codepage(cp as u32);
                    }
                }
            }
            b"deff" => self.doc.deff = param,
            b"par" | b"line" | b"page" | b"row" | b"sect" => {
                self.flush_pending();
                self.doc.paragraphs += 1;
                self.emit_char('\n');
            }
            b"tab" => {
                self.flush_pending();
                self.emit_char('\t');
            }
            b"emdash" => {
                self.flush_pending();
                self.emit_char('\u{2014}');
            }
            b"endash" => {
                self.flush_pending();
                self.emit_char('\u{2013}');
            }
            b"emspace" | b"enspace" | b"qmspace" => {
                self.flush_pending();
                self.emit_char(' ');
            }
            b"bullet" => {
                self.flush_pending();
                self.emit_char('\u{2022}');
            }
            b"lquote" => {
                self.flush_pending();
                self.emit_char('\u{2018}');
            }
            b"rquote" => {
                self.flush_pending();
                self.emit_char('\u{2019}');
            }
            b"ldblquote" => {
                self.flush_pending();
                self.emit_char('\u{201C}');
            }
            b"rdblquote" => {
                self.flush_pending();
                self.emit_char('\u{201D}');
            }
            b"zwj" => {
                self.flush_pending();
                self.emit_char('\u{200D}');
            }
            b"zwnj" => {
                self.flush_pending();
                self.emit_char('\u{200C}');
            }
            b"ltrmark" | b"rtlmark" => {
                self.flush_pending();
                self.emit_char('\u{200E}');
            }
            _ => {
                // Destination-scoped parameter routing.
                match self.cur_dest() {
                    Dest::Object => self.object_control(name, param),
                    Dest::Pict => self.pict_control(name, param),
                    Dest::ColorTbl => self.color_control(name, param),
                    Dest::File => {
                        if name == b"fid" {
                            if let Some(f) = self.files.last_mut() {
                                f.fid = param;
                            }
                        }
                    }
                    _ => {}
                }
                if let Some(cd) = self.cap_depth {
                    if let Some(frame) = self.stack.get_mut(cd) {
                        if let Some(cap) = frame.capture.as_mut() {
                            cap.on_control(name, param);
                        }
                    }
                }
            }
        }
        pos_after
    }

    fn object_control(&mut self, name: &[u8], param: Option<i64>) {
        let Some(obj) = self.objects.last_mut() else { return };
        match name {
            b"objemb" => obj.objtype = Some("emb"),
            b"objlink" => obj.objtype = Some("link"),
            b"objautlink" => obj.objtype = Some("autlink"),
            b"objocx" => obj.objtype = Some("ocx"),
            b"objhtml" => obj.objtype = Some("html"),
            b"objxmlst" => obj.objtype = Some("xmlst"),
            b"objupdate" => obj.update = true,
            b"objw" => obj.w = param,
            b"objh" => obj.h = param,
            b"objscalex" => obj.scalex = param,
            b"objscaley" => obj.scaley = param,
            _ => {}
        }
    }

    fn pict_control(&mut self, name: &[u8], param: Option<i64>) {
        let Some(p) = self.picts.last_mut() else { return };
        match name {
            b"emfblip" | b"pngblip" | b"jpegblip" | b"macpict" | b"os2metafile"
            | b"wmetafile" | b"dibitmap" | b"wbitmap" | b"ppbitmap" => {
                if p.pic_type.is_none() {
                    p.pic_type = Some(match name {
                        b"emfblip" => "emfblip",
                        b"pngblip" => "pngblip",
                        b"jpegblip" => "jpegblip",
                        b"macpict" => "macpict",
                        b"os2metafile" => "os2metafile",
                        b"wmetafile" => "wmetafile",
                        b"dibitmap" => "dibitmap",
                        b"wbitmap" => "wbitmap",
                        _ => "ppbitmap",
                    });
                    p.type_param = param;
                }
            }
            b"picw" => p.w = param,
            b"pich" => p.h = param,
            b"picwgoal" => p.wgoal = param,
            b"pichgoal" => p.hgoal = param,
            _ => {}
        }
    }

    fn color_control(&mut self, name: &[u8], param: Option<i64>) {
        match name {
            b"red" => self.color_pending.0 = param,
            b"green" => self.color_pending.1 = param,
            b"blue" => self.color_pending.2 = param,
            _ => {}
        }
    }

    /// `\binN` — the next N raw bytes are binary data and must not be
    /// tokenized (they may contain braces/backslashes).
    fn skip_binary(&mut self, start: usize, n: usize, at: usize) -> usize {
        let avail = self.input.len().saturating_sub(start);
        let take = n.min(avail);
        self.doc.bin_blobs += 1;
        self.doc.bin_bytes += take;
        if self.cur_dest() == Dest::Pict {
            if let Some(p) = self.picts.last_mut() {
                p.bin_bytes += take;
            }
        }
        if take < n {
            self.doc.warn(format!("\\bin{n} at {at} runs past end of input ({take} available)"));
        }
        self.doc.finding(
            "binary_blob",
            at,
            "medium",
            format!("\\bin{n} embeds {take} raw bytes at offset {start}"),
        );
        start + take
    }

    fn on_symbol(&mut self, at: usize, ch: u8) {
        if !self.live() {
            return;
        }
        // Resolve pending groups on the first meaningful symbol.
        let unresolved = self.top().map_or(false, |f| !f.resolved);
        if unresolved {
            if ch == b'*' {
                if let Some(f) = self.top_mut() {
                    f.starred = true;
                }
                return;
            }
            self.resolve_text();
        }
        self.sc_run = 0;
        match ch {
            b'{' | b'}' | b'\\' => {
                self.flush_pending();
                self.emit_char(ch as char);
            }
            b'~' => {
                self.flush_pending();
                self.emit_char('\u{00A0}');
            }
            b'-' => {} // optional hyphen: invisible
            b'_' => {
                self.flush_pending();
                self.emit_char('-');
            }
            b'|' | b':' | b'!' => {}
            b'+' => {
                self.flush_pending();
                self.emit_char('\t');
            }
            b'\n' | b'\r' => {
                // \<newline> is a \par equivalent.
                self.flush_pending();
                self.doc.paragraphs += 1;
                self.emit_char('\n');
            }
            b'*' => {} // stray \* outside group-head position: ignorable marker
            _ => {}
        }
        let _ = at;
    }

    fn on_hex(&mut self, at: usize, byte: u8, valid: bool) {
        if self.skip > 0 {
            self.skip -= 1;
            return;
        }
        if !self.live() {
            return;
        }
        // Malformed \'hh: the \' was consumed; flag a bounded count.
        if !valid {
            if self.bad_hex_flagged < 8 {
                self.bad_hex_flagged += 1;
                self.doc.finding(
                    "malformed_hex_escape",
                    at,
                    "info",
                    "\\' not followed by two hex digits".to_string(),
                );
            }
            return;
        }
        match self.cur_dest() {
            Dest::ObjData => {
                if let Some(cd) = self.cap_depth {
                    if let Some(Capture::ObjData(dec)) =
                        self.stack.get_mut(cd).and_then(|f| f.capture.as_mut())
                    {
                        dec.feed(&[byte], at);
                    }
                }
            }
            Dest::Text => {
                if self.top().map_or(false, |f| !f.resolved) {
                    self.resolve_text();
                }
                self.doc.hex_escapes += 1;
                if self.hex_streak == 0 {
                    self.hex_streak_start = at;
                }
                self.hex_streak += 1;
                if self.hex_streak > self.doc.max_hex_run {
                    self.doc.max_hex_run = self.hex_streak;
                }
                self.emit_bytes(&[byte], at);
            }
            _ => {
                // Inside a capture destination the decoded byte routes to the
                // capture; otherwise it is dropped.
                self.emit_bytes(&[byte], at);
            }
        }
    }

    fn on_text(&mut self, at: usize, end: usize) {
        let bytes = &self.input[at..end];
        // Resolve pending group heads and track document-level junk.
        if self.top().is_none() {
            if self.doc.groups_total == 0 {
                self.doc.leading_junk += bytes.iter().filter(|b| !b.is_ascii_whitespace()).count();
            }
            return;
        }
        if self.top().map_or(false, |f| !f.resolved) {
            if bytes.iter().all(|b| b.is_ascii_whitespace()) {
                return; // whitespace before the destination marker
            }
            self.resolve_text();
        }
        if !self.live() {
            return;
        }
        match self.cur_dest() {
            Dest::ObjData => {
                if let Some(cd) = self.cap_depth {
                    if let Some(Capture::ObjData(dec)) =
                        self.stack.get_mut(cd).and_then(|f| f.capture.as_mut())
                    {
                        dec.feed(bytes, at);
                    }
                }
            }
            Dest::Pict => {
                if let Some(p) = self.picts.last_mut() {
                    for &b in bytes {
                        if hex_value(b).is_some() {
                            p.hex_nibbles += 1;
                        } else if !b.is_ascii_whitespace() {
                            p.bad_chars += 1;
                        }
                    }
                }
            }
            Dest::ColorTbl => {
                for &b in bytes {
                    if b == b';' {
                        let (r, g, bl) = self.color_pending;
                        self.doc.colors_total += 1;
                        if self.doc.colors.len() < MAX_COLORS {
                            self.doc.colors.push(Color {
                                index: self.doc.colors_total - 1,
                                r,
                                g,
                                b: bl,
                            });
                        }
                        self.color_pending = (None, None, None);
                    }
                }
            }
            Dest::Text => {
                // \uN fallback: skip uc bytes before treating the rest as text.
                let mut body = bytes;
                let mut base = at;
                if self.skip > 0 {
                    let take = self.skip.min(body.len());
                    self.skip -= take;
                    body = &body[take..];
                    base += take;
                    if body.is_empty() {
                        return;
                    }
                }
                self.doc.text_bytes += body.len();
                self.fragmentation_check(body, base);
                self.emit_bytes(body, base);
            }
            _ => {
                // Captured or skipped destination: decoded text routes to the
                // innermost capture if one is active.
                if self.skip > 0 {
                    let take = self.skip.min(bytes.len());
                    self.skip -= take;
                    if take >= bytes.len() {
                        return;
                    }
                    self.emit_bytes(&bytes[take..], at + take);
                } else {
                    self.emit_bytes(bytes, at);
                }
            }
        }
    }

    /// Whitespace-obfuscation detector: a single text token split into many
    /// one-or-two-character pieces by single spaces (`o b j e c t`) flags
    /// a `fragmented_text` finding once per region.
    fn fragmentation_check(&mut self, bytes: &[u8], at: usize) {
        if bytes.len() < 11 {
            return;
        }
        let pieces: Vec<&[u8]> = bytes.split(|b| *b == b' ').collect();
        if pieces.len() < FRAG_SPLIT_FLAG {
            return;
        }
        let short = pieces.iter().filter(|p| !p.is_empty() && p.len() <= 2).count();
        if pieces.iter().all(|p| !p.is_empty()) && short * 4 >= pieces.len() * 3 {
            self.doc.frag_regions += 1;
            self.doc.finding(
                "fragmented_text",
                at,
                "low",
                format!(
                    "text run splits into {} tiny pieces separated by spaces (whitespace obfuscation)",
                    pieces.len()
                ),
            );
        }
    }

    /// Commit a closed frame's capture into the document model.
    fn commit(&mut self, cap: Capture, open: usize, close: usize) {
        match cap {
            Capture::InfoField { name, param, value, params } => {
                let field = String::from_utf8_lossy(&name).into_owned();
                // *tim fields render from \yr\mo\dy\hr\min\sec params; numeric
                // fields carry their value as the name control's parameter;
                // the rest use their text.
                let rendered = if field.ends_with("tim") {
                    format_tim(&params)
                } else if value.is_empty() {
                    param.map(|p| p.to_string()).unwrap_or_default()
                } else {
                    String::from_utf8_lossy(&value).into_owned()
                };
                if self.doc.info.len() < MAX_INFO_FIELDS {
                    self.doc.info.push((field, clean(&rendered, 512)));
                } else {
                    self.doc.info_extra += 1;
                }
            }
            Capture::Font { index, family, charset, pitch, name, .. } => {
                if self.doc.fonts.len() < MAX_FONTS {
                    self.doc.fonts.push(Font {
                        index,
                        name: clean(&String::from_utf8_lossy(&name), 128),
                        family,
                        charset,
                        pitch,
                    });
                }
            }
            Capture::Style { index, kind, name } => {
                if self.doc.styles.len() < MAX_STYLES {
                    let mut n = name;
                    if n.last() == Some(&b';') {
                        n.pop();
                    }
                    self.doc.styles.push(Style {
                        index,
                        kind,
                        name: clean(&String::from_utf8_lossy(&n), 128),
                    });
                }
            }
            Capture::ObjData(dec) => {
                let result = dec.finish();
                match self.objects.last_mut() {
                    Some(obj) => obj.objdata = Some(result),
                    None => self
                        .doc
                        .warn(format!("\\objdata at {open} outside any \\object group")),
                }
            }
            Capture::Text { slot, buf, total } => match slot {
                Slot::ObjClass => {
                    if let Some(obj) = self.objects.last_mut() {
                        obj.objclass = Some(clean(&String::from_utf8_lossy(&buf).trim().to_string(), 256));
                    }
                }
                Slot::FName => {
                    if let Some(f) = self.files.last_mut() {
                        f.name = clean(&String::from_utf8_lossy(&buf).trim().to_string(), 256);
                    }
                }
                Slot::FRelative => {
                    if let Some(f) = self.files.last_mut() {
                        f.path = Some(clean(&String::from_utf8_lossy(&buf).trim().to_string(), 512));
                    }
                }
                Slot::FieldInstr => {
                    let instruction =
                        clean(&String::from_utf8_lossy(&buf).trim().to_string(), MAX_STRING_CHARS);
                    self.doc.fields_total += 1;
                    let keyword = instruction
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
                        .to_ascii_uppercase();
                    let url = extract_url(&instruction);
                    let (kind, severity) = field_finding(&keyword, url.is_some());
                    self.doc.finding(kind, open, severity, {
                        let mut d = format!("field instruction {keyword}");
                        if let Some(u) = &url {
                            d.push_str(&format!(" references {}", clean(u, 200)));
                        }
                        d.push_str(&format!(" ({} chars)", total));
                        d
                    });
                    if self.doc.fields.len() < MAX_FIELDS {
                        self.doc.fields.push(Field {
                            offset: open,
                            instruction,
                            keyword,
                            url,
                        });
                    }
                }
                Slot::Template => {
                    let path = clean(&String::from_utf8_lossy(&buf).trim().to_string(), 512);
                    let remote = path.contains("://") || path.starts_with("\\\\");
                    self.doc.finding(
                        "template_path",
                        open,
                        if remote { "high" } else { "medium" },
                        format!("document references template \"{path}\""),
                    );
                    self.doc.template = Some(path);
                }
                Slot::Generator => {
                    self.doc.generator =
                        Some(clean(&String::from_utf8_lossy(&buf).trim().to_string(), 256));
                }
                Slot::Password => {
                    self.doc.password =
                        Some(clean(&String::from_utf8_lossy(&buf).trim().to_string(), 128));
                }
                Slot::Panose => {
                    self.doc.panose_count += 1;
                    if self.doc.panose.is_none() {
                        self.doc.panose =
                            Some(clean(&String::from_utf8_lossy(&buf).trim().to_string(), 64));
                    }
                }
                Slot::DataStore => {
                    self.doc.datastore_count += 1;
                    self.doc.datastore_bytes += total;
                }
            },
        }
        let _ = close;
    }

    /// End-of-scan finalization: balance, trailing data, aggregate findings.
    fn finish(mut self, last_pos: usize) -> Doc {
        self.flush_pending();
        // Hex-streak tail.
        self.end_hex_streak();
        let mut doc = self.doc;
        doc.valid_rtf = self.saw_rtf;
        doc.codepage = self.codepage;
        doc.codepages = self.codepages.clone();
        doc.unclosed = self.stack.len() + self.phantom;
        if doc.unclosed > 0 {
            doc.finding(
                "unbalanced_braces",
                last_pos,
                "medium",
                format!("{} group(s) left open at end of input", doc.unclosed),
            );
        }
        if !self.saw_rtf {
            doc.finding(
                "missing_rtf_header",
                0,
                "info",
                "input does not begin with a {\\rtfN group (fragment or non-RTF data)".to_string(),
            );
        }
        if doc.leading_junk > 0 {
            doc.finding(
                "leading_data",
                0,
                "info",
                format!("{} non-whitespace byte(s) precede the first group", doc.leading_junk),
            );
        }
        if let Some(off) = doc.trailing_offset {
            doc.trailing_bytes = doc.input_len.saturating_sub(off);
            if doc.trailing_bytes > 0 {
                doc.finding(
                    "trailing_data",
                    off,
                    if doc.trailing_bytes > 64 { "medium" } else { "low" },
                    format!("{} byte(s) follow the outermost group", doc.trailing_bytes),
                );
            }
        }
        if doc.codepages.len() > 1 {
            doc.finding(
                "mixed_encodings",
                0,
                "info",
                format!("document declares multiple code pages: {:?}", doc.codepages),
            );
        }
        if doc.hex_escapes > HEX_TOTAL_FLAG {
            doc.finding(
                "hex_obfuscation",
                0,
                "medium",
                format!("{} \\'hh escapes in body text (hex-encoded content)", doc.hex_escapes),
            );
        }
        if doc.ignorable_groups > IGNORABLE_FLAG {
            doc.finding(
                "excess_ignorable_groups",
                0,
                "low",
                format!("{} ignorable {{\\*\\...}} destination groups", doc.ignorable_groups),
            );
        }
        if doc.input_len > 0 && doc.controls_total * 1024 / doc.input_len > DENSITY_FLAG {
            doc.finding(
                "control_density",
                0,
                "low",
                format!(
                    "{} control words ({:.1} per KiB) — extreme control-word density",
                    doc.controls_total,
                    doc.controls_total as f64 * 1024.0 / doc.input_len as f64
                ),
            );
        }
        // Materialize the histogram: count desc, name asc.
        let mut hist: Vec<(String, u64)> = self.hist.into_iter().collect();
        hist.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        doc.histogram = hist;
        doc
    }
}

/// Run the bounded single-pass scan over `input`.
pub(crate) fn scan(input: &[u8]) -> Doc {
    let mut sc = Scanner::new(input);
    let mut pos = 0usize;
    while pos < input.len() {
        let (tok, next) = next_token(input, pos);
        match tok {
            Tok::Open { at } => {
                sc.flush_pending();
                sc.end_hex_streak();
                sc.sc_run = 0;
                sc.on_open(at);
            }
            Tok::Close { at } => {
                sc.flush_pending();
                sc.end_hex_streak();
                sc.sc_run = 0;
                sc.on_close(at);
            }
            Tok::Control { at, name_end, end, param, long_name } => {
                sc.flush_pending();
                sc.end_hex_streak();
                pos = sc.on_control(at, name_end, end, param, long_name, next);
                continue;
            }
            Tok::Symbol { at, ch } => {
                sc.flush_pending();
                sc.end_hex_streak();
                sc.sc_run = 0;
                sc.on_symbol(at, ch);
            }
            Tok::Hex { at, byte, valid } => {
                sc.on_hex(at, byte, valid);
            }
            Tok::Text { at, end } => {
                // A non-whitespace text run ends a single-letter control run;
                // hex escapes do not break the streak.
                if !input[at..end].iter().all(|b| b.is_ascii_whitespace()) {
                    sc.sc_run = 0;
                    sc.end_hex_streak();
                }
                sc.on_text(at, end);
            }
        }
        pos = next;
    }
    sc.finish(input.len())
}

/// `\sN`/`\csN`/`\tsN` style-entry kinds.
fn style_kind(name: &[u8]) -> Option<&'static str> {
    match name {
        b"s" => Some("paragraph"),
        b"cs" => Some("character"),
        b"ts" => Some("table"),
        b"ds" => Some("section"),
        _ => None,
    }
}

/// Format {\*\*tim} params (`\yr\mo\dy\hr\min\sec`) as ISO-ish text.
fn format_tim(params: &[(u8, i64)]) -> String {
    let get = |tag: u8| params.iter().find(|(t, _)| *t == tag).map(|(_, v)| *v);
    let (y, mo, d, h, mi, s) = (get(0), get(1), get(2), get(3), get(4), get(5));
    if y.is_none() && mo.is_none() && d.is_none() {
        return String::new();
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y.unwrap_or(0),
        mo.unwrap_or(0),
        d.unwrap_or(0),
        h.unwrap_or(0),
        mi.unwrap_or(0),
        s.unwrap_or(0)
    )
}

/// OLE Package / known exploit-container class names.
fn suspicious_objclass(class: &str) -> Option<&'static str> {
    let c = class.trim().to_ascii_lowercase();
    let c = c.as_str();
    if c == "package" || c == "ole2link" || c == "objectpool" || c.starts_with("package") {
        Some("high")
    } else if c.starts_with("equation") || c.contains("equation.") || c == "equinography" {
        Some("medium")
    } else if c.starts_with("word.document") || c.starts_with("excel") || c.starts_with("powerpoint") {
        Some("info")
    } else {
        None
    }
}

/// Classify a field instruction keyword into a finding kind + severity.
fn field_finding(keyword: &str, has_url: bool) -> (&'static str, &'static str) {
    match keyword {
        "INCLUDETEXT" | "INCLUDEPICTURE" | "LINK" | "IMPORT" => {
            ("field_external_ref", "high")
        }
        "HYPERLINK" | "EMBED" | "MACROBUTTON" | "DOCPROPERTY" if has_url => {
            ("field_external_ref", "medium")
        }
        "HYPERLINK" | "EMBED" | "MACROBUTTON" | "AUTOTEXT" | "GOTOBUTTON" => {
            ("field_external_ref", "medium")
        }
        "FORMTEXT" | "FORMCHECKBOX" | "FORMDROPDOWN" => ("form_field", "low"),
        "" => ("field_instruction", "info"),
        _ => ("field_instruction", "info"),
    }
}

/// Pull the first URL-like token out of a field instruction (bounded).
fn extract_url(instruction: &str) -> Option<String> {
    for token in instruction.split(|c: char| c.is_whitespace() || c == '"') {
        let t = token.trim_matches(|c: char| c == '\'' || c == ';' || c == ')');
        if t.contains("://") || t.starts_with("\\\\") || t.len() > 3 && t.starts_with("file:") {
            return Some(t.chars().take(256).collect());
        }
    }
    None
}

/// Map an RTF code page to an encoding_rs encoding. Unknown/unsupported
/// pages approximate through Windows-1252 (documented behavior for previews).
fn encoding_for(cp: u32) -> &'static encoding_rs::Encoding {
    match cp {
        1250 => encoding_rs::WINDOWS_1250,
        1251 => encoding_rs::WINDOWS_1251,
        1253 => encoding_rs::WINDOWS_1253,
        1254 => encoding_rs::WINDOWS_1254,
        1255 => encoding_rs::WINDOWS_1255,
        1256 => encoding_rs::WINDOWS_1256,
        1257 => encoding_rs::WINDOWS_1257,
        1258 => encoding_rs::WINDOWS_1258,
        874 => encoding_rs::WINDOWS_874,
        932 => encoding_rs::SHIFT_JIS,
        936 => encoding_rs::GBK,
        949 => encoding_rs::EUC_KR,
        950 => encoding_rs::BIG5,
        10000 => encoding_rs::MACINTOSH,
        20866 => encoding_rs::KOI8_R,
        21866 => encoding_rs::KOI8_U,
        866 => encoding_rs::IBM866,
        28592 => encoding_rs::ISO_8859_2,
        28593 => encoding_rs::ISO_8859_3,
        28594 => encoding_rs::ISO_8859_4,
        28595 => encoding_rs::ISO_8859_5,
        28596 => encoding_rs::ISO_8859_6,
        28597 => encoding_rs::ISO_8859_7,
        28598 => encoding_rs::ISO_8859_8,
        28600 => encoding_rs::ISO_8859_10,
        28603 => encoding_rs::ISO_8859_13,
        28604 => encoding_rs::ISO_8859_14,
        28605 => encoding_rs::ISO_8859_15,
        28606 => encoding_rs::ISO_8859_16,
        65001 => encoding_rs::UTF_8,
        // 1252, 28591 (== windows-1252 in WHATWG), 437/850 approximations, and
        // everything unmapped.
        _ => encoding_rs::WINDOWS_1252,
    }
}
