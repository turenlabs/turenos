use goblin::elf;
use goblin::mach;
use goblin::Object;
use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_SECTIONS: usize = 512;
const MAX_SEGMENTS: usize = 512;
const MAX_IMPORTS: usize = 4096;
const MAX_EXPORTS: usize = 4096;
const MAX_SYMBOLS: usize = 4096;
const MAX_LIBRARIES: usize = 1024;
const MAX_MEMBERS: usize = 4096;
const MAX_STRING_BYTES: usize = 4096;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    schema_version: u8,
    format: String,
    architecture: String,
    bits: Option<u8>,
    endian: Option<&'static str>,
    entry_point: Option<String>,
    image_base: Option<String>,
    is_library: Option<bool>,
    interpreter: Option<String>,
    sections: Vec<Section>,
    segments: Vec<Segment>,
    imports: Vec<Import>,
    exports: Vec<Export>,
    symbols: Vec<Symbol>,
    libraries: Vec<String>,
    members: Vec<Member>,
    warnings: Vec<String>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Section {
    name: String,
    address: String,
    offset: String,
    size: String,
    flags: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Segment {
    kind: String,
    address: String,
    offset: String,
    file_size: String,
    memory_size: String,
    flags: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Import {
    name: String,
    library: Option<String>,
    address: Option<String>,
    offset: Option<String>,
    ordinal: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    name: String,
    address: String,
    offset: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Symbol {
    name: String,
    address: String,
    size: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    name: String,
    size: String,
    symbols: Vec<String>,
}

impl Inspection {
    fn new(format: &str) -> Self {
        Self {
            schema_version: 1,
            format: format.into(),
            architecture: "unknown".into(),
            bits: None,
            endian: None,
            entry_point: None,
            image_base: None,
            is_library: None,
            interpreter: None,
            sections: Vec::new(),
            segments: Vec::new(),
            imports: Vec::new(),
            exports: Vec::new(),
            symbols: Vec::new(),
            libraries: Vec::new(),
            members: Vec::new(),
            warnings: Vec::new(),
            truncated: false,
        }
    }
}

#[wasm_bindgen]
pub fn inspect(bytes: &[u8]) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!(
            "input size {} exceeds limit {}",
            bytes.len(),
            MAX_INPUT_BYTES
        )));
    }

    let mut result = match Object::parse(bytes).map_err(|error| JsError::new(&error.to_string()))? {
        Object::Elf(binary) => inspect_elf(&binary),
        Object::PE(binary) => inspect_pe(&binary),
        Object::Mach(binary) => inspect_mach(&binary),
        Object::Archive(binary) => inspect_archive(&binary),
        Object::TE(binary) => inspect_te(&binary),
        Object::COFF(binary) => inspect_coff(&binary),
        Object::Unknown(magic) => {
            let mut result = Inspection::new("unknown");
            result.warnings.push(format!("unknown magic 0x{magic:x}"));
            result
        }
        _ => return Err(JsError::new("unsupported object format")),
    };

    truncate_strings(&mut result);
    let json = serde_json::to_string(&result).map_err(|error| JsError::new(&error.to_string()))?;
    if json.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new(&format!(
            "serialized output size {} exceeds limit {}",
            json.len(),
            MAX_OUTPUT_BYTES
        )));
    }
    Ok(json)
}

