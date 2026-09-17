//! Windows Installer (MSI) package inspection on top of `cfb` (compound
//! file) and `msi` (database tables). Everything is byte-only and read-only;
//! no stream is ever written to a filesystem or executed.

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    check_input, clean, error_json, finish_json, option_string, option_u64, parse_options,
    MAX_CONTENT_BYTES, MAX_LIST_ITEMS, MAX_STREAM_READ_BYTES, MAX_TABLE_ROWS,
};

/// CFB v3/v4 signature.
const CFB_MAGIC: &[u8; 8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1";

/// Tables decoded into derived triage sections (also present in `tables`).
const CUSTOM_ACTION_TABLE: &str = "CustomAction";
const SERVICE_INSTALL_TABLE: &str = "ServiceInstall";
const REGISTRY_TABLE: &str = "Registry";
const PROPERTY_TABLE: &str = "Property";
const SEQUENCE_TABLES: [&str; 4] = [
    "InstallExecuteSequence",
    "InstallUISequence",
    "AdminExecuteSequence",
    "AdminUISequence",
];

/// Interesting properties surfaced at the top level for quick triage.
const INTERESTING_PROPERTIES: [&str; 9] = [
    "ProductCode",
    "ProductName",
    "ProductVersion",
    "Manufacturer",
    "UpgradeCode",
    "PackageCode",
    "ProductLanguage",
    "ALLUSERS",
    "REBOOT",
];

fn io_err(code: &str, error: &std::io::Error) -> String {
    error_json(code, json!({ "detail": clean(&error.to_string()) }))
}

/// Open a read-only `msi::Package` over the bytes, or None with the failure
/// recorded in `warnings` (a valid CFB file need not be an MSI database).
fn open_package<F: Read + Seek>(
    inner: F,
    warnings: &mut Vec<String>,
) -> Option<msi::Package<F>> {
    match catch_unwind(AssertUnwindSafe(|| msi::Package::open(inner))) {
        Ok(Ok(package)) => Some(package),
        Ok(Err(error)) => {
            warnings.push(format!("not an MSI database: {}", clean(&error.to_string())));
            None
        }
        Err(_) => {
            warnings.push("panic during MSI package open".to_string());
            None
        }
    }
}

fn package_type_name(ptype: msi::PackageType) -> &'static str {
    match ptype {
        msi::PackageType::Installer => "installer",
        msi::PackageType::Patch => "patch",
        msi::PackageType::Transform => "transform",
    }
}

/// One CFB directory entry for the container listing.
fn cfb_entry_json(entry: &cfb::Entry) -> Value {
    let kind = if entry.is_root() {
        "root"
    } else if entry.is_storage() {
        "storage"
    } else {
        "stream"
    };
    let clsid = entry.clsid();
    json!({
        "path": clean(&entry.path().to_string_lossy()),
        "name": clean(entry.name()),
        "kind": kind,
        "size": entry.len(),
        "clsid": if clsid.is_nil() {
            Value::Null
        } else {
            json!(clsid.hyphenated().to_string().to_uppercase())
        },
    })
}

/// Decode one `msi::Value` cell into JSON.
fn cell_json(value: &msi::Value) -> Value {
    match value {
        msi::Value::Null => Value::Null,
        msi::Value::Int(number) => json!(number),
        msi::Value::Str(text) => json!(clean(text)),
        // Object/binary cells reference a named stream; never inline bytes.
        msi::Value::Binary => json!("<binary stream>"),
    }
}

