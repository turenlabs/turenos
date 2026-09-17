//! Fabricated-fixture unit tests: every artifact is built byte by byte in
//! test code (LevelDB records with real masked CRC-32C, a minimal sstable
//! with index/footer, simple-cache entries with real SuperFastHash key
//! hashes and IEEE CRC-32 EOF records, binarycookies pages), then
//! exercised through the real op functions.

use super::*;

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

// ---------------- shared builders ----------------

fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            return out;
        }
    }
}

fn crc32c_sum(data: &[u8]) -> u32 {
    crc32c::crc32c(data)
}

// ---------------- LevelDB log fixtures ----------------

const T_FULL: u8 = 1;
const T_FIRST: u8 = 2;
const T_MIDDLE: u8 = 3;
const T_LAST: u8 = 4;

fn log_record(rtype: u8, data: &[u8]) -> Vec<u8> {
    let crc = leveldb_record_crc(rtype, data);
    let mut out = Vec::new();
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&(data.len() as u16).to_le_bytes());
    out.push(rtype);
    out.extend_from_slice(data);
    out
}

fn write_batch(seq: u64, entries: &[(u8, &[u8], Option<&[u8]>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (tag, key, value) in entries {
        out.push(*tag);
        out.extend_from_slice(&varint(key.len() as u64));
        out.extend_from_slice(key);
        if let Some(value) = value {
            out.extend_from_slice(&varint(value.len() as u64));
            out.extend_from_slice(value);
        }
    }
    out
}

fn pad_block(mut block: Vec<u8>) -> Vec<u8> {
    block.resize(LEVELDB_BLOCK_SIZE, 0);
    block
}

fn simple_log() -> Vec<u8> {
    let batch = write_batch(
        1000,
        &[
            (1, b"_http://a.com\x01key1".as_slice(), Some(b"value1")),
            (1, b"key2".as_slice(), Some(b"value2")),
            (0, b"oldkey".as_slice(), None),
        ],
    );
    pad_block(log_record(T_FULL, &batch))
}

// ---------------- LevelDB table fixtures ----------------

fn internal_key(user: &[u8], seq: u64, vtype: u8) -> Vec<u8> {
    let mut out = user.to_vec();
    out.extend_from_slice(&((seq << 8) | vtype as u64).to_le_bytes());
    out
}

/// Build a data block: entries are (full_key, value); restart_interval
/// entries restart the shared-prefix run. Returns contents without the
/// 5-byte trailer.
fn build_block(entries: &[(Vec<u8>, Vec<u8>)], restart_interval: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut restarts = Vec::new();
    let mut last_key: Vec<u8> = Vec::new();
    for (i, (key, value)) in entries.iter().enumerate() {
        let shared = if i % restart_interval == 0 {
            restarts.push(out.len() as u32);
            0
        } else {
            key.iter()
                .zip(last_key.iter())
                .take_while(|(a, b)| a == b)
                .count()
        };
        out.extend_from_slice(&varint(shared as u64));
        out.extend_from_slice(&varint((key.len() - shared) as u64));
        out.extend_from_slice(&varint(value.len() as u64));
        out.extend_from_slice(&key[shared..]);
        out.extend_from_slice(value);
        last_key = key.clone();
    }
    for r in &restarts {
        out.extend_from_slice(&r.to_le_bytes());
    }
    out.extend_from_slice(&(restarts.len() as u32).to_le_bytes());
    out
}

fn block_on_disk(contents: &[u8], compression: u8, corrupt_crc: bool) -> Vec<u8> {
    let mut out = contents.to_vec();
    out.push(compression);
    let crc = mask_crc(crc32c_sum(&[contents, &[compression]].concat()));
    out.extend_from_slice(&(crc ^ if corrupt_crc { 0xffff } else { 0 }).to_le_bytes());
    out
}

fn handle_bytes(offset: u64, size: u64) -> Vec<u8> {
    let mut out = varint(offset);
    out.extend_from_slice(&varint(size));
    out
}

/// Literal-only snappy stream: varint uncompressed length + literal runs
/// (a valid raw-snappy encoding).
fn snappy_literal(data: &[u8]) -> Vec<u8> {
    let mut out = varint(data.len() as u64);
    let mut rest = data;
    while !rest.is_empty() {
        let take = rest.len().min(1 << 16);
        let len = take - 1;
        if take <= 60 {
            out.push((len << 2) as u8);
        } else if take <= 256 {
            out.push(60 << 2);
            out.push(len as u8);
        } else {
            out.push(61 << 2);
            out.push((len & 0xff) as u8);
            out.push((len >> 8) as u8);
        }
        out.extend_from_slice(&rest[..take]);
        rest = &rest[take..];
    }
    out
}

fn sample_table() -> Vec<u8> {
    let data1 = build_block(
        &[
            (internal_key(b"alpha", 100, 1), b"v1".to_vec()),
            (internal_key(b"alphabet", 99, 1), b"v2".to_vec()),
            (internal_key(b"beta", 98, 0), b"".to_vec()),
        ],
        4,
    );
    let data2 = build_block(
        &[(internal_key(b"gamma", 97, 1), b"gval".to_vec())],
        1,
    );
    let metaindex = build_block(
        &[(b"filter.leveldb.BuiltinBloomFilter2".to_vec(), handle_bytes(0, 0))],
        1,
    );
    // Layout: data1 | data2 | metaindex | index | footer.
    let mut file = Vec::new();
    let d1_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&data1, 0, false));
    let d2_off = file.len() as u64;
    let snappy = snappy_literal(&data2);
    file.extend_from_slice(&block_on_disk(&snappy, 1, false));
    let meta_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&metaindex, 0, false));
    let index = build_block(
        &[
            (internal_key(b"alphabet", 99, 1), handle_bytes(d1_off, data1.len() as u64)),
            (internal_key(b"zzz", 1, 1), handle_bytes(d2_off, snappy.len() as u64)),
        ],
        1,
    );
    let idx_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&index, 0, false));
    // Footer: metaindex handle, index handle, pad to 40, magic.
    let mut footer = handle_bytes(meta_off, metaindex.len() as u64);
    footer.extend_from_slice(&handle_bytes(idx_off, index.len() as u64));
    footer.resize(40, 0);
    footer.extend_from_slice(&0xdb4775248b80fb57u64.to_le_bytes());
    assert_eq!(footer.len(), 48);
    file.extend_from_slice(&footer);
    file
}

