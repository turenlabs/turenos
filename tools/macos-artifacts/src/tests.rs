//! Fabricated-fixture unit tests: every artifact format is built byte by
//! byte in test code (plist round-trips through the `plist` crate's own
//! writers, fsevents pages are gzipped via `flate2`, DS_Store blocks and the
//! tracev3 chunk stream are assembled by hand), then exercised through the
//! real op functions.

use super::*;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;

fn ok_json(json: &str) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_str(json).unwrap();
    assert!(value.get("error").is_none(), "unexpected error: {json}");
    value
}

fn err_json(json: &str) -> serde_json::Value {
    let value: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(value["schema_version"], 1);
    assert!(value.get("error").is_some(), "expected error: {json}");
    value
}

// ---------- plist fixtures ----------

fn sample_plist() -> plist::Value {
    let mut dict = plist::Dictionary::new();
    dict.insert("Name".into(), plist::Value::String("Fixture".into()));
    dict.insert("Count".into(), plist::Value::Integer(42.into()));
    dict.insert("Ratio".into(), plist::Value::Real(2.5));
    dict.insert("Flag".into(), plist::Value::Boolean(true));
    dict.insert(
        "Payload".into(),
        plist::Value::Data(vec![0xde, 0xad, 0xbe, 0xef]),
    );
    dict.insert(
        "Items".into(),
        plist::Value::Array(vec![
            plist::Value::String("a".into()),
            plist::Value::String("b".into()),
        ]),
    );
    let mut inner = plist::Dictionary::new();
    inner.insert("Deep".into(), plist::Value::String("leaf".into()));
    dict.insert("Nested".into(), plist::Value::Dictionary(inner));
    plist::Value::Dictionary(dict)
}

fn binary_plist() -> Vec<u8> {
    let mut out = Vec::new();
    sample_plist().to_writer_binary(&mut out).unwrap();
    out
}

fn xml_plist() -> Vec<u8> {
    let mut out = Vec::new();
    sample_plist().to_writer_xml(&mut out).unwrap();
    out
}

// ---------- fsevents fixtures ----------