/// Decode the CustomAction `Type` bitfield into a structured description.
///
/// The low six bits are the whole base type (not a kind nibble plus location
/// bits): 1/2/5/6/7 pull a payload from the Binary table, 17-23 reference an
/// installed file, 34/35 run a directory-formatted path, 37-39 carry inline
/// script text in Target, and 50-54 name a Property holding the command.
fn custom_action_type_json(raw: i64) -> Value {
    let base = raw & 0x3f;
    let (kind, location) = match base {
        1 => ("dll", "binary"),
        2 => ("exe", "binary"),
        5 => ("jscript", "binary"),
        6 => ("vbscript", "binary"),
        7 => ("install", "binary"),
        17 => ("dll", "installedFile"),
        18 => ("exe", "installedFile"),
        19 => ("install", "installedFile"),
        21 => ("jscript", "installedFile"),
        22 => ("vbscript", "installedFile"),
        23 => ("install", "installedFile"),
        34 => ("exe", "directoryPath"),
        35 => ("install", "directoryPath"),
        37 => ("jscript", "inlineText"),
        38 => ("vbscript", "inlineText"),
        39 => ("install", "inlineText"),
        50 => ("exe", "propertyValue"),
        51 => ("install", "propertyValue"),
        53 => ("jscript", "propertyValue"),
        54 => ("vbscript", "propertyValue"),
        other => {
            return json!({
                "kind": format!("unknown-{other}"),
                "location": "unknown",
                "flags": Vec::<String>::new(),
                "knownBase": false,
            })
        }
    };
    let in_script = raw & 0x400 != 0;
    let mut flags = Vec::new();
    if raw & 0x40 != 0 {
        flags.push("continue");
    }
    if raw & 0x80 != 0 {
        flags.push("async");
    }
    if in_script {
        if raw & 0x100 != 0 {
            flags.push("rollback");
        }
        if raw & 0x200 != 0 {
            flags.push("commit");
        }
    } else {
        match raw & 0x300 {
            0x300 => flags.push("clientRepeat"),
            0x100 => flags.push("firstSequence"),
            0x200 => flags.push("oncePerProcess"),
            _ => {}
        }
    }
    if in_script {
        flags.push("inScript");
    }
    if raw & 0x800 != 0 {
        flags.push("noImpersonate");
    }
    if raw & 0x1000 != 0 {
        flags.push("64bitScript");
    }
    if raw & 0x2000 != 0 {
        flags.push("hideTarget");
    }
    if raw & 0x4000 != 0 {
        flags.push("tsAware");
    }
    if raw & 0x8000 != 0 {
        flags.push("patchUninstall");
    }
    let known_bits: i64 = 0x3f | 0x40 | 0x80 | 0x300 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x8000;
    let mut out = Map::new();
    out.insert("kind".into(), json!(kind));
    out.insert("location".into(), json!(location));
    out.insert("flags".into(), json!(flags));
    out.insert("knownBase".into(), json!(true));
    let unknown = raw & !known_bits;
    if unknown != 0 {
        out.insert("unknownBits".into(), json!(format!("0x{unknown:x}")));
    }
    Value::Object(out)
}

/// True for CustomAction kinds that execute embedded or installed code.
fn kind_is_payload(kind: &str) -> bool {
    matches!(kind, "dll" | "exe" | "jscript" | "vbscript" | "install")
}

fn value_as_i64(value: &msi::Value) -> Option<i64> {
    match value {
        msi::Value::Int(number) => Some(*number as i64),
        _ => None,
    }
}