fn inspect_elf(binary: &elf::Elf<'_>) -> Inspection {
    let mut result = Inspection::new("elf");
    result.architecture = elf_architecture(binary.header.e_machine).into();
    result.bits = Some(if binary.is_64 { 64 } else { 32 });
    result.endian = Some(if binary.little_endian {
        "little"
    } else {
        "big"
    });
    result.entry_point = Some(hex(binary.entry));
    result.is_library = Some(binary.is_lib);
    result.interpreter = binary.interpreter.map(clean);

    for header in binary.section_headers.iter().take(MAX_SECTIONS) {
        result.sections.push(Section {
            name: clean(binary.shdr_strtab.get_at(header.sh_name).unwrap_or("")),
            address: hex(header.sh_addr),
            offset: hex(header.sh_offset),
            size: decimal(header.sh_size),
            flags: hex(header.sh_flags),
        });
    }
    mark_truncated(
        &mut result,
        binary.section_headers.len(),
        MAX_SECTIONS,
        "sections",
    );

    for header in binary.program_headers.iter().take(MAX_SEGMENTS) {
        result.segments.push(Segment {
            kind: format!("0x{:x}", header.p_type),
            address: hex(header.p_vaddr),
            offset: hex(header.p_offset),
            file_size: decimal(header.p_filesz),
            memory_size: decimal(header.p_memsz),
            flags: format!(
                "{}{}{}",
                if header.is_read() { "r" } else { "-" },
                if header.is_write() { "w" } else { "-" },
                if header.is_executable() { "x" } else { "-" }
            ),
        });
    }
    mark_truncated(
        &mut result,
        binary.program_headers.len(),
        MAX_SEGMENTS,
        "segments",
    );

    for library in binary.libraries.iter().take(MAX_LIBRARIES) {
        result.libraries.push(clean(library));
    }
    mark_truncated(
        &mut result,
        binary.libraries.len(),
        MAX_LIBRARIES,
        "libraries",
    );

    for symbol in binary.dynsyms.iter().take(MAX_IMPORTS + MAX_EXPORTS) {
        let name = clean(binary.dynstrtab.get_at(symbol.st_name).unwrap_or(""));
        if name.is_empty() {
            continue;
        }
        if symbol.st_shndx == elf::section_header::SHN_UNDEF as usize {
            push_import(
                &mut result,
                Import {
                    name,
                    library: None,
                    address: Some(hex(symbol.st_value)),
                    offset: None,
                    ordinal: None,
                },
            );
        } else {
            push_export(
                &mut result,
                Export {
                    name,
                    address: hex(symbol.st_value),
                    offset: None,
                },
            );
        }
    }

    for symbol in binary.syms.iter().take(MAX_SYMBOLS) {
        let name = clean(binary.strtab.get_at(symbol.st_name).unwrap_or(""));
        if name.is_empty() {
            continue;
        }
        result.symbols.push(Symbol {
            name,
            address: hex(symbol.st_value),
            size: decimal(symbol.st_size),
            kind: format!("0x{:x}", symbol.st_type()),
        });
    }
    mark_truncated(&mut result, binary.syms.len(), MAX_SYMBOLS, "symbols");
    result
}

fn inspect_pe(binary: &goblin::pe::PE<'_>) -> Inspection {
    let mut result = Inspection::new("pe");
    result.architecture = pe_architecture(binary.header.coff_header.machine).into();
    result.bits = Some(if binary.is_64 { 64 } else { 32 });
    result.endian = Some("little");
    result.entry_point = Some(hex(binary.image_base.saturating_add(binary.entry as u64)));
    result.image_base = Some(hex(binary.image_base));
    result.is_library = Some(binary.is_lib);

    for section in binary.sections.iter().take(MAX_SECTIONS) {
        result.sections.push(Section {
            name: clean(section.name().unwrap_or("")),
            address: hex(binary
                .image_base
                .saturating_add(section.virtual_address as u64)),
            offset: hex(section.pointer_to_raw_data as u64),
            size: decimal(section.size_of_raw_data as u64),
            flags: hex(section.characteristics as u64),
        });
    }
    mark_truncated(&mut result, binary.sections.len(), MAX_SECTIONS, "sections");

    for library in binary.libraries.iter().take(MAX_LIBRARIES) {
        result.libraries.push(clean(library));
    }
    mark_truncated(
        &mut result,
        binary.libraries.len(),
        MAX_LIBRARIES,
        "libraries",
    );

    for item in binary.imports.iter().take(MAX_IMPORTS) {
        result.imports.push(Import {
            name: clean(&item.name),
            library: Some(clean(item.dll)),
            address: Some(hex(binary.image_base.saturating_add(item.offset as u64))),
            offset: Some(hex(item.offset as u64)),
            ordinal: Some(item.ordinal),
        });
    }
    mark_truncated(&mut result, binary.imports.len(), MAX_IMPORTS, "imports");

    for item in binary.exports.iter().take(MAX_EXPORTS) {
        result.exports.push(Export {
            name: clean(item.name.unwrap_or("")),
            address: hex(binary.image_base.saturating_add(item.rva as u64)),
            offset: item.offset.map(|value| hex(value as u64)),
        });
    }
    mark_truncated(&mut result, binary.exports.len(), MAX_EXPORTS, "exports");
    result
}

