//! Unit tests with fixtures built entirely in code (no external files).
//!
//! `DUMP_FIXTURES=1 cargo test` additionally writes the generated fixture
//! bytes into `test/fixtures/` for the Node-side verifier.

use std::io::{Cursor, Write};

use serde_json::{json, Value};

use super::*;

const EVIL_DLL: &[u8] = b"MZ\x90\x00fixture-dll-payload";
const README_TXT: &[u8] = b"Hello cabinet, this is a stored file.\n";
const LOADER_JS: &[u8] = b"var x = new ActiveXObject('WScript.Shell'); x.Run('calc');\n";

// ---------------------------------------------------------------------------
// MSI fixture
// ---------------------------------------------------------------------------

fn build_msi_fixture() -> Vec<u8> {
    let mut package =
        msi::Package::create(msi::PackageType::Installer, Cursor::new(Vec::new()))
            .expect("create package");
    package
        .summary_info_mut()
        .set_title("Fixture Installer Database");
    package.summary_info_mut().set_author("Turen Tests");
    package
        .summary_info_mut()
        .set_subject("installer-inspect fixture");
    package.summary_info_mut().set_arch("Intel");

    package
        .create_table(
            "Property",
            vec![
                msi::Column::build("Property").primary_key().id_string(64),
                msi::Column::build("Value").nullable().string(256),
            ],
        )
        .unwrap();
    package
        .insert_rows(
            msi::Insert::into("Property").rows(vec![
                vec![
                    msi::Value::from("ProductCode".to_string()),
                    msi::Value::from("{12345678-1234-1234-1234-1234567890AB}".to_string()),
                ],
                vec![
                    msi::Value::from("ProductName".to_string()),
                    msi::Value::from("Fixture App".to_string()),
                ],
                vec![
                    msi::Value::from("UpgradeCode".to_string()),
                    msi::Value::from("{ABCDEF00-0000-0000-0000-0000000000FF}".to_string()),
                ],
            ]),
        )
        .unwrap();

    package
        .create_table(
            "CustomAction",
            vec![
                msi::Column::build("Action").primary_key().id_string(72),
                msi::Column::build("Type").int16(),
                msi::Column::build("Source").nullable().id_string(72),
                msi::Column::build("Target").nullable().formatted_string(255),
                msi::Column::build("ExtendedType").nullable().int32(),
            ],
        )
        .unwrap();
    package
        .insert_rows(
            msi::Insert::into("CustomAction").rows(vec![
                vec![
                    msi::Value::from("RunEmbeddedDll".to_string()),
                    // type 1 = DLL from Binary table, +0x400 deferred
                    msi::Value::Int(1 | 0x400),
                    msi::Value::from("evil.dll".to_string()),
                    msi::Value::from("Install".to_string()),
                    msi::Value::Null,
                ],
                vec![
                    msi::Value::from("RunExe".to_string()),
                    // type 0x12 = EXE from installed source file
                    msi::Value::Int(0x12),
                    msi::Value::from("helper.exe".to_string()),
                    msi::Value::from("-quiet".to_string()),
                    msi::Value::Null,
                ],
                vec![
                    msi::Value::from("RunScript".to_string()),
                    // type 38 = inline VBScript, deferred + noImpersonate
                    msi::Value::Int(38 | 0x400 | 0x800),
                    msi::Value::Null,
                    msi::Value::from("CreateObject(\"WScript.Shell\").Run \"powershell -enc AAAA\"".to_string()),
                    msi::Value::Null,
                ],
            ]),
        )
        .unwrap();

    package
        .create_table(
            "InstallExecuteSequence",
            vec![
                msi::Column::build("Action").primary_key().id_string(72),
                msi::Column::build("Condition").nullable().formatted_string(255),
                msi::Column::build("Sequence").nullable().int16(),
            ],
        )
        .unwrap();
    package
        .insert_rows(
            msi::Insert::into("InstallExecuteSequence").rows(vec![
                vec![
                    msi::Value::from("RunScript".to_string()),
                    msi::Value::Null,
                    msi::Value::Int(6600),
                ],
                vec![
                    msi::Value::from("InstallFiles".to_string()),
                    msi::Value::Null,
                    msi::Value::Int(4000),
                ],
                vec![
                    msi::Value::from("RunEmbeddedDll".to_string()),
                    msi::Value::from("NOT Installed".to_string()),
                    msi::Value::Int(6200),
                ],
            ]),
        )
        .unwrap();

    package
        .create_table(
            "File",
            vec![
                msi::Column::build("File").primary_key().id_string(72),
                msi::Column::build("Component_").id_string(72),
                msi::Column::build("FileName").string(255),
                msi::Column::build("FileSize").int32(),
                msi::Column::build("Version").nullable().string(32),
                msi::Column::build("Language").nullable().string(8),
                msi::Column::build("Attributes").nullable().int16(),
                msi::Column::build("Sequence").int16(),
            ],
        )
        .unwrap();
    package
        .insert_rows(
            msi::Insert::into("File").rows(vec![vec![
                msi::Value::from("helper.exe".to_string()),
                msi::Value::from("HelperComp".to_string()),
                msi::Value::from("helper.exe".to_string()),
                msi::Value::Int(1024),
                msi::Value::Null,
                msi::Value::Null,
                msi::Value::Null,
                msi::Value::Int(1),
            ]]),
        )
        .unwrap();

    package
        .create_table(
            "ServiceInstall",
            vec![
                msi::Column::build("ServiceInstall").primary_key().id_string(72),
                msi::Column::build("Name").string(255),
                msi::Column::build("DisplayName").nullable().string(255),
                msi::Column::build("ServiceType").int32(),
                msi::Column::build("StartType").int32(),
                msi::Column::build("ErrorControl").int32(),
                msi::Column::build("LoadOrderGroup").nullable().string(255),
                msi::Column::build("Dependencies").nullable().string(255),
                msi::Column::build("StartName").nullable().string(255),
                msi::Column::build("Password").nullable().string(255),
                msi::Column::build("Arguments").nullable().string(255),
                msi::Column::build("Component_").id_string(72),
                msi::Column::build("Description").nullable().string(255),
            ],
        )
        .unwrap();
    package
        .insert_rows(
            msi::Insert::into("ServiceInstall").rows(vec![vec![
                msi::Value::from("EvilSvc".to_string()),
                msi::Value::from("EvilService".to_string()),
                msi::Value::Null,
                msi::Value::Int(0x10),
                msi::Value::Int(2),
                msi::Value::Int(1),
                msi::Value::Null,
                msi::Value::Null,
                msi::Value::from("LocalSystem".to_string()),
                msi::Value::Null,
                msi::Value::Null,
                msi::Value::from("HelperComp".to_string()),
                msi::Value::Null,
            ]]),
        )
        .unwrap();

    package
        .create_table(
            "Registry",
            vec![
                msi::Column::build("Registry").primary_key().id_string(72),
                msi::Column::build("Root").int16(),
                msi::Column::build("Key").formatted_string(255),
                msi::Column::build("Name").nullable().string(255),
                msi::Column::build("Value").nullable().formatted_string(255),
                msi::Column::build("Component_").id_string(72),
            ],
        )
        .unwrap();
    package
        .insert_rows(
            msi::Insert::into("Registry").rows(vec![vec![
                msi::Value::from("RunKey".to_string()),
                msi::Value::Int(2),
                msi::Value::from(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Run".to_string(),
                ),
                msi::Value::from("FixturePersist".to_string()),
                msi::Value::from("[INSTALLDIR]helper.exe".to_string()),
                msi::Value::from("HelperComp".to_string()),
            ]]),
        )
        .unwrap();

    // Embedded Binary-table-style payload stream.
    package
        .write_stream("evil.dll")
        .unwrap()
        .write_all(EVIL_DLL)
        .unwrap();
    package.flush().unwrap();
    package.into_inner().unwrap().into_inner()
}

