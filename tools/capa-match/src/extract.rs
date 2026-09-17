//! Static feature extraction from raw bytes.
//!
//! Produces the file-scope feature set the evaluator matches against:
//! format/os/arch globals, sections, imports/exports, api names, and the
//! extracted ASCII/UTF-16LE string table. No disassembly happens anywhere —
//! instruction-, basic-block-, and function-scoped features are never emitted.

use std::collections::{HashMap, HashSet};

use goblin::Object;
use sha2::{Digest, Sha256};

/// capa's minimum string length.
pub const MIN_STRING_LENGTH: usize = 4;
/// Distinct string values retained for matching and reporting.
pub const MAX_DISTINCT_STRINGS: usize = 64 * 1024;
/// Longest stored string value.
pub const MAX_STRING_VALUE: usize = 4096;
/// Location samples kept per distinct string/feature.
pub const MAX_LOCATIONS: usize = 8;
/// `characteristic: embedded pe` offsets retained.
pub const MAX_EMBEDDED_PE: usize = 16;
/// Collection ceilings for parsed structures.
pub const MAX_IMPORTS: usize = 4096;
pub const MAX_EXPORTS: usize = 4096;
pub const MAX_SECTIONS: usize = 512;
pub const MAX_LIBRARIES: usize = 1024;

#[derive(Debug, Default)]
pub struct StringHits {
    pub count: u64,
    pub locations: Vec<u64>,
}

#[derive(Debug)]
pub struct SectionInfo {
    pub name: String,
    pub offset: u64,
    pub size: u64,
    pub entropy: f64,
}

#[derive(Debug)]
pub struct FeatureSet {
    /// `format:` values — e.g. {"pe"} or {"pe", "dotnet"} for a managed PE.
    pub formats: Vec<String>,
    pub os: String,
    pub arch: String,
    /// `api:` match set — bare symbols, A/W-trimmed bases, `dll.#n` ordinals.
    pub apis: HashSet<String>,
    /// `import:` match set — `dll.sym`/`sym`/`dll` variants per capa helpers.
    pub imports: HashSet<String>,
    /// `export:` match set — names plus `dll.symbol` forwarded targets.
    pub exports: HashSet<String>,
    /// Import table entries for `capa_features` (name + dll + ordinal).
    pub import_names: Vec<(String, String)>,
    pub export_names: Vec<String>,
    pub sections: Vec<SectionInfo>,
    pub libraries: Vec<String>,
    /// distinct string value -> hits (occurrences + up to MAX_LOCATIONS offsets)
    pub strings: HashMap<String, StringHits>,
    pub total_strings: u64,
    pub strings_truncated: bool,
    pub embedded_pe: Vec<u64>,
    pub has_forwarded_export: bool,
    pub sha256: String,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

impl FeatureSet {
    pub fn extract(bytes: &[u8]) -> FeatureSet {
        let mut set = FeatureSet {
            formats: Vec::new(),
            os: "unknown".into(),
            arch: "unknown".into(),
            apis: HashSet::new(),
            imports: HashSet::new(),
            exports: HashSet::new(),
            import_names: Vec::new(),
            export_names: Vec::new(),
            sections: Vec::new(),
            libraries: Vec::new(),
            strings: HashMap::new(),
            total_strings: 0,
            strings_truncated: false,
            embedded_pe: Vec::new(),
            has_forwarded_export: false,
            sha256: hex_digest(&Sha256::digest(bytes)),
            truncated: false,
            warnings: Vec::new(),
        };

        match Object::parse(bytes) {
            Ok(Object::PE(pe)) => set.extract_pe(&pe, bytes),
            Ok(Object::Elf(elf)) => set.extract_elf(&elf, bytes),
            Ok(Object::Mach(mach)) => set.extract_mach(&mach, bytes),
            Ok(Object::Archive(_)) => set.formats.push("archive".into()),
            Ok(_) => {}
            Err(_) => {}
        }
        extract_strings(bytes, &mut set);
        carve_embedded_pe(bytes, &mut set);
        set
    }

    fn add_api(&mut self, symbol: &str) {
        if self.apis.len() < MAX_IMPORTS * 8 {
            self.apis.insert(symbol.to_string());
            if is_aw(symbol) {
                self.apis.insert(symbol[..symbol.len() - 1].to_string());
            }
        }
    }

    fn add_import(&mut self, feature: String) {
        if self.imports.len() < MAX_IMPORTS * 8 + MAX_LIBRARIES * 2 {
            self.imports.insert(feature);
        }
    }