fn fsevents_record(path: &str, event_id: u64, flags: u32, node: Option<u64>, v3: bool) -> Vec<u8> {
    let mut out = path.as_bytes().to_vec();
    out.push(0);
    out.extend_from_slice(&event_id.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    if let Some(node) = node {
        out.extend_from_slice(&node.to_le_bytes());
    }
    if v3 {
        out.extend_from_slice(&0xa5a5a5a5u32.to_le_bytes());
    }
    out
}

fn fsevents_page(magic: &[u8; 4], records: &[u8]) -> Vec<u8> {
    let mut out = magic.to_vec();
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&((12 + records.len()) as u32).to_le_bytes());
    out.extend_from_slice(records);
    out
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn fsevents_fixture() -> Vec<u8> {
    let mut stream = fsevents_page(
        b"2SLD",
        &[
            fsevents_record("/Users/test/file.txt", 0x1122, 0x1 | 0x0080_0000, Some(99), false)
                .as_slice(),
            fsevents_record("/Users/test/gone", 0x1123, 0x2 | 0x0100_0000, Some(100), false)
                .as_slice(),
        ]
        .concat(),
    );
    stream.extend_from_slice(&fsevents_page(
        b"3SLD",
        &fsevents_record("/tmp/x", 0x99, 0x8 | 0x10, Some(7), true),
    ));
    gzip(&stream)
}

// ---------- .DS_Store fixture ----------

/// Layout: header @0; root block @36 (stored offset 32); DSDB superblock
/// @2084; leaf node @2116. Stored addresses carry file_offset-4 in the high
/// bits and log2(size) in the low 5 bits.
fn dsstore_fixture() -> Vec<u8> {
    let mut file = vec![0u8; 2116 + 256];

    // Header.
    file[0..4].copy_from_slice(&1u32.to_be_bytes());
    file[4..8].copy_from_slice(b"Bud1");
    file[8..12].copy_from_slice(&32u32.to_be_bytes()); // root offset
    file[12..16].copy_from_slice(&2048u32.to_be_bytes()); // root size
    file[16..20].copy_from_slice(&32u32.to_be_bytes()); // offset copy

    // Root block at file offset 36.
    let mut root = Vec::with_capacity(2048);
    root.extend_from_slice(&2u32.to_be_bytes()); // two block offsets
    root.extend_from_slice(&0u32.to_be_bytes());
    // offsets table padded to 256 entries: block0=DSDB, block1=leaf.
    let dsdb_addr = (2084 - 4) as u32 | 5; // size 32
    let leaf_addr = (2116 - 4) as u32 | 8; // size 256
    root.extend_from_slice(&dsdb_addr.to_be_bytes());
    root.extend_from_slice(&leaf_addr.to_be_bytes());
    root.resize(8 + 1024, 0);
    // TOC: one entry "DSDB" -> block 0.
    root.extend_from_slice(&1u32.to_be_bytes());
    root.push(4);
    root.extend_from_slice(b"DSDB");
    root.extend_from_slice(&0u32.to_be_bytes());
    // 32 empty free lists.
    for _ in 0..32 {
        root.extend_from_slice(&0u32.to_be_bytes());
    }
    root.resize(2048, 0);
    file[36..36 + 2048].copy_from_slice(&root);

    // DSDB superblock at 2084: root_node=1, levels=1, records=3, nodes=1,
    // page_size=4096.
    let mut superblock = Vec::new();
    for value in [1u32, 1, 3, 1, 4096] {
        superblock.extend_from_slice(&value.to_be_bytes());
    }
    file[2084..2084 + superblock.len()].copy_from_slice(&superblock);

    // Leaf node at 2116: next_node=0, count=3, then entries.
    let mut leaf = Vec::new();
    leaf.extend_from_slice(&0u32.to_be_bytes());
    leaf.extend_from_slice(&3u32.to_be_bytes());

    // Entry 1: "Icon" Iloc blob {x=10, y=20}.
    let mut entry = Vec::new();
    entry.extend_from_slice(&4u32.to_be_bytes());
    for unit in "Icon".encode_utf16() {
        entry.extend_from_slice(&unit.to_be_bytes());
    }
    entry.extend_from_slice(b"Ilocblob");
    entry.extend_from_slice(&16u32.to_be_bytes());
    entry.extend_from_slice(&10u32.to_be_bytes());
    entry.extend_from_slice(&20u32.to_be_bytes());
    entry.extend_from_slice(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
    leaf.extend_from_slice(&entry);

    // Entry 2: "Notes" vSrn long.
    let mut entry = Vec::new();
    entry.extend_from_slice(&5u32.to_be_bytes());
    for unit in "Notes".encode_utf16() {
        entry.extend_from_slice(&unit.to_be_bytes());
    }
    entry.extend_from_slice(b"vSrnlong");
    entry.extend_from_slice(&7u32.to_be_bytes());
    leaf.extend_from_slice(&entry);

    // Entry 3: "Doc" ustr "hello".
    let mut entry = Vec::new();
    entry.extend_from_slice(&3u32.to_be_bytes());
    for unit in "Doc".encode_utf16() {
        entry.extend_from_slice(&unit.to_be_bytes());
    }
    entry.extend_from_slice(b"dsclustr");
    entry.extend_from_slice(&5u32.to_be_bytes());
    for unit in "hello".encode_utf16() {
        entry.extend_from_slice(&unit.to_be_bytes());
    }
    leaf.extend_from_slice(&entry);

    leaf.resize(256, 0);
    file[2116..2116 + 256].copy_from_slice(&leaf);
    file
}

// ---------- tracev3 fixture ----------

fn preamble(tag: u32, sub_tag: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&tag.to_le_bytes());
    out.extend_from_slice(&sub_tag.to_le_bytes());
    out.extend_from_slice(&(data.len() as u64).to_le_bytes());
    out.extend_from_slice(data);
    // 8-byte alignment padding on the chunk data size.
    let pad = (8 - (data.len() % 8)) % 8;
    out.resize(out.len() + pad, 0);
    out
}

fn tracev3_header() -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&1u32.to_le_bytes()); // mach numerator
    data.extend_from_slice(&1u32.to_le_bytes()); // mach denominator
    data.extend_from_slice(&1000u64.to_le_bytes()); // continuous time
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes()); // bias min
    data.extend_from_slice(&0u32.to_le_bytes()); // dst
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&0x6100u32.to_le_bytes()); // sub tag 1
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&999u64.to_le_bytes());
    data.extend_from_slice(&0x6101u32.to_le_bytes()); // sub tag 2
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    let mut build = b"24A335\0".to_vec();
    build.resize(16, 0);
    data.extend_from_slice(&build);
    let mut model = b"MacBookPro18,3\0".to_vec();
    model.resize(32, 0);
    data.extend_from_slice(&model);
    data.extend_from_slice(&0x6102u32.to_le_bytes()); // sub tag 3
    data.extend_from_slice(&24u32.to_le_bytes());
    data.extend_from_slice(&0x00112233445566778899aabbccddeeFFu128.to_be_bytes());
    data.extend_from_slice(&77u32.to_le_bytes()); // logd pid
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&0x6103u32.to_le_bytes()); // sub tag 4
    data.extend_from_slice(&48u32.to_le_bytes());
    let mut tz = b"/var/db/timezone/zoneinfo/UTC\0".to_vec();
    tz.resize(48, 0);
    data.extend_from_slice(&tz);
    assert_eq!(data.len(), 208);
    preamble(0x1000, 0x11, &data)
}