// ---------------- simple cache fixtures ----------------

fn eof_record(flags: u32, crc: u32, stream_size: u32) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&simplecache::FINAL_MAGIC.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&stream_size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

fn header(key: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&simplecache::INITIAL_MAGIC.to_le_bytes());
    out.extend_from_slice(&5u32.to_le_bytes());
    out.extend_from_slice(&(key.len() as u32).to_le_bytes());
    out.extend_from_slice(&crate::simplecache::super_fast_hash(key).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(key);
    out
}

fn ieee_crc(data: &[u8]) -> u32 {
    crate::simplecache::crc32_ieee(data)
}

fn response_info_pickle() -> Vec<u8> {
    let headers = b"HTTP/1.1 200 OK\0content-type: text/html\0content-length: 5\0\0";
    let mut payload = Vec::new();
    payload.extend_from_slice(&0x80000003u32.to_le_bytes()); // flags: v3 + extra
    payload.extend_from_slice(&4u32.to_le_bytes()); // extra_flags: has original
    payload.extend_from_slice(&13340000000000000i64.to_le_bytes()); // request
    payload.extend_from_slice(&13340000001000000i64.to_le_bytes()); // response
    payload.extend_from_slice(&13340000000500000i64.to_le_bytes()); // original
    payload.extend_from_slice(&(headers.len() as u32).to_le_bytes());
    payload.extend_from_slice(headers);
    payload.resize((payload.len() + 3) & !3, 0);
    let mut out = (payload.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&payload);
    out
}

fn combined_entry(key: &[u8], stream1: &[u8], stream0: &[u8], with_sha: bool) -> Vec<u8> {
    let mut out = header(key);
    out.extend_from_slice(stream1);
    out.extend_from_slice(&eof_record(1, ieee_crc(stream1), 0));
    out.extend_from_slice(stream0);
    if with_sha {
        use sha2::Digest;
        out.extend_from_slice(&sha2::Sha256::digest(key));
    }
    let flags = if with_sha { 3 } else { 1 };
    out.extend_from_slice(&eof_record(flags, ieee_crc(stream0), stream0.len() as u32));
    out
}

// ---------------- binarycookies fixtures ----------------

fn cookie_record(
    domain: &str,
    name: &str,
    path: &str,
    value: &str,
    flags: u32,
    expires: f64,
    created: f64,
) -> Vec<u8> {
    let mut strings = Vec::new();
    let mut offsets = [0u32; 4];
    for (i, s) in [domain, name, path, value].iter().enumerate() {
        offsets[i] = (56 + strings.len()) as u32;
        strings.extend_from_slice(s.as_bytes());
        strings.push(0);
    }
    let size = (56 + strings.len()) as u32;
    let mut out = Vec::new();
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for off in offsets {
        out.extend_from_slice(&off.to_le_bytes());
    }
    out.extend_from_slice(&0u64.to_le_bytes()); // comment off + end marker
    out.extend_from_slice(&expires.to_le_bytes());
    out.extend_from_slice(&created.to_le_bytes());
    out.extend_from_slice(&strings);
    out
}