    /// capa-features/extractors `generate_symbols` equivalents for one import.
    fn add_imported_symbol(&mut self, dll: &str, symbol: &str) {
        let dll_norm = normalize_dll(dll);
        let dll_ext = dll.to_lowercase();
        if dll_norm.is_empty() || is_ordinal(symbol) {
            // ELF-style imports and ordinals: `dll.#n` keeps the dll; a bare
            // `#n` or dll-less symbol is never emitted by capa.
            if !dll_norm.is_empty() {
                self.add_api(&format!("{dll_norm}.{symbol}"));
                self.add_import(format!("{dll_norm}.{symbol}"));
                self.add_import(format!("{dll_ext}.{symbol}"));
            }
            if dll_norm.is_empty() {
                self.add_api(symbol);
                self.add_import(symbol.to_string());
            }
            return;
        }
        self.add_api(symbol);
        self.add_import(format!("{dll_norm}.{symbol}"));
        self.add_import(format!("{dll_ext}.{symbol}"));
        self.add_import(symbol.to_string());
        if is_aw(symbol) {
            let base = &symbol[..symbol.len() - 1];
            self.add_import(format!("{dll_norm}.{base}"));
            self.add_import(format!("{dll_ext}.{base}"));
            self.add_import(base.to_string());
        }
    }

    fn add_imported_library(&mut self, dll: &str) {
        let dll_norm = normalize_dll(dll);
        self.add_import(dll_norm);
        self.add_import(dll.to_lowercase());
    }

    fn extract_pe(&mut self, pe: &goblin::pe::PE<'_>, bytes: &[u8]) {
        self.formats.push("pe".into());
        if pe
            .header
            .optional_header
            .and_then(|header| header.data_directories.get_clr_runtime_header().copied())
            .is_some()
        {
            self.formats.push("dotnet".into());
        }
        self.os = "windows".into();
        self.arch = pe_arch(pe.header.coff_header.machine);

        for section in pe.sections.iter().take(MAX_SECTIONS) {
            let name = clean(section.name().unwrap_or(""));
            let offset = section.pointer_to_raw_data as u64;
            let size = section.size_of_raw_data as u64;
            self.push_section(name, offset, size, bytes);
        }

        for library in pe.libraries.iter().take(MAX_LIBRARIES) {
            let library = clean(library);
            self.libraries.push(library.clone());
            self.add_imported_library(&library);
        }

        for import in pe.imports.iter().take(MAX_IMPORTS) {
            // goblin renders ordinal imports as `ORDINAL n`; capa calls them
            // `#n`, so `import: kernel32.#22` and `api: kernel32.#22` match.
            let name = match import.name.strip_prefix("ORDINAL ") {
                Some(ordinal) => format!("#{ordinal}"),
                None => import.name.to_string(),
            };
            let dll = clean(import.dll);
            self.import_names.push((dll.clone(), name.clone()));
            self.add_imported_symbol(&dll, &name);
        }
        if pe.imports.len() > MAX_IMPORTS {
            self.truncated = true;
        }

        for export in pe.exports.iter().take(MAX_EXPORTS) {
            if let Some(name) = export.name {
                let name = clean(name);
                self.export_names.push(name.clone());
                self.exports.insert(name);
            }
            if let Some(reexport) = &export.reexport {
                self.has_forwarded_export = true;
                match reexport {
                    goblin::pe::export::Reexport::DLLName { export, lib } => {
                        self.exports.insert(format!("{}.{}", lib.to_lowercase(), export));
                    }
                    goblin::pe::export::Reexport::DLLOrdinal { ordinal, lib } => {
                        self.exports.insert(format!("{}.#{ordinal}", lib.to_lowercase()));
                    }
                }
            }
        }
        if pe.exports.len() > MAX_EXPORTS {
            self.truncated = true;
        }
    }