fn tracev3_catalog() -> Vec<u8> {
    let uuid = 0x00112233445566778899aabbccddeeffu128;
    let strings = b"com.turen.test\0default\0"; // 23 bytes
    let sso: u16 = 16; // one 16-byte UUID
    let pieo: u16 = sso + strings.len() as u16; // 39

    // One process info entry (72 bytes):
    let mut proc_entry = Vec::new();
    proc_entry.extend_from_slice(&0u16.to_le_bytes()); // index
    proc_entry.extend_from_slice(&0u16.to_le_bytes()); // unknown
    proc_entry.extend_from_slice(&0u16.to_le_bytes()); // main uuid index
    proc_entry.extend_from_slice(&0u16.to_le_bytes()); // dsc uuid index
    proc_entry.extend_from_slice(&1u64.to_le_bytes()); // first proc id
    proc_entry.extend_from_slice(&1u32.to_le_bytes()); // second proc id
    proc_entry.extend_from_slice(&501u32.to_le_bytes()); // pid
    proc_entry.extend_from_slice(&20u32.to_le_bytes()); // euid
    proc_entry.extend_from_slice(&0u32.to_le_bytes()); // unknown2
    proc_entry.extend_from_slice(&1u32.to_le_bytes()); // uuid info count
    proc_entry.extend_from_slice(&0u32.to_le_bytes()); // unknown3
    // uuid info entry: size u32, unknown u32, uuid index u16, load addr 6B.
    proc_entry.extend_from_slice(&16u32.to_le_bytes());
    proc_entry.extend_from_slice(&0u32.to_le_bytes());
    proc_entry.extend_from_slice(&0u16.to_le_bytes());
    proc_entry.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    proc_entry.extend_from_slice(&1u32.to_le_bytes()); // subsystem count
    proc_entry.extend_from_slice(&0u32.to_le_bytes()); // unknown4
    // subsystem entry: identifier 7, subsystem offset 0, category offset 15.
    proc_entry.extend_from_slice(&7u16.to_le_bytes());
    proc_entry.extend_from_slice(&0u16.to_le_bytes());
    proc_entry.extend_from_slice(&15u16.to_le_bytes());
    proc_entry.extend_from_slice(&[0, 0]); // pad to 8
    assert_eq!(proc_entry.len(), 72);
    let osc: u16 = pieo + 72; // 111

    // One subchunk: start,end u64, uncompressed u32, compression 0x100,
    // index count 1, index u16, string-offset count 0, pad to 8.
    let mut subchunk = Vec::new();
    subchunk.extend_from_slice(&0u64.to_le_bytes());
    subchunk.extend_from_slice(&70u64.to_le_bytes());
    subchunk.extend_from_slice(&70u32.to_le_bytes());
    subchunk.extend_from_slice(&0x100u32.to_le_bytes());
    subchunk.extend_from_slice(&1u32.to_le_bytes());
    subchunk.extend_from_slice(&0u16.to_le_bytes());
    subchunk.extend_from_slice(&0u32.to_le_bytes());
    subchunk.extend_from_slice(&[0u8; 6]); // pad8((1+0)*2) = 6
    assert_eq!(subchunk.len(), 40);

    let mut data = Vec::new();
    data.extend_from_slice(&sso.to_le_bytes());
    data.extend_from_slice(&pieo.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes()); // proc entries
    data.extend_from_slice(&osc.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes()); // subchunks
    data.extend_from_slice(&[0u8; 6]);
    data.extend_from_slice(&1000u64.to_le_bytes()); // earliest ts
    data.extend_from_slice(&uuid.to_be_bytes());
    data.extend_from_slice(strings);
    data.extend_from_slice(&proc_entry);
    data.extend_from_slice(&subchunk);
    preamble(0x600b, 0x11, &data)
}

