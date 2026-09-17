//! Test-only fixture builders: the binary AXML document, minimal DEX,
//! resources.arsc, and APK container used by the test suite are all
//! constructed here byte by byte so tests exercise the real parsers end to
//! end. `dump_fixtures` prints them as base64 for `test/verify.mjs`.
//!
//! Regenerate: `DUMP_FIXTURES=1 cargo test -- --nocapture dump_fixtures`

#![allow(dead_code)]

use std::io::Write;

// ---------------------------------------------------------------------------
// little-endian writers
// ---------------------------------------------------------------------------

pub fn w16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn w32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn w64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn chunk_header(out: &mut Vec<u8>, ctype: u16, header_size: u16, size: u32) {
    w16(out, ctype);
    w16(out, header_size);
    w32(out, size);
}

pub fn uleb(out: &mut Vec<u8>, mut v: u32) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        out.push(b);
        if v == 0 {
            break;
        }
    }
}

pub fn align4(out: &mut Vec<u8>) {
    while out.len() % 4 != 0 {
        out.push(0);
    }
}

// ---------------------------------------------------------------------------
// AXML
// ---------------------------------------------------------------------------

/// The string pool contents shared by the AXML fixture and verify.mjs.
pub const AXML_STRINGS: &[&str] = &[
    "manifest",                                      // 0
    "uses-sdk",                                      // 1
    "application",                                   // 2
    "activity",                                      // 3
    "http://schemas.android.com/apk/res/android",    // 4
    "android",                                       // 5
    "package",                                       // 6
    "name",                                          // 7
    "versionCode",                                   // 8
    "minSdkVersion",                                 // 9
    "exported",                                      // 10
    "com.example.app",                               // 11
    ".MainActivity",                                 // 12
];

/// UTF-8-flagged ResStringPool chunk (type 0x0001, header 28).
pub fn string_pool_chunk(strings: &[&str]) -> Vec<u8> {
    let mut out = Vec::new();
    let header_size = 28usize;
    let table_bytes = strings.len() * 4;
    let strings_start = header_size + table_bytes;

    // First pass: encode each string to learn its offset.
    let mut encoded: Vec<Vec<u8>> = Vec::new();
    for s in strings {
        let bytes = s.as_bytes();
        let mut e = Vec::new();
        let char_count = s.chars().count();
        // u16 char count (1-2 bytes), then byte length (1-2 bytes).
        if char_count >= 0x80 {
            e.push(0x80 | ((char_count >> 8) as u8));
            e.push(char_count as u8);
        } else {
            e.push(char_count as u8);
        }
        if bytes.len() >= 0x80 {
            e.push(0x80 | ((bytes.len() >> 8) as u8));
            e.push(bytes.len() as u8);
        } else {
            e.push(bytes.len() as u8);
        }
        e.extend_from_slice(bytes);
        e.push(0);
        encoded.push(e);
    }
    let data_bytes: usize = encoded.iter().map(Vec::len).sum();
    let padded = (data_bytes + 3) & !3;
    let size = (strings_start + padded) as u32;

    chunk_header(&mut out, 0x0001, header_size as u16, size);
    w32(&mut out, strings.len() as u32); // string_count
    w32(&mut out, 0); // style_count
    w32(&mut out, 0x100); // flags: utf8
    w32(&mut out, strings_start as u32);
    w32(&mut out, 0); // styles_start
    let mut rel = 0u32;
    for e in &encoded {
        w32(&mut out, rel);
        rel += e.len() as u32;
    }
    for e in &encoded {
        out.extend_from_slice(e);
    }
    while out.len() < size as usize {
        out.push(0);
    }
    out
}

pub fn node_ext(out: &mut Vec<u8>, ctype: u16, body: &[u8]) {
    // ResXMLTree_node: chunk header (8) + line(4) + comment(4) + body.
    let size = (16 + body.len()) as u32;
    chunk_header(out, ctype, 16, size);
    w32(out, 1); // line number
    w32(out, 0xffffffff); // comment
    out.extend_from_slice(body);
}