    fn extract_elf(&mut self, elf: &goblin::elf::Elf<'_>, bytes: &[u8]) {
        self.formats.push("elf".into());
        self.os = elf_os(elf);
        self.arch = elf_arch(elf.header.e_machine);

        let mut names = Vec::with_capacity(elf.section_headers.len());
        for header in elf.section_headers.iter().take(MAX_SECTIONS) {
            names.push(clean(elf.shdr_strtab.get_at(header.sh_name).unwrap_or("")));
        }
        for (header, name) in elf.section_headers.iter().zip(names).take(MAX_SECTIONS) {
            self.push_section(name, header.sh_offset, header.sh_size, bytes);
        }
        // Android builds ship a .note.android.ident section.
        if self.sections.iter().any(|s| s.name == ".note.android.ident") {
            self.os = "android".into();
        }

        for library in elf.libraries.iter().take(MAX_LIBRARIES) {
            let library = clean(library);
            self.libraries.push(library.clone());
            self.add_imported_library(&library);
        }

        for symbol in elf.dynsyms.iter().take(MAX_IMPORTS + MAX_EXPORTS) {
            let name = elf.dynstrtab.get_at(symbol.st_name).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let name = clean(name);
            if symbol.st_shndx == goblin::elf::section_header::SHN_UNDEF as usize {
                self.import_names.push((String::new(), name.clone()));
                self.add_imported_symbol("", &name);
            } else if symbol.st_bind() != goblin::elf::sym::STB_LOCAL {
                self.export_names.push(name.clone());
                self.exports.insert(name);
            }
        }
    }

    fn extract_mach(&mut self, mach: &goblin::mach::Mach<'_>, bytes: &[u8]) {
        self.formats.push("macho".into());
        self.os = "macos".into();
        if let goblin::mach::Mach::Binary(binary) = mach {
            self.arch = mach_arch(binary.header.cputype);
            for segment in binary.segments.iter().take(MAX_SECTIONS) {
                if let Ok(sections) = segment.sections() {
                    for (section, _) in sections.into_iter().take(MAX_SECTIONS - self.sections.len()) {
                        let name = clean(section.name().unwrap_or(""));
                        self.push_section(name, section.offset as u64, section.size, bytes);
                    }
                }
            }
            for library in binary.libs.iter().skip(1).take(MAX_LIBRARIES) {
                let library = clean(library);
                self.libraries.push(library.clone());
                self.add_imported_library(&library);
            }
            if let Ok(imports) = binary.imports() {
                for import in imports.iter().take(MAX_IMPORTS) {
                    // Mach-O symbols carry a leading '_'
                    let name = clean(import.name);
                    self.import_names.push((clean(import.dylib), name.clone()));
                    self.add_imported_symbol(import.dylib, &name);
                    if let Some(stripped) = name.strip_prefix('_') {
                        self.add_imported_symbol(import.dylib, stripped);
                    }
                }
            }
            if let Ok(exports) = binary.exports() {
                for export in exports.iter().take(MAX_EXPORTS) {
                    let name = clean(&export.name);
                    self.export_names.push(name.clone());
                    self.exports.insert(name.clone());
                    if let Some(stripped) = name.strip_prefix('_') {
                        self.exports.insert(stripped.to_string());
                    }
                }
            }
        } else {
            self.arch = "universal".into();
        }
    }