fn binarycookies_fixture() -> Vec<u8> {
    let c1 = cookie_record(".example.com", "sess", "/", "abc123", 5, 700000000.0, 600000000.0);
    let c2 = cookie_record(".other.net", "pref", "/p", "x", 0, 800000000.0, 500000000.0);
    let mut page = Vec::new();
    page.extend_from_slice(&0x00000100u32.to_be_bytes());
    page.extend_from_slice(&2u32.to_le_bytes());
    let off1 = 8 + 8 + 4;
    page.extend_from_slice(&(off1 as u32).to_le_bytes());
    page.extend_from_slice(&((off1 + c1.len()) as u32).to_le_bytes());
    page.extend_from_slice(&0u32.to_le_bytes());
    page.extend_from_slice(&c1);
    page.extend_from_slice(&c2);

    let mut file = Vec::new();
    file.extend_from_slice(b"cook");
    file.extend_from_slice(&1u32.to_be_bytes());
    file.extend_from_slice(&(page.len() as u32).to_be_bytes());
    file.extend_from_slice(&page);
    let mut sum: u32 = 0;
    for i in (0..page.len()).step_by(4) {
        sum = sum.wrapping_add(page[i] as u32);
    }
    file.extend_from_slice(&sum.to_be_bytes());
    file.extend_from_slice(&[0x07, 0x17, 0x20, 0x05, 0, 0, 0, 0x4b]);
    file.extend_from_slice(b"bplist00fakemetadata");
    file
}

// ---------------- log tests ----------------

#[test]
fn log_decodes_batch() {
    let out = ok_json(&leveldb_log_parse(&simple_log(), "{}"));
    assert_eq!(out["format"], "leveldb_log");
    let result = &out["result"];
    assert_eq!(result["physical_records"], 1);
    assert_eq!(result["logical_records"], 1);
    assert_eq!(result["write_batches"], 1);
    assert_eq!(result["batch_entries"], 3);
    assert_eq!(result["record_count"], 3);
    let rec = &result["records"][0];
    assert_eq!(rec["operation"], "put");
    assert_eq!(rec["batch_sequence"], 1000);
    assert_eq!(rec["sequence"], 1000);
    assert_eq!(rec["entry_index"], 0);
    assert_eq!(rec["key"]["utf8"], "_http://a.com\u{1}key1");
    assert_eq!(rec["value"]["utf8"], "value1");
    assert_eq!(result["records"][2]["operation"], "delete");
    assert_eq!(result["records"][2]["sequence"], 1002);
    assert!(result["records"][2]["value"].is_null());
    assert_eq!(result["crc_failures"], 0);
}

#[test]
fn log_fragmented_across_blocks() {
    // A batch whose value forces fragmentation: FIRST fills block 0's
    // last bytes, LAST completes in block 1.
    let big_value = vec![0x61u8; 40000];
    let batch = write_batch(7, &[(1, b"k".as_slice(), Some(&big_value))]);
    let first_len = LEVELDB_BLOCK_SIZE - 7;
    let mut file = log_record(T_FIRST, &batch[..first_len]);
    file.extend_from_slice(&log_record(T_LAST, &batch[first_len..]));
    let out = ok_json(&leveldb_log_parse(&file, "{}"));
    let result = &out["result"];
    assert_eq!(result["logical_records"], 1);
    assert_eq!(result["write_batches"], 1);
    assert_eq!(result["record_count"], 1);
    assert_eq!(result["records"][0]["value"]["length"], 40000);
    assert_eq!(result["records"][0]["operation"], "put");
}

#[test]
fn log_fragment_middle_last() {
    // FIRST + MIDDLE + LAST spanning three blocks.
    let big = vec![0x62u8; 70000];
    let batch = write_batch(9, &[(1, b"mk".as_slice(), Some(&big))]);
    let first_len = LEVELDB_BLOCK_SIZE - 7;
    let middle_len = LEVELDB_BLOCK_SIZE - 7;
    let mut file = log_record(T_FIRST, &batch[..first_len]);
    file.extend_from_slice(&log_record(
        T_MIDDLE,
        &batch[first_len..first_len + middle_len],
    ));
    file.extend_from_slice(&log_record(T_LAST, &batch[first_len + middle_len..]));
    let out = ok_json(&leveldb_log_parse(&file, "{}"));
    assert_eq!(out["result"]["record_count"], 1);
    assert_eq!(out["result"]["records"][0]["value"]["length"], 70000);
}

#[test]
fn log_corrupt_crc_flagged_not_fatal() {
    let batch1 = write_batch(1, &[(1, b"good".as_slice(), Some(b"one"))]);
    let batch2 = write_batch(2, &[(1, b"next".as_slice(), Some(b"two"))]);
    let mut bad = log_record(T_FULL, &batch1);
    bad[0] ^= 0xff; // corrupt the stored crc
    let mut file = pad_block(bad);
    file.extend_from_slice(&pad_block(log_record(T_FULL, &batch2)));
    let out = ok_json(&leveldb_log_parse(&file, "{}"));
    let result = &out["result"];
    assert_eq!(result["crc_failures"], 1);
    assert_eq!(result["corrupt_records"], 1);
    // The second block's record still decodes.
    assert_eq!(result["record_count"], 1);
    assert_eq!(result["records"][0]["key"]["utf8"], "next");
    assert!(!out["warnings"].as_array().unwrap().is_empty());
}