fn value_as_string(value: &msi::Value) -> Option<String> {
    match value {
        msi::Value::Str(text) => Some(clean(text)),
        msi::Value::Int(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Column value helpers that tolerate missing columns.
fn col_str(row: &msi::Row, name: &str) -> Option<String> {
    if row.has_column(name) {
        value_as_string(&row[name])
    } else {
        None
    }
}

fn col_int(row: &msi::Row, name: &str) -> Option<i64> {
    if row.has_column(name) {
        value_as_i64(&row[name])
    } else {
        None
    }
}

/// Decode a whole table into JSON rows, bounded per-table. `columns` must be
/// owned because `Rows` mutably borrows the package while alive.
fn table_json<F: Read + Seek>(
    package: &mut msi::Package<F>,
    name: &str,
    columns: &[msi::Column],
    max_rows: usize,
    warnings: &mut Vec<String>,
) -> Value {
    let column_meta: Vec<Value> = columns
        .iter()
        .map(|column| {
            json!({
                "name": column.name(),
                "type": format!("{:?}", column.coltype()),
                "nullable": column.is_nullable(),
                "primaryKey": column.is_primary_key(),
                "localizable": column.is_localizable(),
            })
        })
        .collect();
    // The Rows<'_> cursor borrows the package, so the entire select+decode
    // runs inside one catch_unwind that only returns owned JSON.
    let outcome = catch_unwind(AssertUnwindSafe(
        || -> Result<(usize, Vec<Value>), String> {
            let cursor = package
                .select_rows(msi::Select::table(name))
                .map_err(|error| clean(&error.to_string()))?;
            let row_count = cursor.len();
            let mut rows = Vec::new();
            for row in cursor.take(max_rows) {
                let mut object = Map::new();
                for (index, column) in row.columns().iter().enumerate() {
                    object.insert(column.name().to_string(), cell_json(&row[index]));
                }
                rows.push(Value::Object(object));
            }
            Ok((row_count, rows))
        },
    ));
    match outcome {
        Ok(Ok((row_count, rows))) => json!({
            "name": name,
            "columns": column_meta,
            "rowCount": row_count,
            "rows": rows,
            "rowsTruncated": row_count > rows.len(),
        }),
        Ok(Err(error)) => {
            warnings.push(format!("table {name} failed to decode: {error}"));
            json!({
                "name": name,
                "columns": column_meta,
                "rowCount": Value::Null,
                "rows": Vec::<Value>::new(),
                "rowsTruncated": false,
            })
        }
        Err(_) => {
            warnings.push(format!("panic decoding table {name}"));
            json!({
                "name": name,
                "columns": column_meta,
                "rowCount": Value::Null,
                "rows": Vec::<Value>::new(),
                "rowsTruncated": false,
            })
        }
    }
}

/// Derived section: decode the CustomAction table into triage form.
fn decode_custom_actions<F: Read + Seek>(
    package: &mut msi::Package<F>,
    warnings: &mut Vec<String>,
    findings: &mut Vec<Value>,
) -> Vec<Value> {
    let out = Vec::new();
    if !package.has_table(CUSTOM_ACTION_TABLE) {
        return out;
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<Value>, String> {
        let rows = package
            .select_rows(msi::Select::table(CUSTOM_ACTION_TABLE))
            .map_err(|error| clean(&error.to_string()))?;
        let mut out = Vec::new();
        for row in rows.take(MAX_TABLE_ROWS) {
            let action = col_str(&row, "Action");
            let raw_type = col_int(&row, "Type").unwrap_or(0);
            let source = col_str(&row, "Source");
            let target = col_str(&row, "Target");
            let extended = col_int(&row, "ExtendedType");
            let decoded = custom_action_type_json(raw_type);
            let kind = decoded["kind"].as_str().unwrap_or("").to_string();
            let location = decoded["location"].as_str().unwrap_or("").to_string();
            out.push(json!({
                "action": action.clone().unwrap_or_default(),
                "type": raw_type,
                "decoded": decoded,
                "source": source.clone().map(Value::from).unwrap_or(Value::Null),
                "target": target.clone().map(Value::from).unwrap_or(Value::Null),
                "extendedType": extended.map(Value::from).unwrap_or(Value::Null),
            }));
            if kind_is_payload(&kind) {
                findings.push(json!({
                    "kind": "customActionPayload",
                    "action": action.clone().unwrap_or_default(),
                    "payloadKind": kind,
                    "payloadLocation": location,
                    "source": source.clone().map(Value::from).unwrap_or(Value::Null),
                    "deferred": raw_type & 0x400 != 0,
                    "detail": format!(
                        "custom action {:?} executes a {kind} payload from {location}",
                        action.clone().unwrap_or_default()
                    ),
                }));
            }
            if let Some(target_text) = &target {
                let lower = target_text.to_ascii_lowercase();
                for marker in [
                    "powershell", "cmd.exe", "cmd /c", "wscript", "cscript", "mshta",
                    "rundll32", "regsvr32", "bitsadmin", "certutil", "msiexec",
                    "wmic", "curl ", "wget ", "http://", "https://",
                ] {
                    if lower.contains(marker) {
                        findings.push(json!({
                            "kind": "suspiciousCustomActionTarget",
                            "action": action.clone().unwrap_or_default(),
                            "marker": marker,
                            "detail": format!(
                                "custom action {:?} target contains {marker:?}",
                                action.clone().unwrap_or_default()
                            ),
                        }));
                        break;
                    }
                }
            }
        }
        Ok(out)
    }));
    match outcome {
        Ok(Ok(entries)) => entries,
        Ok(Err(error)) => {
            warnings.push(format!("CustomAction table failed to decode: {error}"));
            out
        }
        Err(_) => {
            warnings.push("panic decoding CustomAction table".to_string());
            out
        }
    }
}

/// Derived section: ordered action list for a `*Sequence` table.
fn decode_sequence<F: Read + Seek>(
    package: &mut msi::Package<F>,
    table_name: &str,
    warnings: &mut Vec<String>,
) -> Vec<Value> {
    let mut items = Vec::new();
    if !package.has_table(table_name) {
        return items;
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<Value>, String> {
        let rows = package
            .select_rows(msi::Select::table(table_name))
            .map_err(|error| clean(&error.to_string()))?;
        let mut items = Vec::new();
        for row in rows.take(MAX_TABLE_ROWS) {
            items.push(json!({
                "sequence": col_int(&row, "Sequence").unwrap_or(0),
                "action": col_str(&row, "Action").unwrap_or_default(),
                "condition": col_str(&row, "Condition")
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            }));
        }
        Ok(items)
    }));
    match outcome {
        Ok(Ok(decoded)) => items = decoded,
        Ok(Err(error)) => {
            warnings.push(format!("{table_name} failed to decode: {error}"));
            return items;
        }
        Err(_) => {
            warnings.push(format!("panic decoding {table_name}"));
            return items;
        }
    }
    items.sort_by(|a, b| {
        a["sequence"]
            .as_i64()
            .cmp(&b["sequence"].as_i64())
            .then(a["action"].as_str().cmp(&b["action"].as_str()))
    });
    items
}

/// Derived section: ServiceInstall rows as findings.
fn decode_service_installs<F: Read + Seek>(
    package: &mut msi::Package<F>,
    warnings: &mut Vec<String>,
    findings: &mut Vec<Value>,
) -> Vec<Value> {
    let services = Vec::new();
    if !package.has_table(SERVICE_INSTALL_TABLE) {
        return services;
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<Value>, String> {
        let rows = package
            .select_rows(msi::Select::table(SERVICE_INSTALL_TABLE))
            .map_err(|error| clean(&error.to_string()))?;
        let mut services = Vec::new();
        for row in rows.take(MAX_TABLE_ROWS) {
            let get = |name: &str| -> Option<String> { col_str(&row, name) };
            services.push(json!({
                "service": get("ServiceInstall"),
                "name": get("Name"),
                "displayName": get("DisplayName"),
                "serviceType": col_int(&row, "ServiceType"),
                "startType": col_int(&row, "StartType"),
                "errorControl": col_int(&row, "ErrorControl"),
                "loadOrderGroup": get("LoadOrderGroup"),
                "dependencies": get("Dependencies"),
                "startName": get("StartName"),
                "arguments": get("Arguments"),
                "component": get("Component_"),
                "description": get("Description"),
            }));
            findings.push(json!({
                "kind": "serviceInstall",
                "service": get("Name").map(Value::from).unwrap_or(Value::Null),
                "startType": col_int(&row, "StartType"),
                "detail": format!(
                    "installs service {:?} (startType {})",
                    get("Name").unwrap_or_default(),
                    col_int(&row, "StartType").unwrap_or_default()
                ),
            }));
        }
        Ok(services)
    }));
    match outcome {
        Ok(Ok(decoded)) => decoded,
        Ok(Err(error)) => {
            warnings.push(format!("ServiceInstall failed to decode: {error}"));
            services
        }
        Err(_) => {
            warnings.push("panic decoding ServiceInstall".to_string());
            services
        }
    }
}