pub fn start_element(out: &mut Vec<u8>, ns: u32, name: u32, attrs: &[(u32, u32, u32, u8, u32)]) {
    // attr = (ns_idx, name_idx, raw_value, data_type, data)
    let mut body = Vec::new();
    w32(&mut body, ns);
    w32(&mut body, name);
    w16(&mut body, 20); // attributeStart
    w16(&mut body, 20); // attributeSize
    w16(&mut body, attrs.len() as u16);
    w16(&mut body, 0); // idIndex
    w16(&mut body, 0); // classIndex
    w16(&mut body, 0); // styleIndex
    for (a_ns, a_name, a_raw, a_type, a_data) in attrs {
        w32(&mut body, *a_ns);
        w32(&mut body, *a_name);
        w32(&mut body, *a_raw);
        w16(&mut body, 8); // ResValue size
        body.push(0); // res0
        body.push(*a_type);
        w32(&mut body, *a_data);
    }
    node_ext(out, 0x0102, &body);
}

pub fn end_element(out: &mut Vec<u8>, ns: u32, name: u32) {
    let mut body = Vec::new();
    w32(&mut body, ns);
    w32(&mut body, name);
    node_ext(out, 0x0103, &body);
}

/// Complete AXML document: manifest → uses-sdk, application/activity.
pub fn axml_fixture() -> Vec<u8> {
    const NO: u32 = 0xffff_ffff;
    let mut body = Vec::new();

    // String pool.
    body.extend_from_slice(&string_pool_chunk(AXML_STRINGS));

    // Resource map: resIds indexed by string index (0 for non-attrs).
    let res_ids: [u32; 13] = [
        0, 0, 0, 0, 0, 0, 0, 0x0101_0003, 0x0101_021b, 0x0101_020c, 0x0101_0010, 0, 0,
    ];
    let mut map = Vec::new();
    chunk_header(&mut map, 0x0180, 8, (8 + res_ids.len() * 4) as u32);
    for id in res_ids {
        w32(&mut map, id);
    }
    body.extend_from_slice(&map);

    // xmlns:android declaration.
    let mut ns = Vec::new();
    w32(&mut ns, 5); // prefix "android"
    w32(&mut ns, 4); // uri
    node_ext(&mut body, 0x0100, &ns);

    // <manifest package="com.example.app" android:versionCode="33">
    start_element(
        &mut body,
        NO,
        0,
        &[
            (NO, 6, 11, 0x03, 11),       // package (raw string)
            (4, 8, NO, 0x10, 33),        // android:versionCode (int)
        ],
    );
    // <uses-sdk android:minSdkVersion="21"/>
    start_element(&mut body, NO, 1, &[(4, 9, NO, 0x10, 21)]);
    end_element(&mut body, NO, 1);
    // <application><activity .../></application>
    start_element(&mut body, NO, 2, &[]);
    start_element(
        &mut body,
        NO,
        3,
        &[
            (4, 7, 12, 0x03, 12),        // android:name=".MainActivity"
            (4, 10, NO, 0x12, 1),        // android:exported=true
        ],
    );
    end_element(&mut body, NO, 3);
    end_element(&mut body, NO, 2);
    end_element(&mut body, NO, 0);

    let mut endns = Vec::new();
    w32(&mut endns, 5);
    w32(&mut endns, 4);
    node_ext(&mut body, 0x0101, &endns);

    let mut doc = Vec::new();
    chunk_header(&mut doc, 0x0003, 8, (8 + body.len()) as u32);
    doc.extend_from_slice(&body);
    doc
}

// ---------------------------------------------------------------------------
// DEX
// ---------------------------------------------------------------------------