fn tracev3_chunkset() -> Vec<u8> {
    // One firehose preamble chunk carrying one non-activity entry.
    let mut entry = Vec::new();
    entry.push(0x4); // non-activity
    entry.push(0x1); // log type
    entry.extend_from_slice(&0x202u16.to_le_bytes()); // main_exe + has_subsystem
    entry.extend_from_slice(&0x100u32.to_le_bytes()); // format string location
    entry.extend_from_slice(&0x1234u64.to_le_bytes()); // thread id
    entry.extend_from_slice(&5u32.to_le_bytes()); // continuous delta
    entry.extend_from_slice(&0u16.to_le_bytes()); // delta upper
    entry.extend_from_slice(&6u16.to_le_bytes()); // data size
    entry.extend_from_slice(&0xdeadbeefu32.to_le_bytes()); // pc_id
    entry.extend_from_slice(&7u16.to_le_bytes()); // subsystem value
    assert_eq!(entry.len(), 30); // 24-byte header + 6 bytes of flag data

    let mut fh = Vec::new();
    fh.extend_from_slice(&1u64.to_le_bytes()); // first proc id
    fh.extend_from_slice(&1u32.to_le_bytes()); // second proc id
    fh.push(0); // ttl
    fh.push(0); // collapsed
    fh.extend_from_slice(&[0, 0]); // unknown
    fh.extend_from_slice(&(16u16 + entry.len() as u16).to_le_bytes()); // public size
    fh.extend_from_slice(&0x1000u16.to_le_bytes()); // no private data
    fh.extend_from_slice(&[0, 0, 0, 0]);
    fh.extend_from_slice(&0u64.to_le_bytes()); // base continuous time
    fh.extend_from_slice(&entry);
    let fh_chunk = preamble(0x6001, 0x11, &fh);

    let mut data = Vec::new();
    data.extend_from_slice(&758412898u32.to_le_bytes()); // "bv4-" uncompressed
    data.extend_from_slice(&(fh_chunk.len() as u32).to_le_bytes());
    data.extend_from_slice(&fh_chunk);
    data.extend_from_slice(&0x24347662u32.to_le_bytes()); // "bv4$" footer
    preamble(0x600d, 0x11, &data)
}

fn tracev3_fixture() -> Vec<u8> {
    [
        tracev3_header(),
        tracev3_catalog(),
        tracev3_chunkset(),
    ]
    .concat()
}