/// Derived section: Registry rows that write Run/RunOnce persistence keys.
fn decode_registry_run_keys<F: Read + Seek>(
    package: &mut msi::Package<F>,
    warnings: &mut Vec<String>,
    findings: &mut Vec<Value>,
) {
    if !package.has_table(REGISTRY_TABLE) {
        return;
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let rows = package
            .select_rows(msi::Select::table(REGISTRY_TABLE))
            .map_err(|error| clean(&error.to_string()))?;
        for row in rows.take(MAX_TABLE_ROWS) {
            let get = |name: &str| -> Option<String> { col_str(&row, name) };
            let key = get("Key").unwrap_or_default();
            let lower = key.to_ascii_lowercase();
            if lower.contains("currentversion\\run")
                || lower.contains("currentversion\\runonce")
                || lower.contains("winlogon\\shell")
                || lower.contains("winlogon\\userinit")
            {
                findings.push(json!({
                    "kind": "registryPersistenceKey",
                    "root": col_int(&row, "Root"),
                    "key": clean(&key),
                    "name": get("Name").map(Value::from).unwrap_or(Value::Null),
                    "value": get("Value").map(Value::from).unwrap_or(Value::Null),
                    "detail": format!("writes registry persistence key {key:?}"),
                }));
            }
        }
        Ok(())
    }));
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            warnings.push(format!("Registry failed to decode: {error}"));
        }
        Err(_) => {
            warnings.push("panic decoding Registry".to_string());
        }
    }
}