/// String table shared with verify.mjs. Order is load-bearing (type/proto/
/// method indices below refer to it).
pub const DEX_STRINGS: &[&str] = &[
    "Lcom/example/app/MainActivity;",        // 0
    "Ljava/lang/Object;",                    // 1
    "Landroid/app/Activity;",                // 2
    "MainActivity.java",                     // 3
    "V",                                     // 4
    "VL",                                    // 5
    "onCreate",                              // 6
    "<init>",                                // 7
    "Landroid/os/Bundle;",                   // 8
    "Ljava/lang/reflect/Method;",            // 9  (reflection)
    "Ljavax/crypto/Cipher;",                 // 10 (crypto)
    "/system/bin/su",                        // 11 (su)
    "Ldalvik/system/DexClassLoader;",        // 12 (dynamic loading)
    "loadClass",                             // 13
    "Ljava/lang/Runtime;",                   // 14 (exec)
    "exec",                                  // 15
    "I",                                     // 16
    "version",                               // 17
];

/// Minimal DEX: two classes, four methods, one native method.
pub fn dex_fixture() -> Vec<u8> {
    const NO: u32 = 0xffff_ffff;
    // Types (string index of descriptor).
    let types: [u32; 10] = [0, 1, 2, 8, 4, 16, 9, 10, 12, 14];
    // Protos: (shorty_idx, return_type_idx, params_off — patched later).
    let protos: [(u32, u32, u32); 2] = [(4, 4, 0), (5, 4, 0)];
    // Fields: (class type_idx, type type_idx, name string_idx).
    let fields: [(u16, u16, u32); 1] = [(0, 5, 17)];
    // Methods: (class type_idx, proto idx, name string_idx).
    let methods: [(u16, u16, u32); 4] = [(0, 0, 7), (0, 1, 6), (8, 0, 13), (9, 0, 15)];

    let header = 0x70usize;
    let string_ids_off = header;
    let type_ids_off = string_ids_off + DEX_STRINGS.len() * 4;
    let proto_ids_off = type_ids_off + types.len() * 4;
    let field_ids_off = proto_ids_off + protos.len() * 12;
    let method_ids_off = field_ids_off + fields.len() * 8;
    let class_defs_off = method_ids_off + methods.len() * 8;
    let data_off = class_defs_off + 2 * 32;

    // ---- data section ----
    let mut data = Vec::new();
    let mut string_offsets = Vec::new();
    for s in DEX_STRINGS {
        string_offsets.push((data_off + data.len()) as u32);
        uleb(&mut data, s.chars().count() as u32); // utf16 size
        data.extend_from_slice(s.as_bytes()); // ASCII ⇒ MUTF-8 identical
        data.push(0);
    }
    align4(&mut data);
    let params1_off = (data_off + data.len()) as u32;
    w32(&mut data, 1); // one param
    w16(&mut data, 3); // Landroid/os/Bundle;
    align4(&mut data);

    // class_data for MainActivity: 1 static field, 1 direct, 1 virtual.
    let class_data0 = (data_off + data.len()) as u32;
    uleb(&mut data, 1); // static_fields
    uleb(&mut data, 0); // instance_fields
    uleb(&mut data, 1); // direct_methods
    uleb(&mut data, 1); // virtual_methods
    uleb(&mut data, 0); // field idx_diff → field 0
    uleb(&mut data, 0x9); // public static
    uleb(&mut data, 0); // method idx_diff → <init>
    uleb(&mut data, 0x10001); // public|constructor
    uleb(&mut data, 0); // code_off 0
    uleb(&mut data, 1); // method idx_diff → onCreate
    uleb(&mut data, 0x1); // public
    uleb(&mut data, 0); // code_off 0

    // class_data for DexClassLoader: one static native method.
    let class_data1 = (data_off + data.len()) as u32;
    uleb(&mut data, 0);
    uleb(&mut data, 0);
    uleb(&mut data, 1); // 1 direct method
    uleb(&mut data, 0); // 0 virtual
    uleb(&mut data, 2); // idx_diff → method 2 (loadClass)
    uleb(&mut data, 0x109); // public static native
    uleb(&mut data, 0); // code_off 0
    align4(&mut data);

    // map_list (11 entries).
    let map_off = (data_off + data.len()) as u32;
    let map_items: [(u16, u32, u32); 11] = [
        (0x0000, 1, 0),
        (0x0001, DEX_STRINGS.len() as u32, string_ids_off as u32),
        (0x0002, types.len() as u32, type_ids_off as u32),
        (0x0003, protos.len() as u32, proto_ids_off as u32),
        (0x0004, fields.len() as u32, field_ids_off as u32),
        (0x0005, methods.len() as u32, method_ids_off as u32),
        (0x0006, 2, class_defs_off as u32),
        (0x1001, 1, params1_off),
        (0x2002, DEX_STRINGS.len() as u32, data_off as u32),
        (0x2000, 2, class_data0),
        (0x1000, 1, map_off),
    ];
    w32(&mut data, map_items.len() as u32);
    for (ty, size, off) in map_items {
        w16(&mut data, ty);
        w16(&mut data, 0);
        w32(&mut data, size);
        w32(&mut data, off);
    }
    let data_size = data.len() as u32;
    let file_size = (data_off + data.len()) as u32;

    // ---- header + id tables ----
    let mut out = Vec::new();
    out.extend_from_slice(b"dex\n035\0");
    w32(&mut out, 0xdead_beef); // adler32 checksum (reported, not verified)
    out.extend_from_slice(&[0x11u8; 20]); // sha-1 signature bytes
    w32(&mut out, file_size);
    w32(&mut out, 0x70); // header_size
    w32(&mut out, 0x1234_5678); // endian_tag
    w32(&mut out, 0); // link_size
    w32(&mut out, 0); // link_off
    w32(&mut out, map_off);
    w32(&mut out, DEX_STRINGS.len() as u32);
    w32(&mut out, string_ids_off as u32);
    w32(&mut out, types.len() as u32);
    w32(&mut out, type_ids_off as u32);
    w32(&mut out, protos.len() as u32);
    w32(&mut out, proto_ids_off as u32);
    w32(&mut out, fields.len() as u32);
    w32(&mut out, field_ids_off as u32);
    w32(&mut out, methods.len() as u32);
    w32(&mut out, method_ids_off as u32);
    w32(&mut out, 2); // class_defs_size
    w32(&mut out, class_defs_off as u32);
    w32(&mut out, data_size);
    w32(&mut out, data_off as u32);
    debug_assert_eq!(out.len(), header);

    for off in &string_offsets {
        w32(&mut out, *off);
    }
    for ty in types {
        w32(&mut out, ty);
    }
    for (i, (shorty, ret, params)) in protos.iter().enumerate() {
        w32(&mut out, *shorty);
        w32(&mut out, *ret);
        w32(&mut out, if i == 1 { params1_off } else { *params });
    }
    for (class, ftype, name) in fields {
        w16(&mut out, class);
        w16(&mut out, ftype);
        w32(&mut out, name);
    }
    for (class, proto, name) in methods {
        w16(&mut out, class);
        w16(&mut out, proto);
        w32(&mut out, name);
    }
    // class_def 0: MainActivity extends Activity.
    w32(&mut out, 0); // class_idx
    w32(&mut out, 0x1); // public
    w32(&mut out, 2); // superclass = Activity
    w32(&mut out, 0); // interfaces_off
    w32(&mut out, 3); // source_file_idx
    w32(&mut out, 0); // annotations_off
    w32(&mut out, class_data0);
    w32(&mut out, 0); // static_values_off
    // class_def 1: DexClassLoader extends Object.
    w32(&mut out, 8);
    w32(&mut out, 0x1);
    w32(&mut out, 1); // Object
    w32(&mut out, 0);
    w32(&mut out, NO); // no source file
    w32(&mut out, 0);
    w32(&mut out, class_data1);
    w32(&mut out, 0);
    debug_assert_eq!(out.len(), data_off);
    out.extend_from_slice(&data);
    out
}