    fn push_section(&mut self, name: String, offset: u64, size: u64, bytes: &[u8]) {
        if self.sections.len() >= MAX_SECTIONS {
            self.truncated = true;
            return;
        }
        let data = bytes
            .get(offset as usize..offset.saturating_add(size) as usize)
            .unwrap_or(&[]);
        self.sections.push(SectionInfo { name, offset, size, entropy: shannon(data) });
    }
}

fn is_aw(symbol: &str) -> bool {
    symbol.len() >= 2 && matches!(symbol.as_bytes()[symbol.len() - 1], b'A' | b'W')
}

fn is_ordinal(symbol: &str) -> bool {
    symbol.starts_with('#') || symbol.starts_with("ORDINAL ")
}

fn normalize_dll(dll: &str) -> String {
    let lower = dll.to_lowercase();
    for ext in [".dll", ".drv", ".so"] {
        if let Some(base) = lower.strip_suffix(ext) {
            return base.to_string();
        }
    }
    lower
}

/// Extract ASCII and UTF-16LE runs of >= MIN_STRING_LENGTH printable chars.
/// Occurrences are counted per distinct value for `count(string(...))`.
fn extract_strings(bytes: &[u8], set: &mut FeatureSet) {
    let mut ascii_start: Option<usize> = None;
    for index in 0..=bytes.len() {
        let byte = bytes.get(index).copied().unwrap_or(0);
        if (0x20..=0x7e).contains(&byte) {
            if ascii_start.is_none() {
                ascii_start = Some(index);
            }
        } else if let Some(start) = ascii_start.take() {
            commit_string(bytes, start, index, false, set);
        }
    }

    // UTF-16LE: runs of (printable, 0x00) pairs, relative to the run start.
    let mut index = 0usize;
    while index + 1 < bytes.len() {
        if is_wide_char(bytes, index) {
            let start = index;
            while index + 1 < bytes.len() && is_wide_char(bytes, index) {
                index += 2;
            }
            commit_string(bytes, start, index, true, set);
        } else {
            index += 1;
        }
    }
}

fn is_wide_char(bytes: &[u8], index: usize) -> bool {
    (0x20..=0x7e).contains(&bytes[index]) && bytes[index + 1] == 0
}

fn commit_string(bytes: &[u8], start: usize, end: usize, wide: bool, set: &mut FeatureSet) {
    // bound the transient decode buffer before allocating
    let end = end.min(start + MAX_STRING_VALUE * 4 + 4);
    let text = if wide {
        let units: Vec<u16> = bytes[start..end]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(&bytes[start..end]).into_owned()
    };
    if text.chars().count() < MIN_STRING_LENGTH {
        return;
    }
    set.total_strings += 1;
    let value: String = text.chars().take(MAX_STRING_VALUE).collect();
    match set.strings.get_mut(&value) {
        Some(hits) => {
            hits.count += 1;
            if hits.locations.len() < MAX_LOCATIONS {
                hits.locations.push(start as u64);
            }
        }
        None => {
            if set.strings.len() >= MAX_DISTINCT_STRINGS {
                set.strings_truncated = true;
                return;
            }
            set.strings.insert(value, StringHits { count: 1, locations: vec![start as u64] });
        }
    }
}

/// capa's carve_pe (unmodified variant, key 0 only): embedded `MZ` headers
/// whose e_lfanew points at a `PE\0\0` signature, starting at offset 1 so a
/// plain PE at offset 0 does not count.
fn carve_embedded_pe(bytes: &[u8], set: &mut FeatureSet) {
    let mut offset = 1usize;
    while set.embedded_pe.len() < MAX_EMBEDDED_PE {
        let Some(found) = find_subslice(&bytes[offset.min(bytes.len())..], b"MZ") else {
            break;
        };
        let mz = offset + found;
        offset = mz + 1;
        if bytes.len() < mz + 0x40 {
            continue;
        }
        let e_lfanew = u32::from_le_bytes(bytes[mz + 0x3c..mz + 0x40].try_into().unwrap()) as usize;
        let pe = mz + e_lfanew;
        if pe < bytes.len() && bytes.get(pe..pe + 2) == Some(b"PE".as_slice()) {
            set.embedded_pe.push(mz as u64);
        }
        if mz >= bytes.len() {
            break;
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn shannon(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &byte in data {
        counts[byte as usize] += 1;
    }
    let total = data.len() as f64;
    counts
        .iter()
        .filter(|&&count| count > 0)
        .map(|&count| {
            let probability = count as f64 / total;
            -probability * probability.log2()
        })
        .sum()
}

fn hex_digest(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn clean(value: &str) -> String {
    value.chars().take(4096).collect()
}

fn pe_arch(machine: u16) -> String {
    match machine {
        0x014c => "i386",
        0x8664 => "amd64",
        0x01c0 | 0x01c4 => "arm",
        0xaa64 => "aarch64",
        0x0200 => "ia64",
        0x5032 | 0x5064 | 0x5128 => "riscv",
        _ => "unknown",
    }
    .into()
}

fn elf_arch(machine: u16) -> String {
    match machine {
        3 => "i386",
        62 => "amd64",
        40 => "arm",
        183 => "aarch64",
        8 => "mips",
        20 | 21 => "powerpc",
        243 => "riscv",
        _ => "unknown",
    }
    .into()
}

fn mach_arch(cpu: u32) -> String {
    match cpu {
        7 => "i386",
        0x0100_0007 => "amd64",
        12 => "arm",
        0x0100_000c => "aarch64",
        _ => "unknown",
    }
    .into()
}

/// ELF EI_OSABI -> capa os name. Unrecognized Unix-like ABIs fall back to
/// `linux`, matching capa's handling of generic ELF files.
fn elf_os(elf: &goblin::elf::Elf<'_>) -> String {
    let osabi = elf.header.e_ident[goblin::elf::header::EI_OSABI];
    match osabi {
        1 => "hpux",
        2 => "netbsd",
        4 => "hurd",
        6 => "solaris",
        7 => "aix",
        8 => "irix",
        9 => "freebsd",
        10 => "tru64",
        11 => "modesto",
        12 => "openbsd",
        13 => "openvms",
        14 => "nsk",
        15 => "aros",
        16 => "fenixos",
        17 => "cloud",
        _ => "linux", // 0 (System V), 3 (Linux), and anything unmapped
    }
    .into()
}