/// Summary info properties worth surfacing.
fn summary_info_json(package: &msi::Package<Cursor<&[u8]>>) -> Value {
    let info = package.summary_info();
    let system_time_unix = |t: Option<std::time::SystemTime>| -> Value {
        t.and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| json!(duration.as_secs()))
            .unwrap_or(Value::Null)
    };
    json!({
        "title": info.title().map(clean),
        "subject": info.subject().map(clean),
        "author": info.author().map(clean),
        "keywords": info.keywords().iter().map(|word| clean(word)).collect::<Vec<String>>(),
        "comments": info.comments().map(clean),
        "creatingApplication": info.creating_application().map(clean),
        "lastSavedBy": info.last_saved_by().map(clean),
        "arch": info.arch().map(clean),
        "uuid": info.uuid().map(|uuid| uuid.hyphenated().to_string().to_uppercase()),
        "languages": info.languages().iter().map(|lang| clean(lang.tag())).collect::<Vec<String>>(),
        "creationTime": system_time_unix(info.creation_time()),
        "lastSavedTime": system_time_unix(info.last_saved_time()),
        "wordCount": info.word_count(),
        "pageCount": info.page_count(),
        "codepage": info.codepage().name(),
    })
}

pub(crate) fn inspect_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    let max_rows = option_u64(&options, "maxRowsPerTable")?
        .map(|value| value.clamp(1, MAX_TABLE_ROWS as u64) as usize)
        .unwrap_or(MAX_TABLE_ROWS);
    let max_tables = option_u64(&options, "maxTables")?
        .map(|value| value.clamp(1, MAX_LIST_ITEMS as u64) as usize)
        .unwrap_or(MAX_LIST_ITEMS);
    let table_filter = option_string(&options, "tableFilter")?;
    let hash_streams = !matches!(
        options.get("includeStreamHashes"),
        Some(Value::Bool(false))
    );

    if bytes.len() < CFB_MAGIC.len() || &bytes[..8] != CFB_MAGIC {
        return Err(error_json(
            "not_cfb",
            json!({ "detail": "missing D0CF11E0A1B11AE1 compound-file signature" }),
        ));
    }

    let mut warnings: Vec<String> = Vec::new();
    let mut truncated = false;

    // ---- CFB container listing ------------------------------------------
    let comp_outcome = catch_unwind(AssertUnwindSafe(|| {
        cfb::CompoundFile::open(Cursor::new(bytes))
    }));
    let comp = match comp_outcome {
        Ok(Ok(comp)) => comp,
        Ok(Err(error)) => return Err(io_err("invalid_cfb", &error)),
        Err(_) => {
            return Err(error_json(
                "internal",
                json!({ "detail": "panic during compound-file parse" }),
            ))
        }
    };
    let version = comp.version();
    let all_entries: Vec<cfb::Entry> = comp.walk().collect();
    let entry_count = all_entries.len();
    if entry_count > MAX_LIST_ITEMS {
        truncated = true;
        warnings.push(format!("compound-file entries truncated at {MAX_LIST_ITEMS}"));
    }
    let entries: Vec<Value> = all_entries
        .iter()
        .take(MAX_LIST_ITEMS)
        .map(cfb_entry_json)
        .collect();
    let root_clsid = comp
        .root_entry()
        .clsid()
        .hyphenated()
        .to_string()
        .to_uppercase();
    let cfb_json = json!({
        "version": version.number(),
        "entries": entries,
        "entryCount": entry_count,
        "rootClsid": root_clsid,
    });
    drop(comp);

    // ---- MSI package decode ---------------------------------------------
    let mut package = match open_package(Cursor::new(bytes), &mut warnings) {
        Some(package) => package,
        None => {
            // Still report the CFB listing: useful container-level triage.
            return finish_json(json!({
                "schema_version": 1,
                "format": "cfb",
                "isMsi": false,
                "cfb": cfb_json,
                "warnings": warnings,
                "truncated": truncated,
            }));
        }
    };

    let package_type = package.package_type();
    let digital_signature = package.has_digital_signature();

    // ---- embedded binary streams (decoded names) -------------------------
    let mut streams = Vec::new();
    let stream_names: Vec<String> = package.streams().take(MAX_LIST_ITEMS + 1).collect();
    if stream_names.len() > MAX_LIST_ITEMS {
        truncated = true;
        warnings.push(format!("streams truncated at {MAX_LIST_ITEMS}"));
    }
    for name in stream_names.iter().take(MAX_LIST_ITEMS) {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            package
                .read_stream(name)
                .and_then(|mut reader| {
                    let size = reader.seek(SeekFrom::End(0))?;
                    reader.seek(SeekFrom::Start(0))?;
                    let mut data = Vec::new();
                    reader.take(MAX_STREAM_READ_BYTES as u64 + 1).read_to_end(&mut data)?;
                    Ok((size, data))
                })
        }));
        match outcome {
            Ok(Ok((size, data))) => {
                let hashed_all = data.len() as u64 <= MAX_STREAM_READ_BYTES as u64;
                streams.push(json!({
                    "name": clean(name),
                    "size": size,
                    "sha256": if hash_streams && hashed_all {
                        json!(sha256_hex(&data))
                    } else {
                        Value::Null
                    },
                    "sha256Truncated": !hashed_all,
                }));
            }
            Ok(Err(error)) => {
                warnings.push(format!("stream {name:?} failed to read: {}", clean(&error.to_string())));
            }
            Err(_) => {
                warnings.push(format!("panic reading stream {name:?}"));
            }
        }
    }

    // ---- database tables -------------------------------------------------
    let mut tables = Vec::new();
    let table_names: Vec<String> = package
        .tables()
        .map(|table| table.name().to_string())
        .collect();
    for name in &table_names {
        if let Some(filter) = &table_filter {
            if filter != name {
                continue;
            }
        }
        if tables.len() >= max_tables {
            truncated = true;
            warnings.push(format!("tables truncated at {max_tables}"));
            break;
        }
        // Clone column metadata before select_rows mutably borrows package.
        let columns: Vec<msi::Column> = package
            .get_table(name)
            .map(|table| table.columns().to_vec())
            .unwrap_or_default();
        tables.push(table_json(&mut package, name, &columns, max_rows, &mut warnings));
    }

    // ---- derived triage sections -----------------------------------------
    let mut findings: Vec<Value> = Vec::new();
    let custom_actions =
        decode_custom_actions(&mut package, &mut warnings, &mut findings);
    let service_installs =
        decode_service_installs(&mut package, &mut warnings, &mut findings);
    decode_registry_run_keys(&mut package, &mut warnings, &mut findings);

    let mut sequences = Map::new();
    for table_name in SEQUENCE_TABLES {
        if package.has_table(table_name) {
            sequences.insert(
                table_name.to_string(),
                Value::Array(decode_sequence(&mut package, table_name, &mut warnings)),
            );
        }
    }

    // Interesting properties.
    let mut properties = Map::new();
    if package.has_table(PROPERTY_TABLE) {
        let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Map<String, Value>, String> {
            let rows = package
                .select_rows(msi::Select::table(PROPERTY_TABLE))
                .map_err(|error| clean(&error.to_string()))?;
            let mut properties = Map::new();
            for row in rows.take(MAX_TABLE_ROWS) {
                if let Some(name) = col_str(&row, "Property") {
                    if INTERESTING_PROPERTIES.contains(&name.as_str()) {
                        properties.insert(
                            name,
                            col_str(&row, "Value")
                                .map(Value::from)
                                .unwrap_or(Value::Null),
                        );
                    }
                }
            }
            Ok(properties)
        }));
        match outcome {
            Ok(Ok(decoded)) => properties = decoded,
            Ok(Err(error)) => {
                warnings.push(format!("Property table failed to decode: {error}"));
            }
            Err(_) => {
                warnings.push("panic decoding Property table".to_string());
            }
        }
    }

    if digital_signature {
        findings.push(json!({
            "kind": "digitalSignaturePresent",
            "detail": "package carries a digital signature stream (presence only; validity is not verified)",
        }));
    }

    let report = json!({
        "schema_version": 1,
        "format": "msi",
        "isMsi": true,
        "cfb": cfb_json,
        "package": {
            "type": package_type_name(package_type),
            "codePage": package.database_codepage().name(),
            "digitalSignature": digital_signature,
            "summaryInfo": summary_info_json(&package),
        },
        "properties": properties,
        "streams": streams,
        "streamCount": stream_names.len(),
        "tables": tables,
        "tableCount": table_names.len(),
        "customActions": custom_actions,
        "serviceInstalls": service_installs,
        "sequences": sequences,
        "findings": findings,
        "warnings": warnings,
        "truncated": truncated,
    });
    finish_json(report)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Read a declared-size prefix of a `Read + Seek` stream. Returns