// ---------------------------------------------------------------------------
// resources.arsc (ResTable + one ResTablePackage)
// ---------------------------------------------------------------------------

pub fn arsc_fixture() -> Vec<u8> {
    let mut pkg = Vec::new();
    // Package header: 8 + id(4) + name(256) + 5×u32 = 288 bytes.
    chunk_header(&mut pkg, 0x0200, 288, 288);
    w32(&mut pkg, 0x7f); // package id
    let name = "com.example.app";
    let mut units = [0u16; 128];
    for (i, u) in name.encode_utf16().enumerate() {
        units[i] = u;
    }
    for u in units {
        w16(&mut pkg, u);
    }
    for _ in 0..5 {
        w32(&mut pkg, 0); // typeStrings..typeIdOffset
    }
    debug_assert_eq!(pkg.len(), 288);

    let mut out = Vec::new();
    chunk_header(&mut out, 0x0002, 12, (12 + pkg.len()) as u32);
    w32(&mut out, 1); // package count
    out.extend_from_slice(&pkg);
    out
}

// ---------------------------------------------------------------------------
// APK (ZIP) — stored + deflated entries via the real zip writer
// ---------------------------------------------------------------------------

pub fn apk_fixture() -> Vec<u8> {
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let cursor = std::io::Cursor::new(Vec::new());
    let mut w = ZipWriter::new(cursor);
    let manifest = axml_fixture();
    let dex = dex_fixture();
    w.start_file("AndroidManifest.xml", deflated).unwrap();
    w.write_all(&manifest).unwrap();
    w.start_file("classes.dex", stored).unwrap();
    w.write_all(&dex).unwrap();
    w.start_file("classes2.dex", stored).unwrap();
    w.write_all(&dex).unwrap();
    w.start_file("resources.arsc", stored).unwrap();
    w.write_all(&arsc_fixture()).unwrap();
    w.start_file("META-INF/CERT.SF", stored).unwrap();
    w.write_all(b"Signature-Version: 1.0\r\n").unwrap();
    w.start_file("META-INF/CERT.RSA", stored).unwrap();
    w.write_all(b"\x30\x82fake-cert").unwrap();
    w.finish().unwrap().into_inner()
}