#[test]
fn log_verify_crc_false_accepts_bad_crc() {
    let batch = write_batch(1, &[(1, b"good".as_slice(), Some(b"one"))]);
    let mut bad = log_record(T_FULL, &batch);
    bad[0] ^= 0xff;
    let file = pad_block(bad);
    let out = ok_json(&leveldb_log_parse(&file, r#"{"verify_crc":false}"#));
    assert_eq!(out["result"]["record_count"], 1);
    assert_eq!(out["result"]["crc_failures"], 0);
}

#[test]
fn log_unparsed_manifest_record() {
    // A VersionEdit-ish payload: valid physical record, not a WriteBatch.
    // seq=0xdead, count=0 then trailing bytes -> strict batch decode fails.
    let mut payload = Vec::new();
    payload.extend_from_slice(&0xdeadu64.to_le_bytes());
    payload.extend_from_slice(&0u32.to_le_bytes());
    payload.extend_from_slice(b"VersionEdit-ish");
    let file = pad_block(log_record(T_FULL, &payload));
    let out = ok_json(&leveldb_log_parse(&file, "{}"));
    let result = &out["result"];
    assert_eq!(result["unparsed_records"], 1);
    assert_eq!(result["write_batches"], 0);
    assert_eq!(result["records"][0]["operation"], "unparsed");
    assert_eq!(result["records"][0]["reason"], "not_write_batch");
    assert_eq!(result["records"][0]["value"]["length"], payload.len());
}

#[test]
fn log_orphan_fragment_warns() {
    let batch = write_batch(3, &[(1, b"x".as_slice(), Some(b"y"))]);
    let file = pad_block(log_record(T_LAST, &batch));
    let out = ok_json(&leveldb_log_parse(&file, "{}"));
    assert_eq!(out["result"]["logical_records"], 0);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("orphan")));
}

#[test]
fn log_nonzero_trailer_warns() {
    // Record ends at 32765; the last 3 bytes are a nonzero block trailer.
    let mut block = log_record(T_FULL, &vec![0u8; LEVELDB_BLOCK_SIZE - 10]);
    assert_eq!(block.len(), LEVELDB_BLOCK_SIZE - 3);
    block.extend_from_slice(&[0xaa, 0xbb, 0xcc]);
    let out = ok_json(&leveldb_log_parse(&block, "{}"));
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("trailer")));
}

#[test]
fn log_zero_first_fills_block() {
    // Exactly-7-byte FIRST with empty payload at block end (the documented
    // "fill the trailing seven bytes" case), then LAST in the next block.
    // A real writer packs records back-to-back, so the prior record ends
    // at 32761 and the FIRST fills the trailing seven bytes.
    let batch = write_batch(11, &[(1, b"edge".as_slice(), Some(b"case"))]);
    let mut file = log_record(T_FULL, &vec![0x41u8; LEVELDB_BLOCK_SIZE - 14]);
    assert_eq!(file.len(), LEVELDB_BLOCK_SIZE - 7);
    file.extend_from_slice(&log_record(T_FIRST, &[]));
    file.extend_from_slice(&pad_block(log_record(T_LAST, &batch)));
    let out = ok_json(&leveldb_log_parse(&file, "{}"));
    assert_eq!(out["result"]["logical_records"], 2);
    assert_eq!(out["result"]["records"][1]["key"]["utf8"], "edge");
}