/// `(declared_size, prefix_bytes)`.
fn stream_prefix<R: Read + Seek>(
    mut reader: R,
    limit: u64,
) -> std::io::Result<(u64, Vec<u8>)> {
    let declared = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(0))?;
    let take_len = declared.min(limit);
    let mut data = Vec::with_capacity(take_len.min(4 * 1024 * 1024) as usize);
    reader.take(take_len).read_to_end(&mut data)?;
    Ok((declared, data))
}

/// Common oversize check shared by both stream namespaces.
fn check_stream_size(
    name: &str,
    declared: u64,
    has_preview_cap: bool,
) -> Result<(), String> {
    if declared > MAX_STREAM_READ_BYTES as u64 {
        return Err(error_json(
            "stream_too_large",
            json!({
                "stream": clean(name),
                "declaredSize": declared,
                "limit": MAX_STREAM_READ_BYTES,
            }),
        ));
    }
    if !has_preview_cap && declared > MAX_CONTENT_BYTES as u64 {
        return Err(error_json(
            "stream_too_large",
            json!({
                "stream": clean(name),
                "declaredSize": declared,
                "limit": MAX_CONTENT_BYTES,
                "detail": "stream exceeds the JSON transport budget; request a bounded preview with maxBytes",
            }),
        ));
    }
    Ok(())
}

