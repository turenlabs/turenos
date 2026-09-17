//! Build-time ruleset compiler for turen-capa-match-wasm.
//!
//! Reads every `*.yml` rule under `upstream/capa-rules` (populated by
//! `script/import-upstream.sh` at the pinned capa-rules commit), normalizes
//! each rule through `src/ruledoc.rs`, and writes a single gzip-compressed
//! JSON blob to `OUT_DIR/rules.bin`. The module embeds it via include_bytes!.
//!
//! When the vendored ruleset has not been imported the build still succeeds
//! and embeds an empty ruleset marked `imported: false`, so `cargo test` works
//! without the upstream checkout. The workflow and test/verify.mjs require an
//! imported ruleset.

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::json;

#[path = "src/ruledoc.rs"]
mod ruledoc;

/// Pinned upstream commit — keep in sync with script/import-upstream.sh and
/// SOURCE.json. Recorded verbatim into the blob for provenance.
const CAPA_RULES_COMMIT: &str = "805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5";

/// Sanity ceiling: capa-rules holds ~1k rules; refuse pathological imports.
const MAX_RULE_FILES: usize = 8192;
/// Per-file ceiling (largest upstream rule is a few KiB).
const MAX_RULE_FILE_BYTES: u64 = 512 * 1024;
/// Decoded JSON blob ceiling before compression.
const MAX_BLOB_BYTES: usize = 16 * 1024 * 1024;

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let rules_root = Path::new("upstream").join("capa-rules");

    println!("cargo:rerun-if-changed=upstream/capa-rules");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/ruledoc.rs");

    let mut files = Vec::new();
    collect_yaml(&rules_root, &rules_root, &mut files);
    files.sort();
    files.dedup();
    files.truncate(MAX_RULE_FILES);

    let mut rules = Vec::new();
    let mut errors = Vec::new();
    for file in &files {
        let text = match fs::read_to_string(file) {
            Ok(text) => text,
            Err(error) => {
                errors.push(json!({"file": display_name(&rules_root, file), "error": error.to_string()}));
                continue;
            }
        };
        let relative = display_name(&rules_root, file);
        match ruledoc::rule_to_json(&relative, &text) {
            Ok(rule) => rules.push(rule),
            Err(error) => errors.push(json!({"file": relative, "error": error})),
        }
    }

    let imported = rules_root.join("LICENSE.txt").is_file() && !files.is_empty();
    let blob = json!({
        "v": 1,
        "commit": CAPA_RULES_COMMIT,
        "imported": imported,
        "rules": rules,
        "errors": errors,
    });
    let payload = serde_json::to_vec(&blob).expect("blob serialization");
    assert!(payload.len() <= MAX_BLOB_BYTES, "rules blob exceeds limit");

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&payload).expect("gzip rules blob");
    let compressed = encoder.finish().expect("gzip rules blob");
    fs::write(out_dir.join("rules.bin"), &compressed).expect("write rules.bin");

    let rule_count = blob["rules"].as_array().map_or(0, Vec::len);
    let error_count = blob["errors"].as_array().map_or(0, Vec::len);
    println!("cargo:rustc-env=CAPA_MATCH_RULES_IMPORTED={}", if imported { "1" } else { "0" });
    println!("cargo:rustc-env=CAPA_MATCH_RULES_COUNT={rule_count}");
    println!("cargo:warning=capa-match ruleset: {rule_count} rules, {error_count} parse errors, {} -> {} bytes",
        payload.len(), compressed.len());
    if !imported {
        println!("cargo:warning=capa-match: upstream/capa-rules not imported; embedded ruleset is EMPTY. Run script/import-upstream.sh");
    }
}

fn collect_yaml(root: &Path, directory: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            // .github holds CI YAML that is not rules; doc holds documentation.
            if name == ".github" || name == ".git" || name == "doc" {
                continue;
            }
            collect_yaml(root, &path, out);
        } else if name.ends_with(".yml") {
            if entry.metadata().map_or(0, |m| m.len()) <= MAX_RULE_FILE_BYTES {
                out.push(path);
            }
        }
    }
}

fn display_name(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