fn inspect_mach(binary: &mach::Mach<'_>) -> Inspection {
    match binary {
        mach::Mach::Binary(binary) => inspect_macho(binary),
        mach::Mach::Fat(binary) => {
            let mut result = Inspection::new("mach-fat");
            result.architecture = "universal".into();
            let arches = binary.arches().unwrap_or_default();
            for (index, arch) in arches.iter().take(MAX_MEMBERS).enumerate() {
                result.members.push(Member {
                    name: format!("arch-{index}-0x{:x}", arch.cputype),
                    size: decimal(arch.size as u64),
                    symbols: Vec::new(),
                });
            }
            mark_truncated(&mut result, arches.len(), MAX_MEMBERS, "architectures");
            result
        }
    }
}

fn inspect_macho(binary: &mach::MachO<'_>) -> Inspection {
    let mut result = Inspection::new("mach-o");
    result.architecture = mach_architecture(binary.header.cputype).into();
    result.bits = Some(if binary.is_64 { 64 } else { 32 });
    result.endian = Some(if binary.little_endian {
        "little"
    } else {
        "big"
    });
    result.entry_point = Some(hex(binary.entry));
    result.is_library = Some(binary.header.filetype == mach::header::MH_DYLIB);

    for segment in binary.segments.iter().take(MAX_SEGMENTS) {
        result.segments.push(Segment {
            kind: clean(segment.name().unwrap_or("")),
            address: hex(segment.vmaddr),
            offset: hex(segment.fileoff),
            file_size: decimal(segment.filesize),
            memory_size: decimal(segment.vmsize),
            flags: format!("0x{:x}", segment.initprot),
        });
        if result.sections.len() < MAX_SECTIONS {
            if let Ok(sections) = segment.sections() {
                for (section, _) in sections
                    .into_iter()
                    .take(MAX_SECTIONS - result.sections.len())
                {
                    result.sections.push(Section {
                        name: clean(section.name().unwrap_or("")),
                        address: hex(section.addr),
                        offset: hex(section.offset as u64),
                        size: decimal(section.size),
                        flags: hex(section.flags as u64),
                    });
                }
            }
        }
    }
    mark_truncated(&mut result, binary.segments.len(), MAX_SEGMENTS, "segments");

    for library in binary.libs.iter().skip(1).take(MAX_LIBRARIES) {
        result.libraries.push(clean(library));
    }
    mark_truncated(
        &mut result,
        binary.libs.len().saturating_sub(1),
        MAX_LIBRARIES,
        "libraries",
    );

    match binary.imports() {
        Ok(items) => {
            for item in items.iter().take(MAX_IMPORTS) {
                result.imports.push(Import {
                    name: clean(item.name),
                    library: Some(clean(item.dylib)),
                    address: Some(hex(item.address)),
                    offset: Some(hex(item.offset)),
                    ordinal: None,
                });
            }
            mark_truncated(&mut result, items.len(), MAX_IMPORTS, "imports");
        }
        Err(error) => result.warnings.push(clean(&error.to_string())),
    }

    match binary.exports() {
        Ok(items) => {
            for item in items.iter().take(MAX_EXPORTS) {
                result.exports.push(Export {
                    name: clean(&item.name),
                    address: hex(item.offset),
                    offset: Some(hex(item.offset)),
                });
            }
            mark_truncated(&mut result, items.len(), MAX_EXPORTS, "exports");
        }
        Err(error) => result.warnings.push(clean(&error.to_string())),
    }
    result
}

fn inspect_archive(binary: &goblin::archive::Archive<'_>) -> Inspection {
    let mut result = Inspection::new("archive");
    result.architecture = "multiple".into();
    let summary = binary.summarize();
    for (name, member, symbols) in summary.iter().take(MAX_MEMBERS) {
        result.members.push(Member {
            name: clean(name),
            size: decimal(member.size() as u64),
            symbols: symbols
                .iter()
                .take(MAX_SYMBOLS)
                .map(|value| clean(value))
                .collect(),
        });
    }
    mark_truncated(&mut result, summary.len(), MAX_MEMBERS, "members");
    result
}