fn stream_json(name: &str, declared: u64, data: &[u8]) -> Result<String, String> {
    finish_json(json!({
        "schema_version": 1,
        "stream": clean(name),
        "size": data.len(),
        "declaredSize": declared,
        "sha256": sha256_hex(data),
        "contentBase64": data_encoding::BASE64.encode(data),
        "truncated": declared > data.len() as u64,
    }))
}

pub(crate) fn stream_read_impl(bytes: &[u8], options_json: &str) -> Result<String, String> {
    check_input(bytes)?;
    let options = parse_options(options_json)?;
    let name = option_string(&options, "stream")?.ok_or_else(|| {
        error_json("invalid_options", json!({ "detail": "missing required option: stream" }))
    })?;
    if name.is_empty() || name.len() > 512 {
        return Err(error_json(
            "invalid_options",
            json!({ "detail": "stream name must be 1..=512 bytes" }),
        ));
    }
    let max_bytes = option_u64(&options, "maxBytes")?
        .map(|value| value.clamp(1, MAX_CONTENT_BYTES as u64));
    let limit = max_bytes.unwrap_or(MAX_CONTENT_BYTES as u64);
    if bytes.len() < CFB_MAGIC.len() || &bytes[..8] != CFB_MAGIC {
        return Err(error_json(
            "not_cfb",
            json!({ "detail": "missing D0CF11E0A1B11AE1 compound-file signature" }),
        ));
    }

    // 1) Try the decoded MSI stream namespace first (Binary-table payloads).
    let mut package_warnings = Vec::new();
    if let Some(mut package) = open_package(Cursor::new(bytes), &mut package_warnings) {
        if package.has_stream(&name) {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                package
                    .read_stream(&name)
                    .and_then(|reader| stream_prefix(reader, limit))
            }));
            match outcome {
                Ok(Ok((declared, data))) => {
                    check_stream_size(&name, declared, max_bytes.is_some())?;
                    return stream_json(&name, declared, &data);
                }
                Ok(Err(error)) => return Err(io_err("stream_read_failed", &error)),
                Err(_) => {
                    return Err(error_json(
                        "internal",
                        json!({ "detail": "panic reading MSI stream" }),
                    ))
                }
            }
        }
        // fall through to raw CFB path lookup
    }

    // 2) Raw CFB stream path (e.g. "[5]SummaryInformation", "_Tables").
    let comp_outcome = catch_unwind(AssertUnwindSafe(|| {
        cfb::CompoundFile::open(Cursor::new(bytes))
    }));
    let mut comp = match comp_outcome {
        Ok(Ok(comp)) => comp,
        Ok(Err(error)) => return Err(io_err("invalid_cfb", &error)),
        Err(_) => {
            return Err(error_json(
                "internal",
                json!({ "detail": "panic during compound-file parse" }),
            ))
        }
    };
    let candidates = [name.clone(), format!("/{name}")];
    for path in candidates {
        if comp.is_stream(&path) {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                comp.open_stream(&path)
                    .and_then(|stream| stream_prefix(stream, limit))
            }));
            match outcome {
                Ok(Ok((declared, data))) => {
                    check_stream_size(&name, declared, max_bytes.is_some())?;
                    return stream_json(&name, declared, &data);
                }
                Ok(Err(error)) => return Err(io_err("stream_read_failed", &error)),
                Err(_) => {
                    return Err(error_json(
                        "internal",
                        json!({ "detail": "panic reading compound-file stream" }),
                    ))
                }
            }
        }
    }
    Err(error_json(
        "stream_not_found",
        json!({ "stream": clean(&name) }),
    ))
}
