//! Unit tests. The SquashFS fixture is built in-memory with backhand's
//! `FilesystemWriter` so tests never depend on external binaries or committed
//! images. `DUMP_FIXTURES=1 cargo test` additionally writes the image to
//! `test/fixtures/` for the real-WASM `test/verify.mjs` harness; generated
//! fixtures are gitignored.

use std::io::Cursor;

use backhand::compression::Compressor;
use backhand::kind::{self, Kind};
use backhand::{FilesystemCompressor, FilesystemWriter, NodeHeader};
use serde_json::Value;

use super::{extract_impl, list_impl};

const PASSWD: &[u8] =
    b"root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/sbin/nologin\nnobody:x:99:99:nobody:/:/sbin/nologin\n";
const HOSTS: &[u8] = b"127.0.0.1 localhost\n::1 ip6-localhost\n";
const RCS: &[u8] = b"#!/bin/sh\nmount -t proc proc /proc\nexec /sbin/init\n";
const MOTD: &[u8] = b"firmware 1.0\n";

/// Deterministic image: fixed timestamps, ~10 files across nested dirs, a
/// symlink, a fifo, char/block devices, a socket, and one multi-block file.
pub(crate) fn fixture_image() -> Vec<u8> {
    let mut writer = FilesystemWriter::default();
    writer.set_kind(Kind::from_const(kind::LE_V4_0).unwrap());
    writer.set_compressor(FilesystemCompressor::new(Compressor::Gzip, None).unwrap());
    writer.set_time(1_704_067_200);
    writer.set_no_padding();
    writer.set_root_mode(0o755);

    let header = |mode: u16, uid: u32, gid: u32, mtime: u32| NodeHeader::new(mode, uid, gid, mtime);
    let file = |writer: &mut FilesystemWriter, contents: Vec<u8>, path: &str, h: NodeHeader| {
        writer.push_file(Cursor::new(contents), path, h).unwrap();
    };

    writer
        .push_dir("etc", header(0o755, 0, 0, 1_704_067_201))
        .unwrap();
    writer
        .push_dir("etc/init.d", header(0o755, 0, 0, 1_704_067_202))
        .unwrap();
    writer
        .push_dir("bin", header(0o755, 0, 0, 1_704_067_203))
        .unwrap();
    writer
        .push_dir("data", header(0o750, 0, 1, 1_704_067_204))
        .unwrap();
    writer
        .push_dir("dev", header(0o755, 0, 0, 1_704_067_205))
        .unwrap();

    file(
        &mut writer,
        PASSWD.to_vec(),
        "etc/passwd",
        header(0o644, 0, 0, 1_704_067_210),
    );
    file(
        &mut writer,
        HOSTS.to_vec(),
        "etc/hosts",
        header(0o644, 0, 0, 1_704_067_211),
    );
    file(
        &mut writer,
        RCS.to_vec(),
        "etc/init.d/rcS",
        header(0o755, 0, 0, 1_704_067_212),
    );
    file(
        &mut writer,
        MOTD.to_vec(),
        "etc/motd",
        header(0o640, 0, 1, 1_704_067_213),
    );

    // One file large enough to span multiple 128 KiB data blocks, with a
    // mostly incompressible deterministic pattern.
    let big: Vec<u8> = (0..200_000u32)
        .map(|i| ((i * 31 + 7) % 251) as u8)
        .collect();
    file(
        &mut writer,
        big.clone(),
        "bin/big.bin",
        header(0o644, 1, 1, 1_704_067_220),
    );

    for index in 0..8u32 {
        let contents: Vec<u8> = (0..(index + 1) * 977)
            .map(|i| b'a' + ((i + index) % 23) as u8)
            .collect();
        file(
            &mut writer,
            contents,
            &format!("data/f{index:02}.txt"),
            header(0o644, index % 3, 0, 1_704_067_230 + index),
        );
    }

    writer
        .push_symlink(
            "/etc/passwd",
            "passwd-link",
            header(0o777, 0, 0, 1_704_067_240),
        )
        .unwrap();
    writer
        .push_fifo("dev/fifo0", header(0o644, 0, 0, 1_704_067_241))
        .unwrap();
    writer
        .push_char_device(0x0103, "dev/null", header(0o666, 0, 0, 1_704_067_242))
        .unwrap();
    writer
        .push_block_device(0x0700, "dev/loop0", header(0o660, 0, 6, 1_704_067_243))
        .unwrap();
    writer
        .push_socket("dev/log.sock", header(0o666, 0, 0, 1_704_067_244))
        .unwrap();

    let mut out = Cursor::new(Vec::new());
    writer.write(&mut out).unwrap();
    out.into_inner()
}

