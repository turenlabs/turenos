//! Bounded, parse-only DEX (Dalvik Executable) inspector.
//!
//! Hand-rolled: parses the header, `string_ids`, `type_ids`, `proto_ids`,
//! `field_ids`, `method_ids`, `class_defs`, `class_data` member counts, and
//! the `map_list`. Bytecode bodies are never decoded or executed; code items
//! are only counted. Every table region is validated against the file before
//! a single element is read, every uleb128/offset is bounds-checked, and all
//! output lists are capped.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::util::{cap_str, hex, mutf8_to_string, Reader};

pub(crate) const MAX_LIST: usize = 4096;
pub(crate) const MAX_STRING_CHARS: usize = 512;
pub(crate) const MAX_FINDINGS: usize = 1024;
pub(crate) const MAX_MAP_ITEMS: usize = 256;
pub(crate) const MAX_PARAMS: usize = 256;
/// Upper bound on class-data members walked (bounds work, not output).
const MAX_CLASS_DATA_MEMBERS: u32 = 4_000_000;

const NO_INDEX: u32 = 0xffff_ffff;
const ACC_NATIVE: u32 = 0x0100;
const ENDIAN_CONSTANT: u32 = 0x1234_5678;
const REVERSE_ENDIAN: u32 = 0x7856_3412;
const HEADER_SIZE: usize = 0x70;

/// One decoded table region: (count, byte offset, stride).
#[derive(Clone, Copy)]
struct Table {
    count: usize,
    offset: usize,
    stride: usize,
}

impl Table {
    fn bounds_ok(&self, len: usize) -> bool {
        self.count == 0
            || self
                .offset
                .checked_add(self.count.saturating_mul(self.stride))
                .map(|end| end <= len)
                .unwrap_or(false)
    }
}

struct Dex {
    strings: Vec<String>,
    types: Vec<u32>,              // descriptor string index per type
    protos: Vec<(u32, u32, u32)>, // shorty_idx, return_type_idx, params_off
    fields: Vec<(u16, u16, u32)>, // class_idx, type_idx, name_idx
    methods: Vec<(u16, u16, u32)>, // class_idx, proto_idx, name_idx
}

impl Dex {
    fn string(&self, index: u32) -> Option<&str> {
        if index == NO_INDEX {
            return None;
        }
        self.strings.get(index as usize).map(String::as_str)
    }

    fn type_name(&self, index: u32) -> Option<&str> {
        if index == NO_INDEX {
            return None;
        }
        let descriptor = *self.types.get(index as usize)?;
        self.string(descriptor)
    }
}

/// Options understood by the DEX inspector.
#[derive(Default)]
pub(crate) struct DexOptions {
    /// Which `classesN.dex` to pick when the input is itself an APK/ZIP
    /// (1 = classes.dex, 2 = classes2.dex, ...). Ignored for raw DEX input.
    pub dex_index: u32,
    /// Cap on list sizes (strings/classes/protos), ≤ MAX_LIST.
    pub limit: usize,
    /// Include the string list in the output (default true).
    pub include_strings: bool,
}

/// Strings whose presence is interesting enough to surface as a finding.
/// `(needle, kind)` — substring match unless `exact`.
const STRING_MARKERS: &[(&str, &str, bool)] = &[
    ("Ljava/lang/reflect/", "reflection", false),
    ("Lkotlin/reflect/", "reflection", false),
    ("Ldalvik/system/DexClassLoader;", "dynamic_loading", true),
    ("Ldalvik/system/PathClassLoader;", "dynamic_loading", true),
    ("Ldalvik/system/InMemoryDexClassLoader;", "dynamic_loading", true),
    ("Ldalvik/system/BaseDexClassLoader;", "dynamic_loading", true),
    ("Ldalvik/system/DexFile;", "dynamic_loading", true),
    ("Ljavax/crypto/", "crypto", false),
    ("Ljava/security/", "crypto", false),
    ("Ljava/lang/Runtime;", "exec", true),
    ("Ljava/lang/ProcessBuilder;", "exec", true),
    ("Ljava/lang/System;", "native", true),
    ("Landroid/telephony/SmsManager;", "sms", true),
    ("Landroid/webkit/WebView;", "webview", true),
    ("su", "su_binary", true),
    ("/system/bin/su", "su_binary", true),
    ("/system/xbin/su", "su_binary", true),
    ("/sbin/su", "su_binary", true),
    ("/system/bin/sh", "shell", true),
    ("/bin/sh", "shell", true),
    ("/bin/bash", "shell", true),
    ("busybox", "su_binary", true),
    ("/system/xbin/busybox", "su_binary", true),
];