#[test]
fn log_max_results_truncates() {
    let owned: Vec<(u8, Vec<u8>, Option<Vec<u8>>)> = (0..10)
        .map(|i| (1u8, format!("key{i}").into_bytes(), Some(format!("val{i}").into_bytes())))
        .collect();
    let refs: Vec<(u8, &[u8], Option<&[u8]>)> = owned
        .iter()
        .map(|(t, k, v)| (*t, k.as_slice(), v.as_deref()))
        .collect();
    let batch = write_batch(50, &refs);
    let file = pad_block(log_record(T_FULL, &batch));
    let out = ok_json(&leveldb_log_parse(&file, r#"{"max_results":3}"#));
    assert_eq!(out["result"]["record_count"], 10);
    assert_eq!(out["result"]["records_returned"], 3);
    assert_eq!(out["truncated"], true);
}

#[test]
fn log_rejects_garbage_and_empty() {
    assert_eq!(err_json(&leveldb_log_parse(b"", "{}"))["error"], "empty_input");
    assert_eq!(
        err_json(&leveldb_log_parse(&vec![0xAA; 4096], "{}"))["error"],
        "not_leveldb_log"
    );
    assert_eq!(
        err_json(&leveldb_log_parse(b"tiny", "{}"))["error"],
        "not_leveldb_log"
    );
}

#[test]
fn log_input_too_large() {
    let big = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(
        err_json(&leveldb_log_parse(&big, "{}"))["error"],
        "input_too_large"
    );
}

// ---------------- table tests ----------------

#[test]
fn table_decodes() {
    let out = ok_json(&leveldb_table_parse(&sample_table(), "{}"));
    assert_eq!(out["format"], "leveldb_table");
    let result = &out["result"];
    assert_eq!(result["footer"]["magic"], "0xdb4775248b80fb57");
    assert_eq!(result["index_entry_count"], 2);
    assert_eq!(result["data_blocks_walked"], 2);
    assert_eq!(result["snappy_blocks"], 1);
    assert_eq!(result["uncompressed_blocks"], 1);
    assert_eq!(result["record_count"], 4);
    let recs = result["records"].as_array().unwrap();
    assert_eq!(recs[0]["key"]["utf8"], "alpha");
    assert_eq!(recs[0]["sequence"], 100);
    assert_eq!(recs[0]["operation"], "put");
    assert_eq!(recs[0]["value"]["utf8"], "v1");
    // Shared-prefix key decoded correctly.
    assert_eq!(recs[1]["key"]["utf8"], "alphabet");
    // Tombstone surfaces as delete.
    assert_eq!(recs[2]["operation"], "delete");
    assert_eq!(recs[2]["key"]["utf8"], "beta");
    assert_eq!(recs[3]["key"]["utf8"], "gamma");
    assert_eq!(result["metaindex_entries"][0]["key"]["utf8"], "filter.leveldb.BuiltinBloomFilter2");
}

#[test]
fn table_include_index() {
    let table = sample_table();
    let out = ok_json(&leveldb_table_parse(&table, r#"{"include_index":true}"#));
    let index_entries = out["result"]["index_entries"].as_array().unwrap();
    assert_eq!(index_entries.len(), 2);
    assert_eq!(index_entries[0]["key"]["user_key"]["utf8"], "alphabet");
    assert!(index_entries[0]["handle"]["offset"].as_u64().unwrap() < index_entries[1]["handle"]["offset"].as_u64().unwrap());
    let without = ok_json(&leveldb_table_parse(&table, "{}"));
    assert!(without["result"].get("index_entries").is_none());
}

#[test]
fn table_bad_magic_and_truncated() {
    let mut table = sample_table();
    let n = table.len();
    table[n - 1] ^= 0xff;
    assert_eq!(
        err_json(&leveldb_table_parse(&table, "{}"))["error"],
        "invalid_sstable"
    );
    assert_eq!(
        err_json(&leveldb_table_parse(&vec![0u8; 20], "{}"))["error"],
        "invalid_sstable"
    );
    assert_eq!(
        err_json(&leveldb_table_parse(&sample_table()[..40], "{}"))["error"],
        "invalid_sstable"
    );
}

#[test]
fn table_corrupt_block_crc_flagged() {
    // Rebuild with a corrupt crc on the first data block.
    let data1 = build_block(&[(internal_key(b"aa", 5, 1), b"v".to_vec())], 1);
    let metaindex = build_block(&[(b"m".to_vec(), handle_bytes(0, 0))], 1);
    let mut file = Vec::new();
    let d1_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&data1, 0, true));
    let meta_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&metaindex, 0, false));
    let index = build_block(
        &[(internal_key(b"aa", 5, 1), handle_bytes(d1_off, data1.len() as u64))],
        1,
    );
    let idx_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&index, 0, false));
    let mut footer = handle_bytes(meta_off, metaindex.len() as u64);
    footer.extend_from_slice(&handle_bytes(idx_off, index.len() as u64));
    footer.resize(40, 0);
    footer.extend_from_slice(&0xdb4775248b80fb57u64.to_le_bytes());
    file.extend_from_slice(&footer);
    let out = ok_json(&leveldb_table_parse(&file, "{}"));
    assert_eq!(out["result"]["crc_failures"], 1);
    assert_eq!(out["result"]["blocks"][2]["crc_valid"], false);
    // Entries still recovered.
    assert_eq!(out["result"]["record_count"], 1);
}

