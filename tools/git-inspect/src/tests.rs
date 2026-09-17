//! End-to-end unit tests over the public API with fixtures fabricated in
//! test code (loose objects, packfiles with delta chains, DIRC indexes, pack
//! indexes, bundles). No git binary or repository is involved.

use serde_json::Value;

use crate::fixtures::*;
use crate::*;

fn ok(json: &str) -> Value {
    let value: Value = serde_json::from_str(json).unwrap();
    assert_eq!(value["schema_version"], 1, "{json}");
    assert!(value.get("error").is_none(), "{json}");
    value
}

fn err(json: &str) -> String {
    let value: Value = serde_json::from_str(json).unwrap();
    assert_eq!(value["schema_version"], 1, "{json}");
    value["error"].as_str().unwrap().to_string()
}

const BLOB: &[u8] = b"test content\n";
// Canonical git object id for `blob 13\0test content\n` (Pro Git 10.2).
const BLOB_SHA1: &str = "d670460b4b4aece5915caf5c68d12f560a9fe3e4";

fn commit_content() -> Vec<u8> {
    let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let parent = "1111111111111111111111111111111111111111";
    format!(
        "tree {tree}\nparent {parent}\nauthor A U Thor <author@example.com> 1700000000 +0000\ncommitter C O Mitter <commit@example.com> 1700000100 -0800\n\nInitial commit\n"
    )
    .into_bytes()
}

fn tag_content() -> Vec<u8> {
    format!(
        "object {}\ntype commit\ntag v1.0\ntagger T Agger <tag@example.com> 1700000200 +0000\n\nrelease notes\n",
        "2222222222222222222222222222222222222222"
    )
    .into_bytes()
}

fn tree_content() -> Vec<u8> {
    let mut out = Vec::new();
    let mut push = |mode: &str, name: &str, sha: [u8; 20]| {
        out.extend_from_slice(mode.as_bytes());
        out.push(b' ');
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        out.extend_from_slice(&sha);
    };
    push("100644", "file.txt", [0xaa; 20]);
    push("40000", "subdir", [0xbb; 20]);
    push("120000", "link", [0xcc; 20]);
    push("160000", "submodule", [0xdd; 20]);
    out
}

/// A small pack: blob base, ofs-delta on it, a commit, a blob2 base and a
/// ref-delta resolving to blob2.
fn sample_pack() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let base1 = b"hello world, this is base content".to_vec();
    let base2 = b"second base object body".to_vec();
    // copy 5 bytes of base then insert " WORLD!" → "hello WORLD!"
    let d1 = delta(
        base1.len(),
        12,
        &[copy_op(0, 5), insert_op(b" WORLD!")].concat(),
    );
    // ref-delta: copy 6 bytes of base2 + insert "!" → "second!"
    let d2 = delta(base2.len(), 7, &[copy_op(0, 6), insert_op(b"!")].concat());
    let pack = pack(&[
        PackEntry::Full(3, base1.clone()),
        PackEntry::OfsDelta(0, d1),
        PackEntry::Full(1, commit_content()),
        PackEntry::Full(3, base2.clone()),
        PackEntry::RefDelta(object_id("blob", &base2), d2),
    ]);
    (pack, base1, base2)
}

fn dirc() -> Vec<u8> {
    let mut e1 = dirc_entry("src/main.rs", [0x11; 20], 0o100644);
    e1.size = 1234;
    let mut e2 = dirc_entry("README.md", [0x22; 20], 0o100644);
    e2.stage = 1;
    e2.size = 56;
    let e3 = dirc_entry("link", [0x33; 20], 0o120000);
    let e4 = dirc_entry("sub", [0x44; 20], 0o160000);
    dirc_v23(
        2,
        &[e1, e2, e3, e4],
        &[(b"TREE", b"\x00tree-data".to_vec()), (b"REUC", vec![1, 2, 3])],
    )
}

// ---------------------------------------------------------------- identify