/// Method names interesting enough to surface.
const METHOD_MARKERS: &[(&str, &str)] = &[
    ("loadClass", "dynamic_loading"),
    ("defineClass", "dynamic_loading"),
    ("loadDex", "dynamic_loading"),
    ("forName", "reflection"),
    ("getMethod", "reflection"),
    ("getDeclaredMethod", "reflection"),
    ("getDeclaredField", "reflection"),
    ("getField", "reflection"),
    ("invoke", "reflection"),
    ("exec", "exec"),
    ("execSu", "exec"),
    ("loadLibrary", "native"),
    ("load", "native"),
    ("registerNatives", "native"),
    ("getDeviceId", "device_id"),
    ("getImei", "device_id"),
    ("getSubscriberId", "device_id"),
    ("getSimSerialNumber", "device_id"),
    ("getLine1Number", "device_id"),
    ("sendTextMessage", "sms"),
    ("sendMultipartTextMessage", "sms"),
    ("addJavascriptInterface", "webview_bridge"),
    ("setComponentEnabledSetting", "component_manipulation"),
    ("openConnection", "network"),
    ("getRuntime", "exec"),
];

/// map_list item type names (subset; unknown codes keep their number).
fn map_type_name(code: u16) -> &'static str {
    match code {
        0x0000 => "header_item",
        0x0001 => "string_id_item",
        0x0002 => "type_id_item",
        0x0003 => "proto_id_item",
        0x0004 => "field_id_item",
        0x0005 => "method_id_item",
        0x0006 => "class_def_item",
        0x0007 => "call_site_id_item",
        0x0008 => "method_handle_item",
        0x1000 => "map_list",
        0x1001 => "type_list",
        0x1002 => "annotation_set_ref_list",
        0x1003 => "annotation_set_item",
        0x2000 => "class_data_item",
        0x2001 => "code_item",
        0x2002 => "string_data_item",
        0x2003 => "debug_info_item",
        0x2004 => "annotation_item",
        0x2005 => "encoded_array_item",
        0x2006 => "annotations_directory_item",
        0x2007 => "hiddenapi_class_data_item",
        _ => "unknown",
    }
}

fn access_flags(flags: u32) -> Vec<&'static str> {
    let mut out = Vec::new();
    for (bit, name) in [
        (0x0001, "public"),
        (0x0002, "private"),
        (0x0004, "protected"),
        (0x0008, "static"),
        (0x0010, "final"),
        (0x0020, "synchronized"),
        (0x0040, "volatile_or_bridge"),
        (0x0080, "transient_or_varargs"),
        (0x0100, "native"),
        (0x0200, "interface"),
        (0x0400, "abstract"),
        (0x0800, "strict"),
        (0x1000, "synthetic"),
        (0x2000, "annotation"),
        (0x4000, "enum"),
        (0x10000, "constructor"),
        (0x20000, "declared_synchronized"),
    ] {
        if flags & bit != 0 {
            out.push(name);
        }
    }
    out
}

struct ClassStats {
    fields: u32,
    methods: u32,
    native_methods: u32,
    methods_with_code: u32,
    truncated: bool,
}

/// Walk a class_data_item: four uleb sizes then encoded fields and methods.
/// Only counts and access flags are recovered; member indices are skipped.
fn class_data_stats(data: &[u8], offset: usize) -> ClassStats {
    let mut stats = ClassStats {
        fields: 0,
        methods: 0,
        native_methods: 0,
        methods_with_code: 0,
        truncated: false,
    };
    if offset == 0 {
        return stats;
    }
    let mut r = Reader::at(data, offset);
    let (Some(static_fields), Some(instance_fields), Some(direct), Some(virt)) = (
        r.uleb128(),
        r.uleb128(),
        r.uleb128(),
        r.uleb128(),
    ) else {
        stats.truncated = true;
        return stats;
    };
    stats.fields = static_fields.saturating_add(instance_fields);
    stats.methods = direct.saturating_add(virt);

    let mut walked: u32 = 0;
    // Encoded fields: {field_idx_diff uleb, access_flags uleb}.
    for _ in 0..static_fields.saturating_add(instance_fields) {
        if walked >= MAX_CLASS_DATA_MEMBERS {
            stats.truncated = true;
            return stats;
        }
        walked += 1;
        if r.uleb128().is_none() || r.uleb128().is_none() {
            stats.truncated = true;
            return stats;
        }
    }
    // Encoded methods: {method_idx_diff uleb, access_flags uleb, code_off uleb}.
    for _ in 0..direct.saturating_add(virt) {
        if walked >= MAX_CLASS_DATA_MEMBERS {
            stats.truncated = true;
            return stats;
        }
        walked += 1;
        let (Some(_idx), Some(access), Some(code_off)) =
            (r.uleb128(), r.uleb128(), r.uleb128())
        else {
            stats.truncated = true;
            return stats;
        };
        if access & ACC_NATIVE != 0 {
            stats.native_methods += 1;
        }
        if code_off != 0 {
            stats.methods_with_code += 1;
        }
    }
    stats
}