fn list(bytes: &[u8], options: &str) -> Value {
    serde_json::from_str(&list_impl(bytes, options).unwrap()).unwrap()
}

fn list_err(bytes: &[u8], options: &str) -> Value {
    serde_json::from_str(&list_impl(bytes, options).unwrap_err()).unwrap()
}

fn extract(bytes: &[u8], options: &str) -> Value {
    serde_json::from_str(&extract_impl(bytes, options).unwrap()).unwrap()
}

fn extract_err(bytes: &[u8], options: &str) -> Value {
    serde_json::from_str(&extract_impl(bytes, options).unwrap_err()).unwrap()
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

fn entry<'a>(report: &'a Value, path: &str) -> &'a Value {
    report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == path)
        .unwrap_or_else(|| panic!("entry {path} missing from listing"))
}

#[test]
fn lists_all_entries_with_metadata() {
    let image = fixture_image();
    let report = list(&image, "{}");
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["kind"], "le_v4_0");
    assert_eq!(report["magic"], "hsqs");
    assert_eq!(report["versionMajor"], 4);
    assert_eq!(report["versionMinor"], 0);
    assert_eq!(report["compression"], "gzip");
    assert_eq!(report["compressionSupported"], true);
    assert!(report["blockSize"].as_u64().unwrap() >= 4096);
    assert_eq!(report["modTime"], 1_704_067_200);
    assert!(report["inodeCount"].as_u64().unwrap() > 10);
    assert_eq!(report["truncated"], false);

    let paths: Vec<&str> = report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    // root + 5 dirs + 13 files + symlink + fifo + chardev + blockdev + socket.
    assert_eq!(paths.len(), 24);
    assert_eq!(paths[0], "/");
    for wanted in [
        "/",
        "/etc",
        "/etc/passwd",
        "/etc/hosts",
        "/etc/init.d",
        "/etc/init.d/rcS",
        "/etc/motd",
        "/bin",
        "/bin/big.bin",
        "/data",
        "/data/f00.txt",
        "/data/f07.txt",
        "/dev",
        "/dev/null",
        "/dev/loop0",
        "/dev/fifo0",
        "/dev/log.sock",
        "/passwd-link",
    ] {
        assert!(paths.contains(&wanted), "missing {wanted}");
    }

    let passwd = entry(&report, "/etc/passwd");
    assert_eq!(passwd["type"], "file");
    assert_eq!(passwd["size"], PASSWD.len());
    assert_eq!(passwd["mode"], "0644");
    assert_eq!(passwd["uid"], 0);
    assert_eq!(passwd["mtime"], 1_704_067_210);

    assert_eq!(entry(&report, "/etc")["type"], "dir");
    let link = entry(&report, "/passwd-link");
    assert_eq!(link["type"], "symlink");
    assert_eq!(link["linkTarget"], "/etc/passwd");
    assert_eq!(entry(&report, "/dev/fifo0")["type"], "fifo");
    assert_eq!(entry(&report, "/dev/log.sock")["type"], "socket");
    assert_eq!(entry(&report, "/dev/null")["type"], "chardev");
    assert_eq!(entry(&report, "/dev/null")["deviceNumber"], 0x0103);
    assert_eq!(entry(&report, "/dev/loop0")["type"], "blockdev");
    // Varied metadata survives: /data/f01.txt was written with uid 1.
    assert_eq!(entry(&report, "/data/f01.txt")["uid"], 1);
}