#[test]
fn identify_loose_objects() {
    for (kind, content) in [
        ("blob", BLOB.to_vec()),
        ("commit", commit_content()),
        ("tag", tag_content()),
        ("tree", tree_content()),
    ] {
        let value = ok(&git_identify(&loose(kind, &content)));
        assert_eq!(value["kind"], "loose-object");
        assert_eq!(value["objectType"], kind);
        assert_eq!(value["decompressionComplete"], true);
    }
}

#[test]
fn identify_pack() {
    let (pack, _, _) = sample_pack();
    let value = ok(&git_identify(&pack));
    assert_eq!(value["kind"], "pack");
    assert_eq!(value["version"], 2);
    assert_eq!(value["declaredObjects"], 5);
    assert_eq!(value["trailerSha1Valid"], true);
}

#[test]
fn identify_pack_index_v2() {
    let idx = pack_index_v2(&[[0x11; 20], [0x22; 20], [0x33; 20]]);
    let value = ok(&git_identify(&idx));
    assert_eq!(value["kind"], "pack-index");
    assert_eq!(value["version"], 2);
    assert_eq!(value["objectCount"], 3);
    assert_eq!(value["sizeMatches"], true);
    assert_eq!(value["indexSha1Valid"], true);
}

#[test]
fn identify_pack_index_v1() {
    let idx = pack_index_v1(&[[0x11; 20], [0x22; 20]]);
    let value = ok(&git_identify(&idx));
    assert_eq!(value["kind"], "pack-index");
    assert_eq!(value["version"], 1);
    assert_eq!(value["objectCount"], 2);
}

#[test]
fn identify_index() {
    let value = ok(&git_identify(&dirc()));
    assert_eq!(value["kind"], "index");
    assert_eq!(value["version"], 2);
    assert_eq!(value["declaredEntries"], 4);
    assert_eq!(value["trailerSha1Valid"], true);
}

#[test]
fn identify_bundle() {
    let value = ok(&git_identify(&bundle()));
    assert_eq!(value["kind"], "bundle");
    assert_eq!(value["version"], 2);
    assert_eq!(value["prerequisites"], 1);
    assert_eq!(value["refs"], 1);
    assert_eq!(value["packFollows"], true);
}

#[test]
fn identify_unknown_and_plain_zlib() {
    assert_eq!(ok(&git_identify(b"not anything"))["kind"], "unknown");
    // Valid zlib but not a git object header → still unknown.
    assert_eq!(ok(&git_identify(&zlib(b"random data")))["kind"], "unknown");
    assert_eq!(err(&git_identify(b"")), "empty_input");
}

#[test]
fn identify_input_too_large() {
    let big = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(err(&git_identify(&big)), "input_too_large");
}

// ------------------------------------------------------------ object decode

#[test]
fn decode_blob() {
    let value = ok(&git_object_decode(&loose("blob", BLOB), "{}"));
    assert_eq!(value["type"], "blob");
    assert_eq!(value["sha1"], BLOB_SHA1);
    assert_eq!(value["declaredSize"], 13);
    assert_eq!(value["sizeMatchesDeclared"], true);
    assert_eq!(value["content"]["utf8"], true);
    assert_eq!(value["content"]["sha256"].as_str().unwrap().len(), 64);
}