/// Read a type_list at `offset`: u32 size + u16 type indexes.
fn type_list(data: &[u8], offset: usize, max: usize) -> Option<Vec<u32>> {
    if offset == 0 {
        return Some(Vec::new());
    }
    let mut r = Reader::at(data, offset);
    let count = r.u32()? as usize;
    let count = count.min(max);
    let mut out = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        out.push(r.u16()? as u32);
    }
    Some(out)
}

/// Parse and inspect a raw DEX file; returns the report JSON value.
pub(crate) fn inspect_dex(data: &[u8], options: &DexOptions) -> Result<Value, String> {
    if data.len() < 8 {
        return Err("too_small".into());
    }
    if &data[0..4] != b"dex\n" {
        if &data[0..4] == b"cdex" {
            return Err("unsupported_variant_cdex".into());
        }
        return Err("bad_magic".into());
    }
    if data.len() < HEADER_SIZE {
        return Err("truncated_header".into());
    }

    let mut head = Reader::new(data);
    let magic = head.bytes(8).unwrap_or_default();
    let version = String::from_utf8_lossy(&magic[4..7]).to_string();
    if !magic[4..7].iter().all(|b| b.is_ascii_digit()) || magic[7] != 0 {
        return Err("bad_magic".into());
    }
    let checksum = head.u32().unwrap_or(0);
    let signature = head.bytes(20).unwrap_or_default().to_vec();
    let file_size = head.u32().unwrap_or(0) as usize;
    let header_size = head.u32().unwrap_or(0) as usize;
    let endian = head.u32().unwrap_or(0);
    let link_size = head.u32().unwrap_or(0);
    let link_off = head.u32().unwrap_or(0);
    let map_off = head.u32().unwrap_or(0) as usize;
    let read_table = |r: &mut Reader, stride: usize| -> Table {
        let count = r.u32().unwrap_or(0) as usize;
        let offset = r.u32().unwrap_or(0) as usize;
        Table {
            count,
            offset,
            stride,
        }
    };
    let string_ids = read_table(&mut head, 4);
    let type_ids = read_table(&mut head, 4);
    let proto_ids = read_table(&mut head, 12);
    let field_ids = read_table(&mut head, 8);
    let method_ids = read_table(&mut head, 8);
    let class_defs = read_table(&mut head, 32);
    let data_size = head.u32().unwrap_or(0);
    let data_off = head.u32().unwrap_or(0);

    let mut warnings: Vec<String> = Vec::new();
    if header_size < HEADER_SIZE {
        return Err("malformed_header".into());
    }
    match endian {
        ENDIAN_CONSTANT => {}
        REVERSE_ENDIAN => return Err("unsupported_endian".into()),
        _ => warnings.push("unexpected_endian_tag".into()),
    }
    if file_size != data.len() {
        warnings.push("file_size_mismatch".into());
    }
    for (name, table) in [
        ("string_ids", string_ids),
        ("type_ids", type_ids),
        ("proto_ids", proto_ids),
        ("field_ids", field_ids),
        ("method_ids", method_ids),
        ("class_defs", class_defs),
    ] {
        if table.count > 0 && table.offset == 0 {
            return Err(format!("table_out_of_bounds:{name}"));
        }
        if !table.bounds_ok(data.len()) {
            return Err(format!("table_out_of_bounds:{name}"));
        }
    }

    // ---- strings ----
    let mut strings = Vec::with_capacity(string_ids.count.min(65_536));
    let mut sr = Reader::at(data, string_ids.offset);
    for _ in 0..string_ids.count {
        let off = match sr.u32() {
            Some(value) => value,
            None => break,
        };
        let pos = off as usize;
        if pos >= data.len() {
            warnings.push("string_data_out_of_range".into());
            strings.push(String::new());
            continue;
        }
        let mut dr = Reader::at(data, pos);
        let _utf16_len = dr.uleb128();
        let start = dr.pos;
        // MUTF-8 body ends at the first NUL byte.
        let mut end = start;
        while end < data.len() && data[end] != 0 {
            end += 1;
        }
        strings.push(mutf8_to_string(&data[start..end.min(data.len())]));
    }

    // ---- types ----
    let mut types = Vec::with_capacity(type_ids.count.min(65_536));
    let mut tr = Reader::at(data, type_ids.offset);
    for _ in 0..type_ids.count {
        match tr.u32() {
            Some(idx) => types.push(idx),
            None => break,
        }
    }

    // ---- protos ----
    let mut protos = Vec::with_capacity(proto_ids.count.min(65_536));
    let mut pr = Reader::at(data, proto_ids.offset);
    for _ in 0..proto_ids.count {
        let (Some(shorty), Some(ret), Some(params_off)) =
            (pr.u32(), pr.u32(), pr.u32())
        else {
            break;
        };
        protos.push((shorty, ret, params_off));
    }

    // ---- fields / methods ----
    let mut fields = Vec::with_capacity(field_ids.count.min(65_536));
    let mut fr = Reader::at(data, field_ids.offset);
    for _ in 0..field_ids.count {
        let (Some(class), Some(ftype), Some(name)) = (fr.u16(), fr.u16(), fr.u32()) else {
            break;
        };
        fields.push((class, ftype, name));
    }
    let mut methods = Vec::with_capacity(method_ids.count.min(65_536));
    let mut mr = Reader::at(data, method_ids.offset);
    for _ in 0..method_ids.count {
        let (Some(class), Some(proto), Some(name)) = (mr.u16(), mr.u16(), mr.u32()) else {
            break;
        };
        methods.push((class, proto, name));
    }

    let dex = Dex {
        strings,
        types,
        protos,
        fields,
        methods,
    };

    // ---- findings over strings ----
    let mut findings = Vec::new();
    let mut seen: BTreeSet<(String, String, &'static str)> = BTreeSet::new();
    let mut push_finding =
        |kind: &str, matched: &str, source: &'static str, index: usize, findings: &mut Vec<Value>| {
            if findings.len() >= MAX_FINDINGS {
                return;
            }
            let key = (kind.to_string(), matched.to_string(), source);
            if seen.insert(key) {
                findings.push(json!({
                    "kind": kind,
                    "match": cap_str(matched, 256),
                    "source": source,
                    "index": index,
                }));
            }
        };
    for (index, value) in dex.strings.iter().enumerate() {
        for (needle, kind, exact) in STRING_MARKERS {
            let hit = if *exact {
                value == needle
            } else {
                value.contains(needle)
            };
            if hit {
                push_finding(kind, value, "string", index, &mut findings);
            }
        }
    }
    for (index, (class, _proto, name)) in dex.methods.iter().enumerate() {
        let name_text = dex.string(*name).unwrap_or("");
        for (needle, kind) in METHOD_MARKERS {
            if name_text == *needle {
                let detail = format!(
                    "{}->{}",
                    dex.type_name(*class as u32).unwrap_or("?"),
                    name_text
                );
                push_finding(kind, &detail, "method", index, &mut findings);
            }
        }
    }

    // ---- class defs + class data ----
    let limit = options.limit.min(MAX_LIST);
    let mut classes_out = Vec::new();
    let mut total_native: u64 = 0;
    let mut total_methods: u64 = 0;
    let mut total_with_code: u64 = 0;
    let mut truncated = false;

    for i in 0..class_defs.count {
        let base = class_defs.offset + i * class_defs.stride;
        let mut cr = Reader::at(data, base);
        let (Some(class_idx), Some(access), Some(super_idx), Some(ifaces_off), Some(src_idx), _ann, Some(data_off), _static_values) = (
            cr.u32(),
            cr.u32(),
            cr.u32(),
            cr.u32(),
            cr.u32(),
            cr.u32(),
            cr.u32(),
            cr.u32(),
        ) else {
            warnings.push("class_def_truncated".into());
            break;
        };
        let stats = class_data_stats(data, data_off as usize);
        if stats.truncated {
            warnings.push("class_data_truncated".into());
        }
        if stats.native_methods > 0 {
            let detail = format!(
                "{}: {} native method(s)",
                dex.type_name(class_idx).unwrap_or("?"),
                stats.native_methods
            );
            push_finding("native", &detail, "class", i as usize, &mut findings);
        }
        total_native += stats.native_methods as u64;
        total_methods += stats.methods as u64;
        total_with_code += stats.methods_with_code as u64;

        if classes_out.len() < limit {
            let interfaces = type_list(data, ifaces_off as usize, MAX_PARAMS)
                .unwrap_or_default()
                .iter()
                .filter_map(|idx| dex.type_name(*idx).map(str::to_string))
                .collect::<Vec<_>>();
            classes_out.push(json!({
                "index": i,
                "name": dex.type_name(class_idx).unwrap_or(""),
                "superclass": dex.type_name(super_idx),
                "interfaces": interfaces,
                "access_flags": format!("0x{access:08x}"),
                "access": access_flags(access),
                "source_file": dex.string(src_idx),
                "fields": stats.fields,
                "methods": stats.methods,
                "native_methods": stats.native_methods,
                "methods_with_code": stats.methods_with_code,
            }));
        } else {
            truncated = true;
        }
    }
    if class_defs.count > limit {
        warnings.push(format!("classes_truncated:{}", class_defs.count - limit));
    }

    // ---- protos out ----
    let mut protos_out = Vec::new();
    for (index, (shorty, ret, params_off)) in dex.protos.iter().enumerate() {
        if protos_out.len() >= limit {
            truncated = true;
            break;
        }
        let params = type_list(data, *params_off as usize, MAX_PARAMS)
            .unwrap_or_default()
            .iter()
            .filter_map(|idx| dex.type_name(*idx).map(str::to_string))
            .collect::<Vec<_>>();
        protos_out.push(json!({
            "index": index,
            "shorty": dex.string(*shorty).unwrap_or(""),
            "return_type": dex.type_name(*ret).unwrap_or(""),
            "params": params,
        }));
    }

    // ---- strings out ----
    let mut strings_out = Vec::new();
    if options.include_strings {
        for (index, value) in dex.strings.iter().enumerate() {
            if strings_out.len() >= limit {
                truncated = true;
                break;
            }
            strings_out.push(json!({
                "index": index,
                "value": cap_str(value, MAX_STRING_CHARS),
            }));
        }
    }
    if dex.strings.len() > strings_out.len() && options.include_strings {
        warnings.push(format!(
            "strings_truncated:{}",
            dex.strings.len() - strings_out.len()
        ));
    }

    // ---- map list ----
    let mut map_out = Vec::new();
    if map_off != 0 && map_off + 4 <= data.len() {
        let mut mr = Reader::at(data, map_off);
        let count = mr.u32().unwrap_or(0) as usize;
        for _ in 0..count.min(MAX_MAP_ITEMS) {
            let (Some(mtype), Some(_unused), Some(msize), Some(moffset)) =
                (mr.u16(), mr.u16(), mr.u32(), mr.u32())
            else {
                break;
            };
            map_out.push(json!({
                "type": format!("0x{mtype:04x}"),
                "type_name": map_type_name(mtype),
                "size": msize,
                "offset": moffset,
            }));
        }
        if count > MAX_MAP_ITEMS {
            warnings.push("map_truncated".into());
        }
    }

    Ok(json!({
        "schema_version": 1,
        "kind": "dex",
        "input_bytes": data.len(),
        "header": {
            "version": version,
            "checksum_adler32": format!("0x{checksum:08x}"),
            "signature_sha1": hex(&signature),
            "file_size": file_size,
            "header_size": header_size,
            "endian_tag": format!("0x{endian:08x}"),
            "link_size": link_size,
            "link_off": link_off,
            "map_off": map_off,
            "data_size": data_size,
            "data_off": data_off,
            "string_ids": string_ids.count,
            "type_ids": type_ids.count,
            "proto_ids": proto_ids.count,
            "field_ids": field_ids.count,
            "method_ids": method_ids.count,
            "class_defs": class_defs.count,
        },
        "counts": {
            "strings": dex.strings.len(),
            "types": dex.types.len(),
            "protos": dex.protos.len(),
            "fields": dex.fields.len(),
            "methods": dex.methods.len(),
            "classes": class_defs.count,
        },
        "stats": {
            "native_methods": total_native,
            "direct_and_virtual_methods": total_methods,
            "methods_with_code": total_with_code,
        },
        "strings": strings_out,
        "protos": protos_out,
        "classes": classes_out,
        "map": map_out,
        "findings": findings,
        "warnings": warnings,
        "truncated": truncated,
    }))
}