// ---------------------------------------------------------------------------
// CAB fixture
// ---------------------------------------------------------------------------

/// Build a one-folder cabinet. `block` is the raw CFDATA payload for the
/// folder (already "compressed"); `uncompressed` is the folder stream that
/// file offsets index into.
fn build_cab(
    files: &[(&str, u32)], // (name, size in uncompressed stream)
    compression: u16,
    block: &[u8],
    uncompressed_len: usize,
    folder_offsets: &[u32],
) -> Vec<u8> {
    let header_len = 36usize;
    let folder_len = 8usize;
    let files_offset = header_len + folder_len;
    let file_entry_len: usize = files
        .iter()
        .map(|(name, _)| 16 + name.len() + 1)
        .sum();
    let data_start = files_offset + file_entry_len;
    let total = data_start + 8 + block.len();

    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"MSCF");
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved1
    out.extend_from_slice(&(total as u32).to_le_bytes()); // cbCabinet
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved2
    out.extend_from_slice(&(files_offset as u32).to_le_bytes()); // coffFiles
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved3
    out.push(3); // versionMinor
    out.push(1); // versionMajor
    out.extend_from_slice(&1u16.to_le_bytes()); // cFolders
    out.extend_from_slice(&(files.len() as u16).to_le_bytes()); // cFiles
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&0x4242u16.to_le_bytes()); // setID
    out.extend_from_slice(&0u16.to_le_bytes()); // iCabinet
    // CFFOLDER
    out.extend_from_slice(&(data_start as u32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // cCFData
    out.extend_from_slice(&compression.to_le_bytes()); // typeCompress
    // CFFILE entries
    for (index, (name, size)) in files.iter().enumerate() {
        out.extend_from_slice(&size.to_le_bytes()); // cbFile
        out.extend_from_slice(&folder_offsets[index].to_le_bytes()); // uoffFolderStart
        out.extend_from_slice(&0u16.to_le_bytes()); // iFolder
        out.extend_from_slice(&0x58cfu16.to_le_bytes()); // date 2024-06-15
        out.extend_from_slice(&0x7defu16.to_le_bytes()); // time ~15:58
        out.extend_from_slice(&0x20u16.to_le_bytes()); // attribs archive
        out.extend_from_slice(name.as_bytes());
        out.push(0);
    }
    // CFDATA
    out.extend_from_slice(&0u32.to_le_bytes()); // csum (not checked)
    out.extend_from_slice(&(block.len() as u16).to_le_bytes()); // cbData
    out.extend_from_slice(&(uncompressed_len as u16).to_le_bytes()); // cbUncomp
    out.extend_from_slice(block);
    out
}

fn build_cab_stored() -> Vec<u8> {
    let mut folder_stream = Vec::new();
    folder_stream.extend_from_slice(README_TXT);
    folder_stream.extend_from_slice(LOADER_JS);
    build_cab(
        &[
            ("readme.txt", README_TXT.len() as u32),
            ("loader.js", LOADER_JS.len() as u32),
        ],
        0,
        &folder_stream,
        folder_stream.len(),
        &[0, README_TXT.len() as u32],
    )
}

fn deflate_raw(data: &[u8]) -> Vec<u8> {
    let mut encoder =
        flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn build_cab_mszip() -> Vec<u8> {
    let mut folder_stream = Vec::new();
    folder_stream.extend_from_slice(README_TXT);
    folder_stream.extend_from_slice(LOADER_JS);
    let uncomp_len = folder_stream.len();
    let mut block = b"CK".to_vec();
    block.extend_from_slice(&deflate_raw(&folder_stream));
    build_cab(
        &[
            ("readme.txt", README_TXT.len() as u32),
            ("loader.js", LOADER_JS.len() as u32),
        ],
        1,
        &block,
        uncomp_len,
        &[0, README_TXT.len() as u32],
    )
}

fn build_cab_quantum() -> Vec<u8> {
    let folder_stream = README_TXT.to_vec();
    build_cab(
        &[("readme.txt", README_TXT.len() as u32)],
        2 | (4 << 4) | (10 << 8), // quantum, level 4, memory 10
        &folder_stream,           // not really quantum-encoded; never decoded
        folder_stream.len(),
        &[0],
    )
}

/// Cabinet whose single CFFILE references folder index 7 (only folder 0
/// exists) — the "folder past EOF / invalid index" malformed case.
fn build_cab_bad_folder() -> Vec<u8> {
    let mut cab = build_cab(
        &[("readme.txt", README_TXT.len() as u32)],
        0,
        README_TXT,
        README_TXT.len(),
        &[0],
    );
    // iFolder sits at files_offset + 8 (cbFile u32 + uoffFolderStart u32).
    let files_offset = 36 + 8;
    cab[files_offset + 8] = 7;
    cab[files_offset + 9] = 0;
    cab
}

/// A CFB file whose directory tree is patched into a cycle: the root entry's
/// left sibling points at itself, which makes the crate's walk reject it.
fn build_cfb_directory_cycle() -> Vec<u8> {
    let mut comp = cfb::CompoundFile::create_with_version(
        cfb::Version::V3,
        Cursor::new(Vec::new()),
    )
    .expect("create cfb");
    comp.create_stream("/a").unwrap().write_all(b"xx").unwrap();
    comp.flush().unwrap();
    let mut bytes = comp.into_inner().into_inner();

    // Locate the first directory sector via the header (offset 0x30, u32).
    // V3 sectors are 512 bytes; sector N starts at file offset 512 + N*512.
    let first_dir_sector =
        u32::from_le_bytes(bytes[0x30..0x34].try_into().unwrap()) as usize;
    assert_ne!(first_dir_sector, 0xfffffffe);
    let dir_offset = 512 + first_dir_sector * 512;
    let entry1 = dir_offset + 128;
    assert!(entry1 + 128 <= bytes.len(), "fixture too small");
    // Entry 1 ("a") right-sibling (dir entry offset 72) -> 0 (root). The
    // name-ordering check passes ("a" < "Root Entry"), then the crate's
    // open-time visited set reports "loop in tree".
    bytes[entry1 + 72..entry1 + 76].copy_from_slice(&0u32.to_le_bytes());
    bytes
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn err_code<T>(result: &Result<T, String>) -> String {
    match result {
        Ok(_) => panic!("expected error, got Ok"),
        Err(message) => {
            let parsed: Value = serde_json::from_str(message).expect("error is JSON");
            assert_eq!(parsed["schema_version"], 1);
            parsed["error"].as_str().unwrap().to_string()
        }
    }
}

fn parse(json_text: &str) -> Value {
    serde_json::from_str(json_text).unwrap()
}

// ---------------------------------------------------------------------------
// MSI tests
// ---------------------------------------------------------------------------

#[test]
fn msi_inspect_decodes_package() {
    let fixture = build_msi_fixture();
    let report = parse(&msi_inspect::inspect_impl(&fixture, "{}").unwrap());

    assert_eq!(report["format"], "msi");
    assert_eq!(report["isMsi"], true);
    assert_eq!(report["package"]["type"], "installer");
    assert_eq!(report["package"]["summaryInfo"]["author"], "Turen Tests");
    assert_eq!(
        report["properties"]["ProductCode"],
        "{12345678-1234-1234-1234-1234567890AB}"
    );
    assert_eq!(
        report["properties"]["UpgradeCode"],
        "{ABCDEF00-0000-0000-0000-0000000000FF}"
    );

    // CFB listing present.
    assert!(report["cfb"]["entryCount"].as_u64().unwrap() >= 3);
    assert_eq!(
        report["cfb"]["rootClsid"],
        "000C1084-0000-0000-C000-000000000046"
    );

    // Table decode.
    let tables = report["tables"].as_array().unwrap();
    let names: Vec<&str> = tables.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for expected in [
        "Property",
        "CustomAction",
        "InstallExecuteSequence",
        "File",
        "ServiceInstall",
        "Registry",
    ] {
        assert!(names.contains(&expected), "missing table {expected}");
    }
    let prop_table = tables
        .iter()
        .find(|t| t["name"] == "Property")
        .unwrap();
    assert_eq!(prop_table["rowCount"], 3);
    assert_eq!(prop_table["rows"].as_array().unwrap().len(), 3);

    // Embedded stream metadata with hash.
    let streams = report["streams"].as_array().unwrap();
    let evil = streams.iter().find(|s| s["name"] == "evil.dll").unwrap();
    assert_eq!(evil["size"], EVIL_DLL.len() as u64);
    assert_eq!(
        evil["sha256"],
        "cd68986b059e3257d53249aa7e0069fb8381152089636a919e002f28efca6c5b"
    );

    // CustomAction decode.
    let cas = report["customActions"].as_array().unwrap();
    assert_eq!(cas.len(), 3);
    let dll = cas
        .iter()
        .find(|c| c["action"] == "RunEmbeddedDll")
        .unwrap();
    assert_eq!(dll["decoded"]["kind"], "dll");
    assert_eq!(dll["decoded"]["location"], "binary");
    assert!(dll["decoded"]["flags"]
        .as_array()
        .unwrap()
        .contains(&json!("inScript")));
    let script = cas.iter().find(|c| c["action"] == "RunScript").unwrap();
    assert_eq!(script["decoded"]["kind"], "vbscript");
    assert_eq!(script["decoded"]["location"], "inlineText");
    let flags = script["decoded"]["flags"].as_array().unwrap();
    assert!(flags.contains(&json!("inScript")));
    assert!(flags.contains(&json!("noImpersonate")));

    // Sequence ordering sorted ascending.
    let seq = report["sequences"]["InstallExecuteSequence"]
        .as_array()
        .unwrap();
    let order: Vec<i64> = seq.iter().map(|s| s["sequence"].as_i64().unwrap()).collect();
    assert_eq!(order, vec![4000, 6200, 6600]);

    // Findings: payload custom actions, suspicious target, service, run key.
    let kinds: Vec<&str> = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"customActionPayload"));
    assert!(kinds.contains(&"suspiciousCustomActionTarget"));
    assert!(kinds.contains(&"serviceInstall"));
    assert!(kinds.contains(&"registryPersistenceKey"));
}

#[test]
fn msi_stream_read_returns_bytes() {
    let fixture = build_msi_fixture();
    let report = parse(
        &msi_inspect::stream_read_impl(&fixture, r#"{"stream":"evil.dll"}"#).unwrap(),
    );
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["stream"], "evil.dll");
    assert_eq!(report["size"], EVIL_DLL.len() as u64);
    assert_eq!(report["declaredSize"], EVIL_DLL.len() as u64);
    assert_eq!(report["truncated"], false);
    assert_eq!(
        data_encoding::BASE64
            .decode(report["contentBase64"].as_str().unwrap().as_bytes())
            .unwrap(),
        EVIL_DLL
    );
    assert_eq!(
        report["sha256"],
        "cd68986b059e3257d53249aa7e0069fb8381152089636a919e002f28efca6c5b"
    );
}

#[test]
fn msi_stream_read_preview() {
    let fixture = build_msi_fixture();
    let report = parse(
        &msi_inspect::stream_read_impl(
            &fixture,
            r#"{"stream":"evil.dll","maxBytes":4}"#,
        )
        .unwrap(),
    );
    assert_eq!(report["size"], 4);
    assert_eq!(report["declaredSize"], EVIL_DLL.len() as u64);
    assert_eq!(report["truncated"], true);
    assert_eq!(
        data_encoding::BASE64
            .decode(report["contentBase64"].as_str().unwrap().as_bytes())
            .unwrap(),
        EVIL_DLL[..4]
    );
}

#[test]
fn msi_stream_read_raw_cfb_path() {
    let fixture = build_msi_fixture();
    let report = parse(
        &msi_inspect::stream_read_impl(&fixture, r#"{"stream":"\u0005SummaryInformation"}"#)
            .unwrap(),
    );
    assert!(report["size"].as_u64().unwrap() > 16);
}

#[test]
fn msi_stream_read_missing() {
    let fixture = build_msi_fixture();
    let result = msi_inspect::stream_read_impl(&fixture, r#"{"stream":"nope.bin"}"#);
    assert_eq!(err_code(&result), "stream_not_found");
}

#[test]
fn msi_stream_read_requires_stream_option() {
    let fixture = build_msi_fixture();
    let result = msi_inspect::stream_read_impl(&fixture, "{}");
    assert_eq!(err_code(&result), "invalid_options");
}

#[test]
fn msi_inspect_not_cfb() {
    let result = msi_inspect::inspect_impl(b"this is not a compound file", "{}");
    assert_eq!(err_code(&result), "not_cfb");
}

#[test]
fn msi_inspect_truncated_cfb() {
    let fixture = build_msi_fixture();
    // Keep only the 512-byte header plus a fragment of sector 0.
    let truncated = &fixture[..700];
    let result = msi_inspect::inspect_impl(truncated, "{}");
    assert_eq!(err_code(&result), "invalid_cfb");
}

#[test]
fn msi_inspect_directory_cycle() {
    let fixture = build_cfb_directory_cycle();
    let result = msi_inspect::inspect_impl(&fixture, "{}");
    assert_eq!(err_code(&result), "invalid_cfb");
}

#[test]
fn msi_inspect_non_msi_cfb_reports_container() {
    let mut comp =
        cfb::CompoundFile::create(Cursor::new(Vec::new())).expect("create cfb");
    comp.create_stream("/payload.bin")
        .unwrap()
        .write_all(b"payload")
        .unwrap();
    comp.flush().unwrap();
    let fixture = comp.into_inner().into_inner();
    let report = parse(&msi_inspect::inspect_impl(&fixture, "{}").unwrap());
    assert_eq!(report["format"], "cfb");
    assert_eq!(report["isMsi"], false);
    assert!(report["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("not an MSI database")));
}

// ---------------------------------------------------------------------------
// CAB tests
// ---------------------------------------------------------------------------

#[test]
fn cab_list_reports_files() {
    let fixture = build_cab_stored();
    let report = parse(&cab::list_impl(&fixture, "{}").unwrap());
    assert_eq!(report["format"], "cabinet");
    assert_eq!(report["version"], "1.3");
    assert_eq!(report["folderCount"], 1);
    assert_eq!(report["fileCount"], 2);
    assert_eq!(report["setId"], 0x4242);
    let files = report["files"].as_array().unwrap();
    let readme = files.iter().find(|f| f["name"] == "readme.txt").unwrap();
    assert_eq!(readme["size"], README_TXT.len() as u64);
    assert_eq!(readme["compression"], "none");
    assert_eq!(readme["folderOffset"], 0);
    let loader = files.iter().find(|f| f["name"] == "loader.js").unwrap();
    assert_eq!(loader["folderOffset"], README_TXT.len() as u64);
    assert_eq!(
        report["folders"][0]["compression"]["scheme"],
        "none"
    );
    assert_eq!(report["folders"][0]["compressionSupported"], true);
}

fn extract_json(cab: &[u8], name: &str) -> Value {
    parse(&cab::extract_impl(cab, &format!(r#"{{"file":"{name}"}}"#)).unwrap())
}

fn decoded(report: &Value) -> Vec<u8> {
    data_encoding::BASE64
        .decode(report["contentBase64"].as_str().unwrap().as_bytes())
        .unwrap()
}

#[test]
fn cab_extract_stored() {
    let fixture = build_cab_stored();
    let report = extract_json(&fixture, "readme.txt");
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["compression"], "none");
    assert_eq!(report["size"], README_TXT.len() as u64);
    assert_eq!(report["truncated"], false);
    assert_eq!(decoded(&report), README_TXT);
    assert_eq!(decoded(&extract_json(&fixture, "loader.js")), LOADER_JS);
}

#[test]
fn cab_extract_mszip() {
    let fixture = build_cab_mszip();
    let report = parse(&cab::list_impl(&fixture, "{}").unwrap());
    assert_eq!(
        report["folders"][0]["compression"]["scheme"],
        "mszip"
    );
    let report = extract_json(&fixture, "readme.txt");
    assert_eq!(report["compression"], "mszip");
    assert_eq!(decoded(&report), README_TXT);
    assert_eq!(decoded(&extract_json(&fixture, "loader.js")), LOADER_JS);
}

#[test]
fn cab_extract_quantum_unsupported() {
    let fixture = build_cab_quantum();
    let report = parse(&cab::list_impl(&fixture, "{}").unwrap());
    assert_eq!(
        report["folders"][0]["compression"]["scheme"],
        "quantum"
    );
    assert_eq!(report["folders"][0]["compressionSupported"], false);
    let result = cab::extract_impl(&fixture, r#"{"file":"readme.txt"}"#);
    assert_eq!(err_code(&result), "unsupported_compression");
}

#[test]
fn cab_extract_bad_folder_index() {
    let fixture = build_cab_bad_folder();
    let result = cab::extract_impl(&fixture, r#"{"file":"readme.txt"}"#);
    assert_eq!(err_code(&result), "invalid_cabinet");
}

#[test]
fn cab_extract_file_not_found() {
    let fixture = build_cab_stored();
    let result = cab::extract_impl(&fixture, r#"{"file":"missing.txt"}"#);
    assert_eq!(err_code(&result), "file_not_found");
}

#[test]
fn cab_list_bad_magic() {
    let mut fixture = build_cab_stored();
    fixture[..4].copy_from_slice(b"NOPE");
    let result = cab::list_impl(&fixture, "{}");
    assert_eq!(err_code(&result), "not_cabinet");
}

#[test]
fn cab_list_truncated_inside_files() {
    let fixture = build_cab_stored();
    let files_offset = 36 + 8;
    let truncated = &fixture[..files_offset + 5];
    let result = cab::list_impl(truncated, "{}");
    assert_eq!(err_code(&result), "truncated_cabinet");
}

#[test]
fn cab_list_truncated_header() {
    let fixture = build_cab_stored();
    let result = cab::list_impl(&fixture[..20], "{}");
    assert_eq!(err_code(&result), "truncated_cabinet");
}

#[test]
fn cab_extract_respects_max_output() {
    let fixture = build_cab_stored();
    let report = parse(
        &cab::extract_impl(&fixture, r#"{"file":"readme.txt","maxBytes":4}"#)
            .unwrap(),
    );
    assert_eq!(report["size"], 4);
    assert_eq!(report["declaredSize"], README_TXT.len() as u64);
    assert_eq!(report["truncated"], true);
    assert_eq!(decoded(&report), README_TXT[..4]);
}

// ---------------------------------------------------------------------------
// shared bound / envelope tests
// ---------------------------------------------------------------------------

#[test]
fn input_too_large_rejected() {
    let big = vec![0u8; MAX_INPUT_BYTES + 1];
    assert_eq!(err_code(&msi_inspect::inspect_impl(&big, "{}")), "input_too_large");
    assert_eq!(err_code(&cab::list_impl(&big, "{}")), "input_too_large");
    assert_eq!(
        err_code(&msi_inspect::stream_read_impl(&big, "{}")),
        "input_too_large"
    );
    assert_eq!(
        err_code(&cab::extract_impl(&big, "{}")),
        "input_too_large"
    );
}

#[test]
fn options_too_large_rejected() {
    let big_options = format!("{{\"padding\":\"{}\"}}", "x".repeat(MAX_OPTIONS_BYTES));
    let fixture = build_cab_stored();
    assert_eq!(
        err_code(&cab::list_impl(&fixture, &big_options)),
        "options_too_large"
    );
    let msi = build_msi_fixture();
    assert_eq!(
        err_code(&msi_inspect::inspect_impl(&msi, &big_options)),
        "options_too_large"
    );
}

#[test]
fn invalid_options_rejected() {
    let fixture = build_cab_stored();
    assert_eq!(
        err_code(&cab::list_impl(&fixture, "not json")),
        "invalid_options"
    );
    assert_eq!(
        err_code(&cab::list_impl(&fixture, "[1,2]")),
        "invalid_options"
    );
    assert_eq!(
        err_code(&cab::list_impl(&fixture, r#"{"maxFiles":"nope"}"#)),
        "invalid_options"
    );
}

#[test]
fn determinism() {
    let fixture = build_msi_fixture();
    let first = msi_inspect::inspect_impl(&fixture, "{}").unwrap();
    let second = msi_inspect::inspect_impl(&fixture, "{}").unwrap();
    assert_eq!(first, second);

    let cab = build_cab_mszip();
    let a = cab::list_impl(&cab, "{}").unwrap();
    let b = cab::list_impl(&cab, "{}").unwrap();
    assert_eq!(a, b);
    let e1 = cab::extract_impl(&cab, r#"{"file":"readme.txt"}"#).unwrap();
    let e2 = cab::extract_impl(&cab, r#"{"file":"readme.txt"}"#).unwrap();
    assert_eq!(e1, e2);
    let s1 =
        msi_inspect::stream_read_impl(&fixture, r#"{"stream":"evil.dll"}"#).unwrap();
    let s2 =
        msi_inspect::stream_read_impl(&fixture, r#"{"stream":"evil.dll"}"#).unwrap();
    assert_eq!(s1, s2);
}

// ---------------------------------------------------------------------------
// fixture dumping for the Node verifier
// ---------------------------------------------------------------------------

#[test]
fn dump_fixtures() {
    if std::env::var("DUMP_FIXTURES").ok().as_deref() != Some("1") {
        return;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("test")
        .join("fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    let fixtures: Vec<(&str, Vec<u8>)> = vec![
        ("minimal.msi", build_msi_fixture()),
        ("stored.cab", build_cab_stored()),
        ("mszip.cab", build_cab_mszip()),
        ("quantum.cab", build_cab_quantum()),
        ("bad-folder.cab", build_cab_bad_folder()),
        ("dir-cycle.cfb", build_cfb_directory_cycle()),
    ];
    for (name, bytes) in fixtures {
        std::fs::write(dir.join(name), bytes).unwrap();
    }
    eprintln!("fixtures written to {}", dir.display());
}