/// Splice an APK v2 signing block in front of the central directory and fix
/// the EOCD's central-directory offset.
pub fn apk_signed_fixture() -> Vec<u8> {
    let mut zip = apk_fixture();
    // Locate EOCD.
    let mut eocd = None;
    for pos in (0..zip.len().saturating_sub(21)).rev() {
        if zip[pos..pos + 4] == [0x50, 0x4b, 0x05, 0x06] {
            eocd = Some(pos);
            break;
        }
    }
    let eocd = eocd.expect("eocd");
    let cd_offset = u32::from_le_bytes(zip[eocd + 16..eocd + 20].try_into().unwrap()) as usize;

    // Block: [u64 size][pair][u64 size]["APK Sig Block 42"]
    let mut pair = Vec::new();
    w64(&mut pair, 4 + 5); // len = id(4) + value(5)
    w32(&mut pair, 0x7109_871a); // APKSignatureSchemeV2
    pair.extend_from_slice(b"v2sig");
    let block_size = 8 + pair.len() + 8 + 16;
    let mut block = Vec::new();
    w64(&mut block, (block_size - 8) as u64);
    block.extend_from_slice(&pair);
    w64(&mut block, (block_size - 8) as u64);
    block.extend_from_slice(b"APK Sig Block 42");
    debug_assert_eq!(block.len(), block_size);

    let mut out = Vec::with_capacity(zip.len() + block.len());
    out.extend_from_slice(&zip[..cd_offset]);
    out.extend_from_slice(&block);
    out.extend_from_slice(&zip[cd_offset..]);
    // Patch central_directory_offset in EOCD.
    let new_cd = (cd_offset + block.len()) as u32;
    out[eocd + 16 + block.len()..eocd + 20 + block.len()]
        .copy_from_slice(&new_cd.to_le_bytes());
    zip.clear();
    out
}