#[test]
fn table_unknown_compression_warns() {
    let data1 = build_block(&[(internal_key(b"aa", 5, 1), b"v".to_vec())], 1);
    let metaindex = build_block(&[(b"m".to_vec(), handle_bytes(0, 0))], 1);
    let mut file = Vec::new();
    let d1_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&data1, 9, false)); // bogus compression
    let meta_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&metaindex, 0, false));
    let index = build_block(
        &[(internal_key(b"aa", 5, 1), handle_bytes(d1_off, data1.len() as u64))],
        1,
    );
    let idx_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&index, 0, false));
    let mut footer = handle_bytes(meta_off, metaindex.len() as u64);
    footer.extend_from_slice(&handle_bytes(idx_off, index.len() as u64));
    footer.resize(40, 0);
    footer.extend_from_slice(&0xdb4775248b80fb57u64.to_le_bytes());
    file.extend_from_slice(&footer);
    let out = ok_json(&leveldb_table_parse(&file, "{}"));
    assert_eq!(out["result"]["blocks_failed"], 1);
    assert_eq!(out["result"]["record_count"], 0);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("compression type 9")));
}

#[test]
fn table_restart_array_edge_cases() {
    // num_restarts = 0: warn but still decode entries sequentially.
    let mut block = Vec::new();
    let key = internal_key(b"k1", 3, 1);
    block.extend_from_slice(&varint(0));
    block.extend_from_slice(&varint(key.len() as u64));
    block.extend_from_slice(&varint(1));
    block.extend_from_slice(&key);
    block.push(b'v');
    block.extend_from_slice(&0u32.to_le_bytes()); // num_restarts = 0
    let metaindex = build_block(&[(b"m".to_vec(), handle_bytes(0, 0))], 1);
    let mut file = Vec::new();
    let d_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&block, 0, false));
    let m_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&metaindex, 0, false));
    let index = build_block(
        &[(internal_key(b"k1", 3, 1), handle_bytes(d_off, block.len() as u64))],
        1,
    );
    let i_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&index, 0, false));
    let mut footer = handle_bytes(m_off, metaindex.len() as u64);
    footer.extend_from_slice(&handle_bytes(i_off, index.len() as u64));
    footer.resize(40, 0);
    footer.extend_from_slice(&0xdb4775248b80fb57u64.to_le_bytes());
    file.extend_from_slice(&footer);
    let out = ok_json(&leveldb_table_parse(&file, "{}"));
    assert_eq!(out["result"]["record_count"], 1);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("restart array is empty")));
}

#[test]
fn table_short_internal_key() {
    let data = build_block(&[(b"tiny".to_vec(), b"v".to_vec())], 1);
    let metaindex = build_block(&[(b"m".to_vec(), handle_bytes(0, 0))], 1);
    let mut file = Vec::new();
    let d_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&data, 0, false));
    let m_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&metaindex, 0, false));
    let index = build_block(
        &[(internal_key(b"t", 1, 1), handle_bytes(d_off, data.len() as u64))],
        1,
    );
    let i_off = file.len() as u64;
    file.extend_from_slice(&block_on_disk(&index, 0, false));
    let mut footer = handle_bytes(m_off, metaindex.len() as u64);
    footer.extend_from_slice(&handle_bytes(i_off, index.len() as u64));
    footer.resize(40, 0);
    footer.extend_from_slice(&0xdb4775248b80fb57u64.to_le_bytes());
    file.extend_from_slice(&footer);
    let out = ok_json(&leveldb_table_parse(&file, "{}"));
    assert_eq!(out["result"]["records"][0]["operation"], "unparsed");
    assert_eq!(out["result"]["records"][0]["key"]["utf8"], "tiny");
}

// ---------------- cache tests ----------------

#[test]
fn cache_combined_entry() {
    let key = b"https://example.com/x";
    let stream1 = b"<html>hello</html>";
    let stream0 = response_info_pickle();
    let file = combined_entry(key, stream1, &stream0, true);
    let out = ok_json(&chrome_cache_parse(&file, "{}"));
    assert_eq!(out["format"], "chrome_cache");
    let result = &out["result"];
    assert_eq!(result["layout"], "combined");
    assert_eq!(result["header"]["version"], 5);
    assert_eq!(result["header"]["key_hash_valid"], true);
    assert_eq!(result["key"]["utf8"], "https://example.com/x");
    assert_eq!(result["key_sha256_valid"], true);
    assert_eq!(result["streams"].as_array().unwrap().len(), 2);
    let s1 = &result["streams"][0];
    assert_eq!(s1["index"], 1);
    assert_eq!(s1["data_length"], stream1.len());
    assert_eq!(s1["eof"]["crc32_valid"], true);
    let s0 = &result["streams"][1];
    assert_eq!(s0["index"], 0);
    assert_eq!(s0["eof"]["has_key_sha256"], true);
    assert_eq!(s0["eof"]["crc32_valid"], true);
    let info = &s0["response_info"];
    assert_eq!(info["version"], 3);
    assert_eq!(info["status_line"], "HTTP/1.1 200 OK");
    assert_eq!(info["header_count"], 2);
    assert_eq!(info["headers"][0], "content-type: text/html");
    // 13340000000000000us Chromium = 1695553600.0 unix... check conversion.
    let unix = info["request_time"]["unix_seconds"].as_f64().unwrap();
    assert!(unix > 1_600_000_000.0 && unix < 2_000_000_000.0);
    assert!(info.get("original_response_time").is_some());
}

