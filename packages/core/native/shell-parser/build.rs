use std::{fs, path::Path};

fn main() {
    let modules = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules");
    let runtime = modules.join("web-tree-sitter");
    let manifest = include_str!("Cargo.toml");
    let runtime_version = version(&runtime);
    assert!(
        manifest
            .lines()
            .any(|line| line == format!("tree-sitter = \"={runtime_version}\"")),
        "Native and WASM tree-sitter versions must match"
    );

    for (grammar, expected) in [("bash", "0.25.0"), ("powershell", "0.25.10")] {
        let package = modules.join(format!("tree-sitter-{grammar}"));
        assert_eq!(
            version(&package),
            expected,
            "Retest parity after updating {grammar}"
        );
        let src = package.join("src");
        println!("cargo:rerun-if-changed={}", src.display());
        cc::Build::new()
            .include(&src)
            .file(src.join("parser.c"))
            .file(src.join("scanner.c"))
            .warnings(false)
            .compile(&format!("shell_grammar_{grammar}"));
    }
}

fn version(package: &Path) -> String {
    let json = package.join("package.json");
    println!("cargo:rerun-if-changed={}", json.display());
    let contents =
        fs::read_to_string(&json).unwrap_or_else(|error| panic!("{}: {error}", json.display()));
    let package: serde_json::Value = serde_json::from_str(&contents).expect("package metadata");
    package["version"]
        .as_str()
        .expect("package version")
        .to_owned()
}