// ---------- tests ----------

#[test]
fn plist_binary_decodes() {
    let out = ok_json(&plist_parse(&binary_plist(), "{}"));
    assert_eq!(out["format"], "plist");
    let result = &out["result"];
    assert_eq!(result["encoding"], "binary");
    assert_eq!(result["root"]["Name"], "Fixture");
    assert_eq!(result["root"]["Count"], 42);
    assert_eq!(result["root"]["Ratio"], 2.5);
    assert_eq!(result["root"]["Flag"], true);
    assert_eq!(result["root"]["Payload"]["$type"], "data");
    assert_eq!(result["root"]["Payload"]["length"], 4);
    assert_eq!(result["root"]["Payload"]["preview"], "deadbeef");
    assert_eq!(result["root"]["Items"], serde_json::json!(["a", "b"]));
    assert_eq!(result["root"]["Nested"]["Deep"], "leaf");
    assert_eq!(result["node_counts"]["dictionaries"], 2);
    assert_eq!(result["node_counts"]["arrays"], 1);
    assert!(result["node_counts"]["strings"].as_u64().unwrap() >= 8);
}

#[test]
fn plist_xml_decodes() {
    let out = ok_json(&plist_parse(&xml_plist(), "{}"));
    let result = &out["result"];
    assert_eq!(result["encoding"], "xml");
    assert_eq!(result["root"]["Name"], "Fixture");
    assert_eq!(result["root"]["Count"], 42);
}

#[test]
fn plist_rejects_garbage() {
    assert_eq!(err_json(&plist_parse(b"not a plist at all", "{}"))["error"], "invalid_plist");
    assert_eq!(err_json(&plist_parse(b"bplist00\xff\xff", "{}"))["error"], "invalid_plist");
}

#[test]
fn plist_depth_cap() {
    // 40 nested arrays via binary plist writer.
    let mut value = plist::Value::String("bottom".into());
    for _ in 0..40 {
        value = plist::Value::Array(vec![value]);
    }
    let mut bytes = Vec::new();
    value.to_writer_binary(&mut bytes).unwrap();
    let out = ok_json(&plist_parse(&bytes, "{}"));
    assert_eq!(out["truncated"], true);
    // Walk down to the marker.
    let mut node = &out["result"]["root"];
    let mut depth = 0;
    while let Some(first) = node.get(0) {
        node = first;
        depth += 1;
        if depth > 40 {
            break;
        }
    }
    assert_eq!(node["$type"], "truncated");
    assert!(out["result"]["max_depth_seen"].as_u64().unwrap() >= 32);
}