#[test]
fn cache_combined_no_sha() {
    let key = b"https://no.sha/";
    let file = combined_entry(key, b"body", &response_info_pickle(), false);
    let out = ok_json(&chrome_cache_parse(&file, "{}"));
    assert_eq!(out["result"]["layout"], "combined");
    assert_eq!(out["result"]["key_sha256_valid"], serde_json::Value::Null);
    assert_eq!(out["result"]["streams"][1]["eof"]["has_key_sha256"], false);
}

#[test]
fn cache_single_stream_file() {
    let key = b"https://stream2/";
    let mut file = header(key);
    let data = b"stream two data";
    file.extend_from_slice(data);
    file.extend_from_slice(&eof_record(1, ieee_crc(data), 0));
    let out = ok_json(&chrome_cache_parse(&file, "{}"));
    assert_eq!(out["result"]["layout"], "single_stream");
    assert_eq!(out["result"]["streams"][0]["index"], 2);
    assert_eq!(out["result"]["streams"][0]["data_length"], data.len());
}

#[test]
fn cache_missing_eof_warns() {
    let key = b"https://noeof/";
    let mut file = header(key);
    file.extend_from_slice(b"orphan data no eof");
    let out = ok_json(&chrome_cache_parse(&file, "{}"));
    assert_eq!(out["result"]["eof_present"], false);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("SimpleFileEOF")));
}

#[test]
fn cache_key_hash_mismatch_warns() {
    let key = b"https://tampered/";
    let mut file = header(key);
    // Corrupt stored key_hash.
    file[16] ^= 0xff;
    file.extend_from_slice(b"data");
    file.extend_from_slice(&eof_record(1, ieee_crc(b"data"), 0));
    let out = ok_json(&chrome_cache_parse(&file, "{}"));
    assert_eq!(out["result"]["header"]["key_hash_valid"], false);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("key_hash")));
}

#[test]
fn cache_sparse_file() {
    let mut file = Vec::new();
    file.extend_from_slice(&simplecache::SPARSE_MAGIC.to_le_bytes());
    let range1 = b"range-one-bytes!";
    file.extend_from_slice(&0u64.to_le_bytes());
    file.extend_from_slice(&(range1.len() as u64).to_le_bytes());
    file.extend_from_slice(&ieee_crc(range1).to_le_bytes());
    file.extend_from_slice(&0u32.to_le_bytes());
    file.extend_from_slice(range1);
    file.extend_from_slice(&simplecache::SPARSE_MAGIC.to_le_bytes());
    let range2 = b"r2";
    file.extend_from_slice(&0x1000u64.to_le_bytes());
    file.extend_from_slice(&(range2.len() as u64).to_le_bytes());
    file.extend_from_slice(&ieee_crc(range2).to_le_bytes());
    file.extend_from_slice(&0u32.to_le_bytes());
    file.extend_from_slice(range2);
    let out = ok_json(&chrome_cache_parse(&file, "{}"));
    assert_eq!(out["result"]["kind"], "chrome_cache_sparse");
    assert_eq!(out["result"]["range_count"], 2);
    assert_eq!(out["result"]["ranges"][1]["offset"], 0x1000);
    assert_eq!(out["result"]["ranges"][0]["crc32_valid"], true);
}

#[test]
fn cache_rejects_garbage() {
    assert_eq!(
        err_json(&chrome_cache_parse(b"not a cache entry at all", "{}"))["error"],
        "invalid_cache_entry"
    );
    // Right magic, implausible key length.
    let mut bad = header(b"https://x/");
    bad[12..16].copy_from_slice(&0x7fff_ffffu32.to_le_bytes());
    assert_eq!(
        err_json(&chrome_cache_parse(&bad, "{}"))["error"],
        "invalid_cache_entry"
    );
}

// ---------------- binarycookies tests ----------------

#[test]
fn cookies_decodes() {
    let out = ok_json(&safari_cookies_parse(&binarycookies_fixture(), "{}"));
    assert_eq!(out["format"], "safari_cookies");
    let result = &out["result"];
    assert_eq!(result["page_count"], 1);
    assert_eq!(result["cookie_count"], 2);
    let c1 = &result["cookies"][0];
    assert_eq!(c1["domain"], ".example.com");
    assert_eq!(c1["name"], "sess");
    assert_eq!(c1["path"], "/");
    assert_eq!(c1["secure"], true);
    assert_eq!(c1["http_only"], true);
    assert_eq!(c1["value"]["utf8"], "abc123");
    // 700000000 + 978307200 = 1678307200 unix.
    assert_eq!(c1["expires_unix"], 1678307200);
    assert_eq!(c1["created_unix"], 1578307200);
    let c2 = &result["cookies"][1];
    assert_eq!(c2["secure"], false);
    assert_eq!(c2["value"]["utf8"], "x");
    assert_eq!(result["checksum"]["valid"], true);
    assert_eq!(result["footer_valid"], true);
    assert_eq!(result["metadata"]["kind"], "bplist");
}