fn inspect_te(binary: &goblin::pe::TE<'_>) -> Inspection {
    let mut result = Inspection::new("te");
    result.architecture = pe_architecture(binary.header.machine).into();
    result.bits = Some(if matches!(binary.header.machine, 0x8664 | 0xaa64) {
        64
    } else {
        32
    });
    result.endian = Some("little");
    result.entry_point = Some(hex(binary
        .header
        .image_base
        .saturating_add(binary.header.entry_point as u64)));
    result.image_base = Some(hex(binary.header.image_base));
    for section in binary.sections.iter().take(MAX_SECTIONS) {
        result.sections.push(Section {
            name: clean(section.name().unwrap_or("")),
            address: hex(section.virtual_address as u64),
            offset: hex(section.pointer_to_raw_data as u64),
            size: decimal(section.size_of_raw_data as u64),
            flags: hex(section.characteristics as u64),
        });
    }
    mark_truncated(&mut result, binary.sections.len(), MAX_SECTIONS, "sections");
    result
}

fn inspect_coff(binary: &goblin::pe::Coff<'_>) -> Inspection {
    let mut result = Inspection::new("coff");
    result.architecture = pe_architecture(binary.header.machine).into();
    result.bits = Some(if matches!(binary.header.machine, 0x8664 | 0xaa64) {
        64
    } else {
        32
    });
    result.endian = Some("little");
    for section in binary.sections.iter().take(MAX_SECTIONS) {
        result.sections.push(Section {
            name: clean(section.name().unwrap_or("")),
            address: hex(section.virtual_address as u64),
            offset: hex(section.pointer_to_raw_data as u64),
            size: decimal(section.size_of_raw_data as u64),
            flags: hex(section.characteristics as u64),
        });
    }
    mark_truncated(&mut result, binary.sections.len(), MAX_SECTIONS, "sections");
    result
}

fn push_import(result: &mut Inspection, value: Import) {
    if result.imports.len() < MAX_IMPORTS {
        result.imports.push(value);
    } else {
        result.truncated = true;
    }
}

fn push_export(result: &mut Inspection, value: Export) {
    if result.exports.len() < MAX_EXPORTS {
        result.exports.push(value);
    } else {
        result.truncated = true;
    }
}

fn mark_truncated(result: &mut Inspection, actual: usize, maximum: usize, field: &str) {
    if actual > maximum {
        result.truncated = true;
        result
            .warnings
            .push(format!("{field} truncated from {actual} to {maximum}"));
    }
}

fn truncate_strings(result: &mut Inspection) {
    for warning in &mut result.warnings {
        *warning = clean(warning);
    }
}

fn clean(value: &str) -> String {
    value.chars().take(MAX_STRING_BYTES).collect()
}

fn hex(value: impl Into<u64>) -> String {
    format!("0x{:x}", value.into())
}

fn decimal(value: impl Into<u64>) -> String {
    value.into().to_string()
}

fn elf_architecture(machine: u16) -> &'static str {
    match machine {
        3 => "x86",
        8 => "mips",
        20 | 21 => "powerpc",
        40 => "arm",
        62 => "x86_64",
        183 => "aarch64",
        243 => "riscv",
        247 => "bpf",
        _ => "unknown",
    }
}

fn pe_architecture(machine: u16) -> &'static str {
    match machine {
        0x014c => "x86",
        0x01c0 | 0x01c4 => "arm",
        0x0200 => "ia64",
        0x8664 => "x86_64",
        0xaa64 => "aarch64",
        0x5032 | 0x5064 | 0x5128 => "riscv",
        _ => "unknown",
    }
}

fn mach_architecture(cpu: u32) -> &'static str {
    match cpu {
        7 => "x86",
        0x0100_0007 => "x86_64",
        12 => "arm",
        0x0100_000c => "aarch64",
        18 => "powerpc",
        0x0100_0012 => "powerpc64",
        _ => "unknown",
    }
}