#[test]
fn path_filter_selects_prefix() {
    let image = fixture_image();
    let report = list(&image, r#"{"pathFilter":"/etc"}"#);
    let paths: Vec<&str> = report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert!(paths.iter().all(|path| path.starts_with("/etc")));
    assert!(paths.contains(&"/etc/passwd"));
    assert!(paths.contains(&"/etc/init.d/rcS"));
    assert!(!paths.contains(&"/passwd-link"));
    assert_eq!(report["entryCount"].as_u64().unwrap() as usize, paths.len());
}

#[test]
fn max_results_caps_and_marks_truncated() {
    let image = fixture_image();
    let report = list(&image, r#"{"maxResults":3}"#);
    assert_eq!(report["entries"].as_array().unwrap().len(), 3);
    assert_eq!(report["truncated"], true);
    assert_eq!(report["entryCount"], 24);
    // Entries are sorted by path, so the cap is deterministic.
    let first: Vec<&str> = report["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(first, ["/", "/bin", "/bin/big.bin"]);
}

#[test]
fn extracts_file_by_exact_path() {
    let image = fixture_image();
    let report = extract(&image, r#"{"path":"/etc/passwd"}"#);
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["path"], "/etc/passwd");
    assert_eq!(report["type"], "file");
    assert_eq!(report["size"], PASSWD.len());
    assert_eq!(report["sha256"], sha256_hex(PASSWD));
    assert_eq!(report["truncated"], false);
    let decoded = data_encoding::BASE64
        .decode(report["contentBase64"].as_str().unwrap().as_bytes())
        .unwrap();
    assert_eq!(decoded, PASSWD);

    // Multi-block file round-trips intact.
    let big: Vec<u8> = (0..200_000u32)
        .map(|i| ((i * 31 + 7) % 251) as u8)
        .collect();
    let report = extract(&image, r#"{"path":"/bin/big.bin"}"#);
    assert_eq!(report["size"], big.len());
    assert_eq!(report["sha256"], sha256_hex(&big));
    assert_eq!(report["declaredSize"], 200_000);
}

#[test]
fn extract_preview_is_bounded() {
    let image = fixture_image();
    let report = extract(&image, r#"{"path":"/etc/passwd","maxBytes":10}"#);
    assert_eq!(report["size"], 10);
    assert_eq!(report["truncated"], true);
    assert_eq!(report["declaredSize"], PASSWD.len());
    let decoded = data_encoding::BASE64
        .decode(report["contentBase64"].as_str().unwrap().as_bytes())
        .unwrap();
    assert_eq!(decoded, &PASSWD[..10]);
}

#[test]
fn extract_rejects_nonfile_entries() {
    let image = fixture_image();
    for (path, kind) in [
        ("/etc", "dir"),
        ("/passwd-link", "symlink"),
        ("/dev/fifo0", "fifo"),
        ("/dev/log.sock", "socket"),
        ("/dev/null", "chardev"),
        ("/dev/loop0", "blockdev"),
        ("/", "dir"),
    ] {
        let error = extract_err(&image, &format!(r#"{{"path":"{path}"}}"#));
        assert_eq!(error["error"], "entry_not_file", "for {path}");
        assert_eq!(error["entryType"], kind, "for {path}");
    }
}

#[test]
fn extract_missing_and_traversal() {
    let image = fixture_image();
    let error = extract_err(&image, r#"{"path":"/etc/shadow"}"#);
    assert_eq!(error["error"], "not_found");

    for path in ["../etc/passwd", "/etc/../passwd", "/data/../../etc/passwd"] {
        let error = extract_err(&image, &format!(r#"{{"path":"{path}"}}"#));
        assert_eq!(error["error"], "invalid_path", "for {path}");
    }
    // Normalization: leading `./`, double slashes, and trailing slash collapse.
    let report = extract(&image, r#"{"path":"./etc//passwd/"}"#);
    assert_eq!(report["path"], "/etc/passwd");
    assert_eq!(report["size"], PASSWD.len());
}

#[test]
fn leading_padding_offset() {
    let mut padded = vec![0x55u8; 8192];
    padded.extend_from_slice(&fixture_image());
    let error = list_err(&padded, "{}");
    assert_eq!(error["error"], "not_squashfs");

    let report = list(&padded, r#"{"offset":8192}"#);
    assert_eq!(report["kind"], "le_v4_0");
    assert_eq!(report["offset"], 8192);
    let extracted = extract(&padded, r#"{"offset":8192,"path":"/etc/passwd"}"#);
    assert_eq!(extracted["sha256"], sha256_hex(PASSWD));

    let error = list_err(&padded, r#"{"offset":99999999}"#);
    assert_eq!(error["error"], "invalid_options");
}

#[test]
fn malformed_and_truncated_inputs() {
    let image = fixture_image();

    let error = list_err(b"not a filesystem at all", "{}");
    assert_eq!(error["error"], "not_squashfs");

    let error = list_err(&image[..2], "{}");
    assert_eq!(error["error"], "not_squashfs");

    // Valid magic but truncated inside the superblock/inode metadata.
    let error = list_err(&image[..64], "{}");
    assert!(matches!(
        error["error"].as_str().unwrap(),
        "truncated_image" | "invalid_image"
    ));

    let tail_cut = &image[..image.len() - 32];
    let error = list_err(tail_cut, "{}");
    assert!(matches!(
        error["error"].as_str().unwrap(),
        "truncated_image" | "invalid_image"
    ));

    // Corrupt superblock version -> explicit unsupported_version.
    let mut wrong_version = image.clone();
    wrong_version[28] = 9;
    let error = list_err(&wrong_version, "{}");
    assert_eq!(error["error"], "unsupported_version");
    assert_eq!(error["versionMajor"], 9);
}

#[test]
fn unsupported_compression_is_named() {
    let image = fixture_image();
    for (id, name) in [
        (2u8, "lzma"),
        (3, "lzo"),
        (4, "xz"),
        (6, "zstd"),
        (9, "unknown"),
    ] {
        let mut patched = image.clone();
        patched[20] = id; // little-endian u16 compressor field in v4 superblock
        patched[21] = 0;
        let error = list_err(&patched, "{}");
        assert_eq!(error["error"], "unsupported_compression", "for id {id}");
        assert_eq!(error["compressor"], name, "for id {id}");
    }
}

#[test]
fn v3_magic_path_reports_invalid_image() {
    // No v3 writer exists in backhand; retagging a v4 image's version field
    // exercises the le_v3_0 candidate path deterministically.
    let mut v3ish = fixture_image();
    v3ish[28] = 3;
    let error = list_err(&v3ish, "{}");
    assert_eq!(error["error"], "invalid_image");
    assert_eq!(
        error["hint"],
        "squashfs v3 supports only gzip here; lzma-compressed v3 images are not built"
    );
}

#[test]
fn input_and_option_bounds() {
    let image = fixture_image();

    let error = list_err(&vec![0u8; crate::MAX_INPUT_BYTES + 1], "{}");
    assert_eq!(error["error"], "input_too_large");

    let huge_options = format!(r#"{{"padding":"{}"}}"#, "x".repeat(4096));
    let error = list_err(&image, &huge_options);
    assert_eq!(error["error"], "options_too_large");

    let error = list_err(&image, "not json");
    assert_eq!(error["error"], "invalid_options");
    let error = list_err(&image, "[1,2]");
    assert_eq!(error["error"], "invalid_options");
    let error = list_err(&image, r#"{"offset":"five"}"#);
    assert_eq!(error["error"], "invalid_options");
    let error = extract_err(&image, r#"{"path":7}"#);
    assert_eq!(error["error"], "invalid_options");
    let error = extract_err(&image, "{}");
    assert_eq!(error["error"], "invalid_options");
}

#[test]
fn deterministic_repeated_operations() {
    let image = fixture_image();
    let first = list_impl(&image, "{}").unwrap();
    let second = list_impl(&image, "{}").unwrap();
    assert_eq!(first, second);
    let first = extract_impl(&image, r#"{"path":"/bin/big.bin"}"#).unwrap();
    let second = extract_impl(&image, r#"{"path":"/bin/big.bin"}"#).unwrap();
    assert_eq!(first, second);
}

/// `DUMP_FIXTURES=1 cargo test` writes the generated images to
/// `test/fixtures/` for `test/verify.mjs`; the files are gitignored.
#[test]
fn dump_fixtures() {
    if std::env::var_os("DUMP_FIXTURES").is_none() {
        return;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test/fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("fixture-gzip.sqfs"), fixture_image()).unwrap();

    let mut padded = vec![0xAAu8; 4096];
    padded.extend_from_slice(&fixture_image());
    padded.extend_from_slice(&[0xBB; 512]);
    std::fs::write(dir.join("fixture-padded.sqfs"), padded).unwrap();
}