#[test]
fn cookies_rejects_garbage() {
    assert_eq!(
        err_json(&safari_cookies_parse(b"not cookies", "{}"))["error"],
        "invalid_binarycookies"
    );
    // cook magic but insane page count.
    let mut bad = b"cook".to_vec();
    bad.extend_from_slice(&0xffff_ffffu32.to_be_bytes());
    assert_eq!(
        err_json(&safari_cookies_parse(&bad, "{}"))["error"],
        "invalid_binarycookies"
    );
}

#[test]
fn cookies_checksum_mismatch_warns() {
    let mut file = binarycookies_fixture();
    // Corrupt one page byte after fixture built.
    let page_start = 12;
    file[page_start + 20] ^= 0xff;
    let out = ok_json(&safari_cookies_parse(&file, "{}"));
    assert_eq!(out["result"]["checksum"]["valid"], false);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("checksum")));
}

#[test]
fn cookies_record_cap() {
    // One page with 5 cookies, cap at 2.
    let mut page = Vec::new();
    page.extend_from_slice(&0x00000100u32.to_be_bytes());
    page.extend_from_slice(&5u32.to_le_bytes());
    let records: Vec<Vec<u8>> = (0..5)
        .map(|i| cookie_record(".d.com", &format!("n{i}"), "/", "v", 0, 1.0, 1.0))
        .collect();
    let base = 8 + 4 * 5 + 4;
    let mut offset = base;
    for r in &records {
        page.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += r.len();
    }
    page.extend_from_slice(&0u32.to_le_bytes());
    for r in &records {
        page.extend_from_slice(r);
    }
    let mut file = Vec::new();
    file.extend_from_slice(b"cook");
    file.extend_from_slice(&1u32.to_be_bytes());
    file.extend_from_slice(&(page.len() as u32).to_be_bytes());
    file.extend_from_slice(&page);
    file.extend_from_slice(&0u32.to_be_bytes()); // bogus checksum ok
    file.extend_from_slice(&[0x07, 0x17, 0x20, 0x05, 0, 0, 0, 0x4b]);
    let out = ok_json(&safari_cookies_parse(&file, r#"{"max_results":2}"#));
    assert_eq!(out["result"]["cookie_count"], 5);
    assert_eq!(out["result"]["cookies_returned"], 2);
    assert_eq!(out["truncated"], true);
}

// ---------------- analyze + shared bounds ----------------

#[test]
fn analyze_dispatches() {
    assert_eq!(ok_json(&analyze(&simple_log(), "{}"))["format"], "leveldb_log");
    assert_eq!(ok_json(&analyze(&sample_table(), "{}"))["format"], "leveldb_table");
    let key = b"https://x/";
    let entry = combined_entry(key, b"body", &response_info_pickle(), true);
    assert_eq!(ok_json(&analyze(&entry, "{}"))["format"], "chrome_cache");
    assert_eq!(
        ok_json(&analyze(&binarycookies_fixture(), "{}"))["format"],
        "safari_cookies"
    );
    assert_eq!(err_json(&analyze(&[1, 2, 3, 4], "{}"))["error"], "unknown_artifact");
    assert_eq!(err_json(&analyze(b"", "{}"))["error"], "empty_input");
}

#[test]
fn options_bounds() {
    let log = simple_log();
    assert_eq!(
        err_json(&leveldb_log_parse(&log, &" ".repeat(4100)))["error"],
        "options_too_large"
    );
    assert_eq!(
        err_json(&leveldb_log_parse(&log, "{nope"))["error"],
        "invalid_options"
    );
    assert_eq!(
        err_json(&leveldb_log_parse(&log, "[1,2]"))["error"],
        "invalid_options"
    );
}

#[test]
fn fuzz_buffers_never_panic() {
    let mut state: u64 = 0x9e3779b97f4a7c15;
    let mut next = move || {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545F4914F6CDD1D)
    };
    for i in 0..300 {
        let len = 1 + (next() % 4096) as usize;
        let buf: Vec<u8> = (0..len).map(|_| (next() >> 32) as u8).collect();
        for out in [
            analyze(&buf, "{}"),
            leveldb_log_parse(&buf, "{}"),
            leveldb_table_parse(&buf, "{}"),
            chrome_cache_parse(&buf, "{}"),
            safari_cookies_parse(&buf, "{}"),
        ] {
            let value: serde_json::Value = serde_json::from_str(&out)
                .unwrap_or_else(|_| panic!("iteration {i}: invalid JSON {out}"));
            assert_eq!(value["schema_version"], 1);
        }
    }
}