#[test]
fn decode_commit() {
    let value = ok(&git_object_decode(&loose("commit", &commit_content()), "{}"));
    assert_eq!(value["type"], "commit");
    let c = &value["content"];
    assert_eq!(c["tree"], "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    assert_eq!(c["parents"][0], "1111111111111111111111111111111111111111");
    assert_eq!(c["author"]["name"], "A U Thor");
    assert_eq!(c["author"]["email"], "author@example.com");
    assert_eq!(c["author"]["timestamp"], 1700000000i64);
    assert_eq!(c["committer"]["timezone"], "-0800");
    assert_eq!(c["message"]["text"], "Initial commit\n");
}

#[test]
fn decode_tag() {
    let value = ok(&git_object_decode(&loose("tag", &tag_content()), "{}"));
    assert_eq!(value["type"], "tag");
    let c = &value["content"];
    assert_eq!(c["object"], "2222222222222222222222222222222222222222");
    assert_eq!(c["objectType"], "commit");
    assert_eq!(c["tag"], "v1.0");
    assert_eq!(c["tagger"]["email"], "tag@example.com");
    assert_eq!(c["message"]["text"], "release notes\n");
}

#[test]
fn decode_tree() {
    let value = ok(&git_object_decode(&loose("tree", &tree_content()), "{}"));
    assert_eq!(value["type"], "tree");
    let entries = value["content"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["mode"], "0o100644");
    assert_eq!(entries[0]["name"], "file.txt");
    assert_eq!(entries[0]["kind"], "blob");
    assert_eq!(entries[1]["kind"], "tree");
    assert_eq!(entries[2]["kind"], "symlink");
    assert_eq!(entries[3]["kind"], "gitlink");
    assert_eq!(
        entries[0]["sha1"],
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
}

#[test]
fn decode_size_mismatch_and_trailing() {
    // Header declares more than the content carries.
    let raw = b"blob 99\0hi".to_vec();
    let packed = zlib(&raw);
    let value = ok(&git_object_decode(&packed, "{}"));
    assert_eq!(value["sizeMatchesDeclared"], false);
    assert!(value["warnings"].as_array().unwrap().iter().any(|w| {
        w.as_str().unwrap().contains("declared size")
    }));

    // Trailing garbage after the stream.
    let mut blob = loose("blob", BLOB);
    blob.extend_from_slice(b"GARBAGE");
    let value = ok(&git_object_decode(&blob, "{}"));
    assert_eq!(value["trailingBytes"], 7);
}

#[test]
fn decode_malformed() {
    assert_eq!(err(&git_object_decode(b"PACK....", "{}")), "not_loose_object");
    // valid zlib header, stream cut mid-way
    let mut short = loose("blob", BLOB);
    short.truncate(short.len() - 4);
    assert_eq!(err(&git_object_decode(&short, "{}")), "truncated_zlib");
    // inflated but no git header
    assert_eq!(err(&git_object_decode(&zlib(b"\0\0\0"), "{}")), "not_loose_object");
    // header without space separator
    assert_eq!(
        err(&git_object_decode(&zlib(b"blob13\0x"), "{}")),
        "not_loose_object"
    );
}

// ------------------------------------------------------------ pack inspect

#[test]
fn pack_inspect_basic() {
    let (pack, _, _) = sample_pack();
    let value = ok(&git_pack_inspect(&pack, "{}"));
    assert_eq!(value["kind"], "pack");
    assert_eq!(value["version"], 2);
    assert_eq!(value["declaredObjects"], 5);
    assert_eq!(value["parsedObjects"], 5);
    assert_eq!(value["scanComplete"], true);
    assert_eq!(value["checksum"]["valid"], true);
    let entries = value["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[0]["type"], "blob");
    assert_eq!(entries[1]["type"], "ofs_delta");
    assert_eq!(entries[1]["baseOffset"], entries[0]["offset"]);
    assert_eq!(entries[2]["type"], "commit");
    assert_eq!(entries[4]["type"], "ref_delta");
    let deltas = &value["deltas"];
    assert_eq!(deltas["ofsDeltaCount"], 1);
    assert_eq!(deltas["refDeltaCount"], 1);
    assert_eq!(deltas["maxChainDepth"], 1);
    assert_eq!(deltas["unresolvedBases"], 0);
}

#[test]
fn pack_inspect_bad_checksum() {
    let (mut pack, _, _) = sample_pack();
    let n = pack.len();
    pack[n - 1] ^= 0xff;
    let value = ok(&git_pack_inspect(&pack, "{}"));
    assert_eq!(value["checksum"]["valid"], false);
}

#[test]
fn pack_inspect_deep_ofs_chain() {
    // 3-link ofs-delta chain → maxChainDepth 3.
    let base = b"base".to_vec();
    let d = delta(4, 4, &copy_op(0, 4));
    let pack = pack(&[
        PackEntry::Full(3, base),
        PackEntry::OfsDelta(0, d.clone()),
        PackEntry::OfsDelta(1, d.clone()),
        PackEntry::OfsDelta(2, d),
    ]);
    let value = ok(&git_pack_inspect(&pack, "{}"));
    assert_eq!(value["deltas"]["ofsDeltaCount"], 3);
    assert_eq!(value["deltas"]["maxChainDepth"], 3);
    assert_eq!(value["entries"][3]["depth"], 3);
}

#[test]
fn pack_inspect_max_items() {
    let (pack, _, _) = sample_pack();
    let value = ok(&git_pack_inspect(&pack, "{\"maxItems\":2}"));
    assert_eq!(value["entries"].as_array().unwrap().len(), 2);
    assert_eq!(value["truncated"], true);
}

#[test]
fn pack_inspect_malformed() {
    assert_eq!(err(&git_pack_inspect(b"NOPE........", "{}")), "not_pack");
    // version 4 pack
    let mut bad = b"PACK".to_vec();
    bad.extend_from_slice(&4u32.to_be_bytes());
    bad.extend_from_slice(&0u32.to_be_bytes());
    bad.extend_from_slice(&[0u8; 20]);
    assert_eq!(err(&git_pack_inspect(&bad, "{}")), "unsupported_pack_version");
    // header fine, body truncated mid-entry
    let (pack, _, _) = sample_pack();
    let mut cut = pack;
    cut.truncate(40); // >= 32 minimum, but inside the first entry's stream
    let value = ok(&git_pack_inspect(&cut, "{}"));
    assert_eq!(value["parsedObjects"].as_u64().unwrap(), 0);
    assert_eq!(value["scanComplete"], false);
    // declared > actual
    let mut over = b"PACK".to_vec();
    over.extend_from_slice(&2u32.to_be_bytes());
    over.extend_from_slice(&9u32.to_be_bytes());
    let trailer = crate::sha1_bytes(&over);
    over.extend_from_slice(&trailer);
    let value = ok(&git_pack_inspect(&over, "{}"));
    assert_eq!(value["declaredObjects"], 9);
    assert_eq!(value["parsedObjects"], 0);
}

#[test]
fn pack_inspect_thin_ref_delta() {
    // ref-delta whose base is not in the pack → unresolved base.
    let delta_payload = delta(4, 4, &copy_op(0, 4));
    let pack = pack(&[
        PackEntry::Full(3, b"base".to_vec()),
        PackEntry::RefDelta([0x42; 20], delta_payload),
    ]);
    let value = ok(&git_pack_inspect(&pack, "{}"));
    assert_eq!(value["deltas"]["refDeltaCount"], 1);
    assert_eq!(value["deltas"]["unresolvedBases"], 1);
    assert_eq!(value["entries"][1]["depth"], Value::Null);
}

// ------------------------------------------------------------- pack entry

#[test]
fn pack_entry_by_index_and_offset() {
    let (pack, base1, _) = sample_pack();
    let value = ok(&git_pack_entry(&pack, "{\"index\":0}"));
    assert_eq!(value["type"], "blob");
    assert_eq!(value["size"].as_u64().unwrap() as usize, base1.len());
    assert_eq!(
        value["sha1"],
        hex_encode(&object_id("blob", &base1))
    );
    assert_eq!(value["chainDepth"], 0);
    assert_eq!(
        value["previewBase64"],
        base64_encode(&base1[..value["previewBytes"].as_u64().unwrap() as usize])
    );
    // same entry via offset
    let listed = ok(&git_pack_inspect(&pack, "{}"));
    let offset = listed["entries"][0]["offset"].as_u64().unwrap();
    let by_offset = ok(&git_pack_entry(&pack, &format!("{{\"offset\":{offset}}}")));
    assert_eq!(by_offset["sha1"], value["sha1"]);
}

#[test]
fn pack_entry_ofs_delta_chain() {
    let (pack, _, _) = sample_pack();
    let value = ok(&git_pack_entry(&pack, "{\"index\":1}"));
    assert_eq!(value["type"], "blob");
    assert_eq!(value["chainDepth"], 1);
    assert_eq!(value["size"], 12);
    assert_eq!(
        value["previewBase64"],
        base64_encode(b"hello WORLD!")
    );
}

#[test]
fn pack_entry_ref_delta() {
    let (pack, _, base2) = sample_pack();
    let value = ok(&git_pack_entry(&pack, "{\"index\":4}"));
    assert_eq!(value["type"], "blob");
    assert_eq!(value["chainDepth"], 1);
    assert_eq!(value["size"], 7);
    assert_eq!(value["previewBase64"], base64_encode(b"second!"));
    assert_eq!(value["sha1"], hex_encode(&object_id("blob", b"second!")));
    let _ = base2;
}

#[test]
fn pack_entry_delta_of_delta() {
    let base = b"0123456789".to_vec();
    // d1: copy all of base + insert "ab" → 12 bytes
    let d1 = delta(10, 12, &[copy_op(0, 10), insert_op(b"ab")].concat());
    // d2: copy first 12 of d1-result + insert "cd" → 14 bytes
    let d2 = delta(12, 14, &[copy_op(0, 12), insert_op(b"cd")].concat());
    let pack = pack(&[
        PackEntry::Full(3, base),
        PackEntry::OfsDelta(0, d1),
        PackEntry::OfsDelta(1, d2),
    ]);
    let value = ok(&git_pack_entry(&pack, "{\"index\":2}"));
    assert_eq!(value["chainDepth"], 2);
    assert_eq!(value["size"], 14);
    assert_eq!(
        value["previewBase64"],
        base64_encode(b"0123456789abcd")
    );
}

#[test]
fn pack_entry_raw() {
    // `git_pack_entry_raw` goes through wasm-bindgen's JsValue error path,
    // which is a non-wasm32 stub — test the inner extraction path directly.
    let (pack, base1, _) = sample_pack();
    let mut report = Report::new();
    let opts = |s: &str| serde_json::from_str::<crate::pack::EntryOptions>(s).unwrap();
    let raw = crate::pack::entry_raw(&pack, &opts("{\"index\":0}"), &mut report).unwrap();
    assert_eq!(raw, base1);
    let raw = crate::pack::entry_raw(&pack, &opts("{\"index\":1}"), &mut report).unwrap();
    assert_eq!(raw, b"hello WORLD!");
    let error = crate::pack::entry_raw(&pack, &opts("{\"index\":99}"), &mut report).unwrap_err();
    assert_eq!(error, "entry_not_found");
}

#[test]
fn pack_entry_selector_errors() {
    let (pack, _, _) = sample_pack();
    assert_eq!(err(&git_pack_entry(&pack, "{}")), "missing_selector");
    assert_eq!(
        err(&git_pack_entry(&pack, "{\"index\":0,\"offset\":12}")),
        "conflicting_selectors"
    );
    assert_eq!(err(&git_pack_entry(&pack, "{\"index\":99}")), "entry_not_found");
    assert_eq!(
        err(&git_pack_entry(&pack, "{\"offset\":12345}")),
        "entry_not_found"
    );
    assert_eq!(
        err(&git_pack_entry(b"notapack...............", "{\"index\":0}")),
        "not_pack"
    );
}

#[test]
fn pack_entry_depth_exceeded() {
    // 70-deep ofs-delta chain exceeds the 64 cap for extraction.
    let d = delta(4, 4, &copy_op(0, 4));
    let mut entries = vec![PackEntry::Full(3, b"base".to_vec())];
    for i in 0..70 {
        entries.push(PackEntry::OfsDelta(i, d.clone()));
    }
    let pack = pack(&entries);
    assert_eq!(
        err(&git_pack_entry(&pack, "{\"index\":70}")),
        "delta_depth_exceeded"
    );
    // but inspection still reports the true structural depth
    let value = ok(&git_pack_inspect(&pack, "{}"));
    assert_eq!(value["deltas"]["maxChainDepth"], 70);
}

#[test]
fn pack_entry_object_too_large() {
    // entry declares > 128 MiB — rejected before allocation.
    let mut body = pack_entry_header(3, (MAX_OBJECT_BYTES + 1) as u64);
    body.extend(zlib(b"x"));
    let mut raw = b"PACK".to_vec();
    raw.extend_from_slice(&2u32.to_be_bytes());
    raw.extend_from_slice(&1u32.to_be_bytes());
    raw.extend_from_slice(&body);
    let trailer = crate::sha1_bytes(&raw);
    raw.extend_from_slice(&trailer);
    assert_eq!(
        err(&git_pack_entry(&raw, "{\"index\":0}")),
        "object_too_large"
    );
}

#[test]
fn pack_entry_malformed_deltas() {
    // base size in delta header disagrees with actual base
    let bad1 = delta(99, 4, &copy_op(0, 4));
    let p1 = pack(&[PackEntry::Full(3, b"base".to_vec()), PackEntry::OfsDelta(0, bad1)]);
    assert_eq!(err(&git_pack_entry(&p1, "{\"index\":1}")), "delta_base_mismatch");

    // copy op reads past base end
    let bad2 = delta(4, 4, &copy_op(100, 4));
    let p2 = pack(&[PackEntry::Full(3, b"base".to_vec()), PackEntry::OfsDelta(0, bad2)]);
    assert_eq!(err(&git_pack_entry(&p2, "{\"index\":1}")), "malformed_delta");

    // ref-delta to a sha that is not in the pack
    let p3 = pack(&[
        PackEntry::Full(3, b"base".to_vec()),
        PackEntry::RefDelta([0x99; 20], delta(4, 4, &copy_op(0, 4))),
    ]);
    assert_eq!(err(&git_pack_entry(&p3, "{\"index\":1}")), "base_not_found");

    // ofs-delta pointing at a non-entry offset
    let mut raw = b"PACK".to_vec();
    raw.extend_from_slice(&2u32.to_be_bytes());
    raw.extend_from_slice(&1u32.to_be_bytes());
    let d = delta(4, 4, &copy_op(0, 4));
    raw.extend(pack_entry_header(6, d.len() as u64));
    raw.extend(offset_varint(3)); // base at offset 9 — inside the header
    raw.extend(zlib(&d));
    let trailer = crate::sha1_bytes(&raw);
    raw.extend_from_slice(&trailer);
    assert_eq!(err(&git_pack_entry(&raw, "{\"index\":0}")), "delta_base_missing");
}

// ----------------------------------------------------------- index inspect

#[test]
fn index_inspect_v2() {
    let value = ok(&git_index_inspect(&dirc(), "{}"));
    assert_eq!(value["kind"], "index");
    assert_eq!(value["version"], 2);
    assert_eq!(value["declaredEntries"], 4);
    assert_eq!(value["parsedEntries"], 4);
    assert_eq!(value["checksumValid"], true);
    let entries = value["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["path"], "src/main.rs");
    assert_eq!(entries[0]["mode"], "0o100644");
    assert_eq!(entries[0]["modeKind"], "file");
    assert_eq!(entries[0]["size"], 1234);
    assert_eq!(entries[0]["mtime"]["seconds"], 1700000100u32);
    assert_eq!(entries[0]["uid"], 501);
    assert_eq!(entries[1]["stage"], 1);
    assert_eq!(entries[2]["modeKind"], "symlink");
    assert_eq!(entries[3]["modeKind"], "gitlink");
    let extensions = value["extensions"].as_array().unwrap();
    assert_eq!(extensions.len(), 2);
    assert_eq!(extensions[0]["name"], "TREE");
    assert_eq!(extensions[0]["size"], 10);
    assert_eq!(extensions[1]["name"], "REUC");
}

#[test]
fn index_inspect_v3_extended_flags() {
    let mut e = dirc_entry("flagged.txt", [0x55; 20], 0o100644);
    e.ext_flags = 0x4000 | 0x2000;
    let index = dirc_v23(3, &[e], &[]);
    let value = ok(&git_index_inspect(&index, "{}"));
    assert_eq!(value["version"], 3);
    assert_eq!(value["parsedEntries"], 1);
    assert_eq!(value["entries"][0]["path"], "flagged.txt");
    assert_eq!(value["entries"][0]["flags"]["skipWorktree"], true);
    assert_eq!(value["entries"][0]["flags"]["intentToAdd"], true);
}

#[test]
fn index_inspect_v4_prefix_compression() {
    let entries = [
        dirc_entry("src/a.txt", [0x11; 20], 0o100644),
        dirc_entry("src/b.txt", [0x22; 20], 0o100644),
        dirc_entry("src/dir/c.txt", [0x33; 20], 0o100644),
        dirc_entry("top.txt", [0x44; 20], 0o100644),
    ];
    let value = ok(&git_index_inspect(&dirc_v4(&entries), "{}"));
    assert_eq!(value["version"], 4);
    assert_eq!(value["parsedEntries"], 4);
    let paths: Vec<&str> = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["src/a.txt", "src/b.txt", "src/dir/c.txt", "top.txt"]);
    assert_eq!(value["checksumValid"], true);
}

#[test]
fn index_inspect_malformed() {
    assert_eq!(err(&git_index_inspect(b"PACK........", "{}")), "not_index");
    let mut bad = b"DIRC".to_vec();
    bad.extend_from_slice(&5u32.to_be_bytes());
    bad.extend_from_slice(&0u32.to_be_bytes());
    bad.extend_from_slice(&[0u8; 20]);
    assert_eq!(err(&git_index_inspect(&bad, "{}")), "unsupported_index_version");
    // declared > actual
    let mut short = b"DIRC".to_vec();
    short.extend_from_slice(&2u32.to_be_bytes());
    short.extend_from_slice(&3u32.to_be_bytes());
    let trailer = crate::sha1_bytes(&short);
    short.extend_from_slice(&trailer);
    let value = ok(&git_index_inspect(&short, "{}"));
    assert_eq!(value["parsedEntries"], 0);
    // truncated mid-entry
    let mut cut = dirc();
    cut.truncate(12 + 40);
    let value = ok(&git_index_inspect(&cut, "{}"));
    assert_eq!(value["parsedEntries"].as_u64().unwrap(), 0);
    assert_eq!(value["checksumValid"], false);
    assert!(!value["warnings"].as_array().unwrap().is_empty());
}

#[test]
fn index_inspect_max_items() {
    let value = ok(&git_index_inspect(&dirc(), "{\"maxItems\":2}"));
    assert_eq!(value["entries"].as_array().unwrap().len(), 2);
    assert_eq!(value["parsedEntries"], 4);
    assert_eq!(value["truncated"], true);
}

// ------------------------------------------------------------------- misc

#[test]
fn options_limits() {
    let big_opts = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_OPTIONS_BYTES));
    let blob = loose("blob", BLOB);
    assert_eq!(err(&git_object_decode(&blob, &big_opts)), "options_too_large");
    assert_eq!(err(&git_object_decode(&blob, "{oops")), "invalid_options");
    let big = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(err(&git_object_decode(&big, "{}")), "input_too_large");
    assert_eq!(err(&git_pack_inspect(&big, "{}")), "input_too_large");
    assert_eq!(err(&git_index_inspect(&big, "{}")), "input_too_large");
    assert_eq!(err(&git_object_decode(b"", "{}")), "empty_input");
    // raw op inner path (the exported wrapper's limits/error rejection is
    // exercised against the real wasm in verify.mjs)
    let mut report = Report::new();
    let opts = serde_json::from_str::<crate::pack::EntryOptions>("{\"index\":0}").unwrap();
    assert_eq!(
        crate::pack::entry_raw(b"notapack...............", &opts, &mut report),
        Err("not_pack")
    );
}

#[test]
fn determinism() {
    let (pack, _, _) = sample_pack();
    let index = dirc();
    let blob = loose("commit", &commit_content());
    assert_eq!(git_identify(&pack), git_identify(&pack));
    assert_eq!(git_pack_inspect(&pack, "{}"), git_pack_inspect(&pack, "{}"));
    assert_eq!(git_pack_entry(&pack, "{\"index\":1}"), git_pack_entry(&pack, "{\"index\":1}"));
    assert_eq!(git_index_inspect(&index, "{}"), git_index_inspect(&index, "{}"));
    assert_eq!(git_object_decode(&blob, "{}"), git_object_decode(&blob, "{}"));
}