#[test]
fn plist_item_cap() {
    let value = plist::Value::Array(
        (0..10).map(|i| plist::Value::Integer(i.into())).collect(),
    );
    let mut bytes = Vec::new();
    value.to_writer_binary(&mut bytes).unwrap();
    let out = ok_json(&plist_parse(&bytes, r#"{"max_items":4}"#));
    assert_eq!(out["truncated"], true);
    assert_eq!(out["result"]["root"].as_array().unwrap().len(), 4);
}

#[test]
fn fsevents_decodes() {
    let out = ok_json(&fsevents_parse(&fsevents_fixture(), "{}"));
    assert_eq!(out["format"], "fsevents");
    let result = &out["result"];
    assert_eq!(result["page_count"], 2);
    assert_eq!(result["record_count"], 3);
    assert_eq!(result["records"][0]["event_id"], 0x1122);
    assert_eq!(result["records"][0]["path"], "/Users/test/file.txt");
    assert_eq!(result["records"][0]["node_id"], 99);
    let names: Vec<&str> = result["records"][0]["flags"]["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(names.contains(&"Created"));
    assert!(names.contains(&"IsFile"));
    let names2: Vec<&str> = result["records"][1]["flags"]["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(names2.contains(&"Removed"));
    assert!(names2.contains(&"IsDirectory"));
    // v3 record carries the trailer.
    assert_eq!(result["records"][2]["event_id"], 0x99);
    assert!(result["records"][2].get("trailer").is_some());
}

#[test]
fn fsevents_raw_stream() {
    // Uncompressed page stream also parses.
    let stream = fsevents_page(
        b"1SLD",
        &fsevents_record("/v1/only", 7, 0x1, None, false),
    );
    let out = ok_json(&fsevents_parse(&stream, "{}"));
    assert_eq!(out["result"]["compressed"], false);
    assert_eq!(out["result"]["records"][0]["path"], "/v1/only");
    assert!(out["result"]["records"][0].get("node_id").is_none());
}

#[test]
fn fsevents_malformed() {
    assert_eq!(err_json(&fsevents_parse(b"not gzip or pages", "{}"))["error"], "not_fsevents");
    // Corrupt gzip member.
    assert_eq!(
        err_json(&fsevents_parse(&[0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0], "{}"))["error"],
        "invalid_gzip"
    );
    // Truncated record mid-page: warn but keep the earlier record.
    let mut page = fsevents_page(
        b"2SLD",
        &fsevents_record("/ok", 1, 0x1, Some(2), false),
    );
    // Append a second page with a truncated record inside its stream size.
    let mut tail = b"2SLD".to_vec();
    tail.extend_from_slice(&0u32.to_le_bytes());
    tail.extend_from_slice(&20u32.to_le_bytes()); // header + partial record
    tail.extend_from_slice(b"/cut\0\x01\x02");
    page.extend_from_slice(&tail);
    let out = ok_json(&fsevents_parse(&gzip(&page), "{}"));
    assert_eq!(out["result"]["record_count"], 1);
    assert!(out["warnings"].as_array().unwrap().len() >= 1);
}

#[test]
fn fsevents_record_cap() {
    let mut records = Vec::new();
    for i in 0..8u64 {
        records.extend_from_slice(&fsevents_record("/p", i, 0x1, Some(i), false));
    }
    let stream = fsevents_page(b"2SLD", &records);
    let out = ok_json(&fsevents_parse(&gzip(&stream), r#"{"max_results":3}"#));
    assert_eq!(out["result"]["record_count"], 8);
    assert_eq!(out["result"]["records_returned"], 3);
    assert_eq!(out["truncated"], true);
}

#[test]
fn ds_store_decodes() {
    let out = ok_json(&ds_store_parse(&dsstore_fixture(), "{}"));
    assert_eq!(out["format"], "ds_store");
    let result = &out["result"];
    assert_eq!(result["superblock"]["page_size"], 4096);
    assert_eq!(result["record_count"], 3);
    assert_eq!(result["records"][0]["filename"], "Icon");
    assert_eq!(result["records"][0]["code"], "Iloc");
    assert_eq!(result["records"][0]["value"]["x"], 10);
    assert_eq!(result["records"][0]["value"]["y"], 20);
    assert_eq!(result["records"][1]["value"], 7);
    assert_eq!(result["records"][2]["value"], "hello");
}

#[test]
fn ds_store_malformed() {
    assert_eq!(err_json(&ds_store_parse(b"short", "{}"))["error"], "invalid_ds_store");
    let mut bad = dsstore_fixture();
    bad[4..8].copy_from_slice(b"XXXX");
    assert_eq!(err_json(&ds_store_parse(&bad, "{}"))["error"], "invalid_ds_store");
}

#[test]
fn ds_store_cycle_guarded() {
    // Point the root node at itself through an internal-node child link.
    let mut file = dsstore_fixture();
    // Rewrite the leaf at 2116 as an internal node that references itself.
    let mut node = Vec::new();
    node.extend_from_slice(&1u32.to_be_bytes()); // next_node = block 1 (itself)
    node.extend_from_slice(&1u32.to_be_bytes()); // count = 1
    node.extend_from_slice(&1u32.to_be_bytes()); // child -> block 1 (cycle)
    // One entry so the loop body completes.
    node.extend_from_slice(&1u32.to_be_bytes());
    node.extend_from_slice(&[0, 0x41]); // filename "A" utf-16be
    node.extend_from_slice(b"cyc0long");
    node.extend_from_slice(&1u32.to_be_bytes());
    node.resize(256, 0);
    file[2116..2116 + 256].copy_from_slice(&node);
    let out = ok_json(&ds_store_parse(&file, "{}"));
    // Terminates; cycle warning emitted.
    let warnings = out["warnings"].as_array().unwrap();
    assert!(warnings.iter().any(|w| w.as_str().unwrap().contains("cyclic")));
}

#[test]
fn unified_log_decodes() {
    let out = ok_json(&unified_log_parse(&tracev3_fixture(), "{}"));
    assert_eq!(out["format"], "unified_log");
    let result = &out["result"];
    assert_eq!(result["header"]["boot_uuid"], "00112233445566778899AABBCCDDEEFF");
    assert_eq!(result["header"]["logd_pid"], 77);
    assert_eq!(result["catalog_count"], 1);
    assert_eq!(result["entry_count"], 1);
    let entry = &result["entries"][0];
    assert_eq!(entry["pid"], 501);
    assert_eq!(entry["euid"], 20);
    assert_eq!(entry["thread_id"], 0x1234);
    assert_eq!(entry["subsystem"], "com.turen.test");
    assert_eq!(entry["category"], "default");
    assert_eq!(entry["event_type"], "Log");
    // uuidtext unavailable -> explicit missing-string marker, counted.
    assert!(entry["message"]
        .as_str()
        .unwrap()
        .contains("Failed to get string message from UUIDText file"));
    assert_eq!(result["missing_message_entries"], 1);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("unresolved format strings")));
}

#[test]
fn unified_log_malformed() {
    assert_eq!(err_json(&unified_log_parse(b"garbage", "{}"))["error"], "invalid_tracev3");
    // Truncated tail chunk: prefix parses, warning emitted.
    let mut truncated = tracev3_fixture();
    truncated.extend_from_slice(&[0x0d, 0x60, 0, 0, 0x11, 0, 0, 0, 0xff]);
    let out = ok_json(&unified_log_parse(&truncated, "{}"));
    assert_eq!(out["result"]["entry_count"], 1);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("tail truncated")));
}

#[test]
fn analyze_dispatches() {
    assert_eq!(ok_json(&analyze(&binary_plist(), "{}"))["format"], "plist");
    assert_eq!(ok_json(&analyze(&fsevents_fixture(), "{}"))["format"], "fsevents");
    assert_eq!(ok_json(&analyze(&dsstore_fixture(), "{}"))["format"], "ds_store");
    assert_eq!(ok_json(&analyze(&tracev3_fixture(), "{}"))["format"], "unified_log");
    assert_eq!(err_json(&analyze(b"\x00\x01\x02\x03", "{}"))["error"], "unknown_artifact");
}

#[test]
fn bounds_enforced() {
    assert_eq!(err_json(&plist_parse(&[], "{}"))["error"], "empty_input");
    let oversized = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(err_json(&plist_parse(&oversized, "{}"))["error"], "input_too_large");
    assert_eq!(
        err_json(&plist_parse(&binary_plist(), &" ".repeat(MAX_OPTIONS_BYTES + 1)))["error"],
        "options_too_large"
    );
    assert_eq!(err_json(&plist_parse(&binary_plist(), "[1]"))["error"], "invalid_options");
    assert_eq!(err_json(&plist_parse(&binary_plist(), "{"))["error"], "invalid_options");
}

#[test]
fn deterministic() {
    for fixture in [
        binary_plist(),
        xml_plist(),
        fsevents_fixture(),
        dsstore_fixture(),
        tracev3_fixture(),
    ] {
        let first = analyze(&fixture, "{}");
        let second = analyze(&fixture, "{}");
        assert_eq!(first, second);
    }
}
