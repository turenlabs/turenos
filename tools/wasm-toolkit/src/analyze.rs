//! `wasm_analyze`: deep bounded static profile of a wasm module or component.
//!
//! Parse-only: bytes are decoded and validated through `wasmparser` but never
//! instantiated or executed. Feature detection validates the input once per
//! candidate feature with that feature disabled; a validation failure under an
//! otherwise-accepting feature set proves the input requires the feature.

use crate::{encoding_of, error_json, serialize_bounded, Options};
use serde::Serialize;
use wasmparser::{
    CompositeInnerType, ConstExpr, DataKind, ElementItems, ElementKind, ExternalKind, KnownCustom,
    MemoryType, Operator, Payload, TableType, TypeRef, Validator, WasmFeatures,
};

/// Maximum stored index-space entries (functions, tables, memories, globals,
/// tags, types). Larger spaces are counted but not resolvable to signatures.
const MAX_INDEX_SPACE: usize = 262_144;
/// Maximum stored function-type signatures.
const MAX_TYPE_SIGNATURES: usize = 8_192;
/// Maximum bytes kept for a single rendered signature or name.
const MAX_SIGNATURE_BYTES: usize = 1_024;
/// Function body size histogram upper bounds (bytes, `<=` per bucket).
const SIZE_BUCKETS: &[u64] = &[
    16, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, u64::MAX,
];

#[derive(Serialize)]
struct Analysis {
    schema_version: u32,
    input_bytes: usize,
    encoding: &'static str,
    valid: bool,
    valid_all_features: bool,
    validation_error: Option<String>,
    types: TypeSummary,
    imports: Vec<ImportEntry>,
    imports_total: u64,
    exports: Vec<ExportEntry>,
    exports_total: u64,
    functions: FunctionSummary,
    features: Vec<&'static str>,
    feature_detection: &'static str,
    custom_sections: Vec<CustomSectionEntry>,
    custom_sections_total: u64,
    start: Option<u32>,
    elements: ElementSummary,
    data: DataSummary,
    globals: Vec<GlobalEntry>,
    globals_total: u64,
    memories: Vec<MemoryEntry>,
    memories_total: u64,
    tables: Vec<TableEntry>,
    tables_total: u64,
    tags: Vec<TagEntry>,
    tags_total: u64,
    component: Option<ComponentSummary>,
    warnings: Vec<String>,
    truncated: bool,
}

impl Analysis {
    /// Bounded warning push: never grows `warnings` past `MAX_LIST`.
    fn warn(&mut self, message: String) {
        crate::push_warning(&mut self.warnings, &mut self.truncated, message);
    }
}

#[derive(Serialize, Default)]
struct TypeSummary {
    count: u64,
    funcs: u64,
    arrays: u64,
    structs: u64,
    conts: u64,
    rec_groups: u64,
}

#[derive(Serialize)]
struct ImportEntry {
    index: u32,
    module: String,
    name: String,
    kind: &'static str,
    signature: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
struct ExportEntry {
    name: String,
    kind: &'static str,
    index: u32,
    signature: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize, Default)]
struct FunctionSummary {
    count: u64,
    code_bytes: u64,
    min_body: Option<u64>,
    max_body: Option<u64>,
    histogram: Vec<SizeBucket>,
}

#[derive(Serialize)]
struct SizeBucket {
    le: u64,
    count: u64,
}

#[derive(Serialize)]
struct CustomSectionEntry {
    name: String,
    offset: u64,
    size: u64,
    recognized: bool,
    kind: &'static str,
    /// Depth 0 is the top-level module or component.
    depth: u32,
}

#[derive(Serialize, Default)]
struct ElementSummary {
    count: u64,
    active: u64,
    passive: u64,
    declared: u64,
    items_total: u64,
    segments: Vec<ElementEntry>,
}

#[derive(Serialize)]
struct ElementEntry {
    index: u32,
    mode: &'static str,
    table_index: Option<u32>,
    item_count: u64,
    expression_items: bool,
    element_type: Option<String>,
}

#[derive(Serialize, Default)]
struct DataSummary {
    count: u64,
    active: u64,
    passive: u64,
    bytes_total: u64,
    declared_count: Option<u32>,
    segments: Vec<DataEntry>,
}

#[derive(Serialize)]
struct DataEntry {
    index: u32,
    mode: &'static str,
    memory_index: Option<u32>,
    byte_len: u64,
}

#[derive(Serialize)]
struct GlobalEntry {
    index: u32,
    content_type: String,
    mutable: bool,
    shared: bool,
    init: Option<String>,
}

#[derive(Serialize)]
struct MemoryEntry {
    index: u32,
    min_pages: u64,
    max_pages: Option<u64>,
    shared: bool,
    memory64: bool,
    page_size_bytes: u32,
}

#[derive(Serialize)]
struct TableEntry {
    index: u32,
    element_type: String,
    min: u64,
    max: Option<u64>,
    table64: bool,
    shared: bool,
}

#[derive(Serialize)]
struct TagEntry {
    index: u32,
    kind: &'static str,
    type_index: u32,
    signature: Option<String>,
}

#[derive(Serialize)]
struct ComponentSummary {
    imports: u64,
    exports: u64,
    nested_modules: u64,
    nested_components: u64,
    /// Top-level component section kinds, in order.
    section_kinds: Vec<&'static str>,
}

/// Index spaces of the top-level core module, for signature resolution.
#[derive(Default)]
struct IndexSpaces {
    /// funcidx -> typeidx.
    funcs: Vec<u32>,
    tables: Vec<TableType>,
    memories: Vec<MemoryType>,
    globals: Vec<wasmparser::GlobalType>,
    tags: Vec<u32>,
    /// typeidx -> rendered func signature (func types only).
    type_sigs: Vec<Option<String>>,
    /// Set when any index space hit `MAX_INDEX_SPACE`.
    overflowed: bool,
}

impl IndexSpaces {
    fn push<T>(vec: &mut Vec<T>, value: T, overflowed: &mut bool) {
        if vec.len() < MAX_INDEX_SPACE {
            vec.push(value);
        } else {
            *overflowed = true;
        }
    }

    fn func_signature(&self, funcidx: u32) -> Option<String> {
        self.funcs
            .get(funcidx as usize)
            .and_then(|ty| self.type_sigs.get(*ty as usize))
            .and_then(|sig| sig.clone())
    }
}

/// Features probed by re-validation with the bit cleared. `(name, mask)`
/// where mask is the feature set to subtract from `WasmFeatures::all()`.
const FEATURE_PROBES: &[(&str, WasmFeatures)] = &[
    ("simd", WasmFeatures::SIMD),
    ("relaxed_simd", WasmFeatures::RELAXED_SIMD),
    ("threads", WasmFeatures::THREADS),
    ("shared_everything_threads", WasmFeatures::SHARED_EVERYTHING_THREADS),
    ("tail_call", WasmFeatures::TAIL_CALL),
    ("exceptions", WasmFeatures::EXCEPTIONS),
    ("legacy_exceptions", WasmFeatures::LEGACY_EXCEPTIONS),
    ("gc", WasmFeatures::GC),
    ("gc_types", WasmFeatures::GC_TYPES),
    ("function_references", WasmFeatures::FUNCTION_REFERENCES),
    // `REFERENCE_TYPES` also covers the `call_indirect_overlong` bit; subtract
    // it and add the sub-bit back so plain reference-type usage is measured.
    (
        "reference_types",
        WasmFeatures::REFERENCE_TYPES.difference(WasmFeatures::CALL_INDIRECT_OVERLONG),
    ),
    ("call_indirect_overlong", WasmFeatures::CALL_INDIRECT_OVERLONG),
    // `BULK_MEMORY` also covers the `bulk_memory_opt` (memory.copy/fill) bit.
    (
        "bulk_memory",
        WasmFeatures::BULK_MEMORY.difference(WasmFeatures::BULK_MEMORY_OPT),
    ),
    ("bulk_memory_opt", WasmFeatures::BULK_MEMORY_OPT),
    ("multi_value", WasmFeatures::MULTI_VALUE),
    ("multi_memory", WasmFeatures::MULTI_MEMORY),
    ("memory64", WasmFeatures::MEMORY64),
    ("extended_const", WasmFeatures::EXTENDED_CONST),
    ("custom_page_sizes", WasmFeatures::CUSTOM_PAGE_SIZES),
    ("wide_arithmetic", WasmFeatures::WIDE_ARITHMETIC),
    ("sign_extension", WasmFeatures::SIGN_EXTENSION),
    ("saturating_float_to_int", WasmFeatures::SATURATING_FLOAT_TO_INT),
    ("mutable_global", WasmFeatures::MUTABLE_GLOBAL),
    ("floats", WasmFeatures::FLOATS),
    ("memory_control", WasmFeatures::MEMORY_CONTROL),
    ("stack_switching", WasmFeatures::STACK_SWITCHING),
    ("custom_descriptors", WasmFeatures::CUSTOM_DESCRIPTORS),
    ("compact_imports", WasmFeatures::COMPACT_IMPORTS),
    ("component_model", WasmFeatures::COMPONENT_MODEL),
];

pub(crate) fn analyze(bytes: &[u8], options: &Options) -> String {
    let encoding = encoding_of(bytes);
    if encoding == "unknown" {
        return error_json("not_a_wasm_module");
    }
    let max_items = options.max_items();

    let default_result = Validator::new().validate_all(bytes);
    let valid = default_result.is_ok();
    let (valid_all_features, validation_error) = if valid {
        (true, None)
    } else {
        let error = default_result.err().map(|e| e.to_string());
        // A second pass under every known feature distinguishes "malformed"
        // from "requires an unfinished proposal".
        (Validator::new_with_features(WasmFeatures::all())
            .validate_all(bytes)
            .is_ok(), error)
    };

    let (features, feature_detection) = if valid_all_features {
        (detect_features(bytes), "complete")
    } else {
        (Vec::new(), "skipped_invalid")
    };

    let mut report = Analysis {
        schema_version: 1,
        input_bytes: bytes.len(),
        encoding,
        valid,
        valid_all_features,
        validation_error,
        types: TypeSummary::default(),
        imports: Vec::new(),
        imports_total: 0,
        exports: Vec::new(),
        exports_total: 0,
        functions: FunctionSummary::default(),
        features,
        feature_detection,
        custom_sections: Vec::new(),
        custom_sections_total: 0,
        start: None,
        elements: ElementSummary::default(),
        data: DataSummary::default(),
        globals: Vec::new(),
        globals_total: 0,
        memories: Vec::new(),
        memories_total: 0,
        tables: Vec::new(),
        tables_total: 0,
        tags: Vec::new(),
        tags_total: 0,
        component: None,
        warnings: Vec::new(),
        truncated: false,
    };
    report.functions.histogram = SIZE_BUCKETS
        .iter()
        .map(|le| SizeBucket { le: *le, count: 0 })
        .collect();

    let mut spaces = IndexSpaces::default();
    let mut depth: u32 = 0;
    let mut component = (encoding == "component").then(ComponentSummary::default);

    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        let payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                report.warn(truncated_msg(&format!("parse_failed: {error}")));
                break;
            }
        };

        let top_level = depth == 0;
        match payload {
            Payload::ModuleSection { .. } | Payload::ComponentSection { .. } => {
                if top_level {
                    if let Some(c) = component.as_mut() {
                        match payload {
                            Payload::ModuleSection { .. } => c.nested_modules += 1,
                            _ => c.nested_components += 1,
                        }
                        if c.section_kinds.len() < crate::MAX_LIST {
                            c.section_kinds.push(match payload {
                                Payload::ModuleSection { .. } => "module",
                                _ => "component",
                            });
                        } else {
                            report.truncated = true;
                        }
                    }
                }
                depth += 1;
                continue;
            }
            Payload::End(_) => {
                depth = depth.saturating_sub(1);
                continue;
            }
            _ => {}
        }

        if let Some(c) = component.as_mut() {
            if top_level {
                if let Some(kind) = component_section_kind(&payload) {
                    if c.section_kinds.len() < crate::MAX_LIST {
                        c.section_kinds.push(kind);
                    } else {
                        report.truncated = true;
                    }
                }
            }
        }

        match payload {
            Payload::TypeSection(reader) if top_level => {
                for group in reader {
                    match group {
                        Ok(group) => {
                            report.types.rec_groups += 1;
                            for sub in group.into_types() {
                                report.types.count += 1;
                                let sig = match &sub.composite_type.inner {
                                    CompositeInnerType::Func(func) => {
                                        report.types.funcs += 1;
                                        Some(clip(&func.to_string()))
                                    }
                                    CompositeInnerType::Array(_) => {
                                        report.types.arrays += 1;
                                        None
                                    }
                                    CompositeInnerType::Struct(_) => {
                                        report.types.structs += 1;
                                        None
                                    }
                                    CompositeInnerType::Cont(_) => {
                                        report.types.conts += 1;
                                        None
                                    }
                                };
                                if spaces.type_sigs.len() < MAX_TYPE_SIGNATURES {
                                    spaces.type_sigs.push(sig);
                                } else {
                                    spaces.overflowed = true;
                                }
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("type_section: {error}"))),
                    }
                }
            }
            Payload::ImportSection(reader) if top_level => {
                for group in reader {
                    match group {
                        Ok(group) => collect_imports(
                            group,
                            &mut report,
                            &mut spaces,
                            max_items,
                        ),
                        Err(error) => report.warn(truncated_msg(&format!("import_section: {error}"))),
                    }
                }
            }
            Payload::FunctionSection(reader) if top_level => {
                for item in reader {
                    match item {
                        Ok(typeidx) => IndexSpaces::push(
                            &mut spaces.funcs,
                            typeidx,
                            &mut spaces.overflowed,
                        ),
                        Err(error) => report.warn(truncated_msg(&format!("function_section: {error}"))),
                    }
                }
            }
            Payload::TableSection(reader) if top_level => {
                for table in reader {
                    match table {
                        Ok(table) => {
                            let index = spaces.tables.len() as u32;
                            IndexSpaces::push(
                                &mut spaces.tables,
                                table.ty,
                                &mut spaces.overflowed,
                            );
                            report.tables_total += 1;
                            if report.tables.len() < max_items {
                                report.tables.push(table_entry(index, &table.ty));
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("table_section: {error}"))),
                    }
                }
            }
            Payload::MemorySection(reader) if top_level => {
                for memory in reader {
                    match memory {
                        Ok(memory) => {
                            let index = spaces.memories.len() as u32;
                            IndexSpaces::push(
                                &mut spaces.memories,
                                memory,
                                &mut spaces.overflowed,
                            );
                            report.memories_total += 1;
                            if report.memories.len() < max_items {
                                report.memories.push(MemoryEntry {
                                    index,
                                    min_pages: memory.initial,
                                    max_pages: memory.maximum,
                                    shared: memory.shared,
                                    memory64: memory.memory64,
                                    page_size_bytes: memory.page_size(),
                                });
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("memory_section: {error}"))),
                    }
                }
            }
            Payload::TagSection(reader) if top_level => {
                for tag in reader {
                    match tag {
                        Ok(tag) => {
                            let index = spaces.tags.len() as u32;
                            IndexSpaces::push(
                                &mut spaces.tags,
                                tag.func_type_idx,
                                &mut spaces.overflowed,
                            );
                            report.tags_total += 1;
                            if report.tags.len() < max_items {
                                let signature = spaces
                                    .type_sigs
                                    .get(tag.func_type_idx as usize)
                                    .and_then(|sig| sig.clone());
                                report.tags.push(TagEntry {
                                    index,
                                    kind: "exception",
                                    type_index: tag.func_type_idx,
                                    signature,
                                });
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("tag_section: {error}"))),
                    }
                }
            }
            Payload::GlobalSection(reader) if top_level => {
                for global in reader {
                    match global {
                        Ok(global) => {
                            let index = spaces.globals.len() as u32;
                            IndexSpaces::push(
                                &mut spaces.globals,
                                global.ty,
                                &mut spaces.overflowed,
                            );
                            report.globals_total += 1;
                            if report.globals.len() < max_items {
                                report.globals.push(GlobalEntry {
                                    index,
                                    content_type: global.ty.content_type.to_string(),
                                    mutable: global.ty.mutable,
                                    shared: global.ty.shared,
                                    init: const_expr_kind(&global.init_expr),
                                });
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("global_section: {error}"))),
                    }
                }
            }
            Payload::ExportSection(reader) if top_level => {
                for export in reader {
                    match export {
                        Ok(export) => {
                            report.exports_total += 1;
                            if report.exports.len() < max_items {
                                report.exports.push(export_entry(export, &spaces));
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("export_section: {error}"))),
                    }
                }
            }
            Payload::StartSection { func, .. } if top_level => {
                report.start = Some(func);
            }
            Payload::ElementSection(reader) if top_level => {
                for element in reader {
                    match element {
                        Ok(element) => {
                            let index = report.elements.count as u32;
                            report.elements.count += 1;
                            let (mode, table_index) = match &element.kind {
                                ElementKind::Active {
                                    table_index, ..
                                } => {
                                    report.elements.active += 1;
                                    ("active", *table_index)
                                }
                                ElementKind::Passive => {
                                    report.elements.passive += 1;
                                    ("passive", None)
                                }
                                ElementKind::Declared => {
                                    report.elements.declared += 1;
                                    ("declared", None)
                                }
                            };
                            let (item_count, expression_items, element_type) =
                                match &element.items {
                                    ElementItems::Functions(funcs) => {
                                        (funcs.count() as u64, false, None)
                                    }
                                    ElementItems::Expressions(ty, exprs) => {
                                        (exprs.count() as u64, true, Some(ty.to_string()))
                                    }
                                };
                            report.elements.items_total += item_count;
                            if report.elements.segments.len() < max_items {
                                report.elements.segments.push(ElementEntry {
                                    index,
                                    mode,
                                    table_index,
                                    item_count,
                                    expression_items,
                                    element_type,
                                });
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("element_section: {error}"))),
                    }
                }
            }
            Payload::DataCountSection { count, .. } if top_level => {
                report.data.declared_count = Some(count);
            }
            Payload::DataSection(reader) if top_level => {
                for data in reader {
                    match data {
                        Ok(data) => {
                            let index = report.data.count as u32;
                            report.data.count += 1;
                            let (mode, memory_index) = match &data.kind {
                                DataKind::Active { memory_index, .. } => {
                                    report.data.active += 1;
                                    ("active", Some(*memory_index))
                                }
                                DataKind::Passive => {
                                    report.data.passive += 1;
                                    ("passive", None)
                                }
                            };
                            report.data.bytes_total += data.data.len() as u64;
                            if report.data.segments.len() < max_items {
                                report.data.segments.push(DataEntry {
                                    index,
                                    mode,
                                    memory_index,
                                    byte_len: data.data.len() as u64,
                                });
                            } else {
                                report.truncated = true;
                            }
                        }
                        Err(error) => report.warn(truncated_msg(&format!("data_section: {error}"))),
                    }
                }
            }
            Payload::CodeSectionEntry(body) if top_level => {
                let size = body.range().end - body.range().start;
                report.functions.count += 1;
                report.functions.code_bytes += size;
                report.functions.min_body = Some(
                    report
                        .functions
                        .min_body
                        .map(|min| min.min(size))
                        .unwrap_or(size),
                );
                report.functions.max_body = Some(
                    report
                        .functions
                        .max_body
                        .map(|max| max.max(size))
                        .unwrap_or(size),
                );
                let bucket = SIZE_BUCKETS
                    .iter()
                    .position(|upper| size <= *upper)
                    .unwrap_or(SIZE_BUCKETS.len() - 1);
                report.functions.histogram[bucket].count += 1;
            }
            Payload::CustomSection(reader) => {
                report.custom_sections_total += 1;
                if report.custom_sections.len() < max_items {
                    report.custom_sections.push(CustomSectionEntry {
                        name: clip(reader.name()),
                        offset: reader.range().start,
                        size: reader.data().len() as u64,
                        recognized: custom_recognized(reader.name(), &reader.as_known()),
                        kind: custom_kind(reader.name(), &reader.as_known()),
                        depth,
                    });
                } else {
                    report.truncated = true;
                }
            }
            Payload::ComponentImportSection(reader) if top_level => {
                if let Some(c) = component.as_mut() {
                    c.imports += reader.count() as u64;
                }
            }
            Payload::ComponentExportSection(reader) if top_level => {
                if let Some(c) = component.as_mut() {
                    c.exports += reader.count() as u64;
                }
            }
            _ => {}
        }
    }

    if let Some(c) = component {
        report.component = Some(c);
    }
    if spaces.overflowed {
        report.warn("index space exceeded cap; some signatures unavailable".to_string());
    }

    serialize_bounded(&report)
}

/// Detects required features by re-validating once per probe with that feature
/// removed from the otherwise-accepting `WasmFeatures::all()` set.
fn detect_features(bytes: &[u8]) -> Vec<&'static str> {
    let all = WasmFeatures::all();
    let mut detected = Vec::with_capacity(FEATURE_PROBES.len());
    for (name, probe) in FEATURE_PROBES {
        let mut validator = Validator::new_with_features(all.difference(*probe));
        if validator.validate_all(bytes).is_err() {
            detected.push(*name);
        }
    }
    detected
}

fn collect_imports(
    group: wasmparser::Imports<'_>,
    report: &mut Analysis,
    spaces: &mut IndexSpaces,
    max_items: usize,
) {
    match group {
        wasmparser::Imports::Single(_, import) => {
            push_import(report, spaces, import.module, import.name, import.ty, max_items)
        }
        wasmparser::Imports::Compact1 { module, items, .. } => {
            for item in items {
                match item {
                    Ok(item) => push_import(
                        report,
                        spaces,
                        module,
                        item.name,
                        item.ty,
                        max_items,
                    ),
                    Err(error) => report.warn(truncated_msg(&format!("import_section: {error}"))),
                }
            }
        }
        wasmparser::Imports::Compact2 { module, ty, names, .. } => {
            for name in names {
                match name {
                    Ok(name) => push_import(report, spaces, module, name, ty, max_items),
                    Err(error) => report.warn(truncated_msg(&format!("import_section: {error}"))),
                }
            }
        }
    }
}

fn push_import(
    report: &mut Analysis,
    spaces: &mut IndexSpaces,
    module: &str,
    name: &str,
    ty: TypeRef,
    max_items: usize,
) {
    let (kind, index, signature, detail) = match ty {
        TypeRef::Func(typeidx) | TypeRef::FuncExact(typeidx) => {
            let index = spaces.funcs.len() as u32;
            IndexSpaces::push(&mut spaces.funcs, typeidx, &mut spaces.overflowed);
            let signature = spaces
                .type_sigs
                .get(typeidx as usize)
                .and_then(|sig| sig.clone());
            ("func", index, signature, None)
        }
        TypeRef::Table(table) => {
            let index = spaces.tables.len() as u32;
            IndexSpaces::push(&mut spaces.tables, table, &mut spaces.overflowed);
            ("table", index, None, Some(describe_table(&table)))
        }
        TypeRef::Memory(memory) => {
            let index = spaces.memories.len() as u32;
            IndexSpaces::push(&mut spaces.memories, memory, &mut spaces.overflowed);
            ("memory", index, None, Some(describe_memory(&memory)))
        }
        TypeRef::Global(global) => {
            let index = spaces.globals.len() as u32;
            IndexSpaces::push(&mut spaces.globals, global, &mut spaces.overflowed);
            (
                "global",
                index,
                None,
                Some(format!(
                    "{}{}",
                    if global.mutable { "mut " } else { "" },
                    global.content_type
                )),
            )
        }
        TypeRef::Tag(tag) => {
            let index = spaces.tags.len() as u32;
            IndexSpaces::push(&mut spaces.tags, tag.func_type_idx, &mut spaces.overflowed);
            let signature = spaces
                .type_sigs
                .get(tag.func_type_idx as usize)
                .and_then(|sig| sig.clone());
            ("tag", index, signature, None)
        }
    };
    report.imports_total += 1;
    if report.imports.len() < max_items {
        report.imports.push(ImportEntry {
            index,
            module: clip(module),
            name: clip(name),
            kind,
            signature,
            detail,
        });
    } else {
        report.truncated = true;
    }
}

fn export_entry(export: wasmparser::Export<'_>, spaces: &IndexSpaces) -> ExportEntry {
    let (kind, signature, detail) = match export.kind {
        ExternalKind::Func | ExternalKind::FuncExact => {
            ("func", spaces.func_signature(export.index), None)
        }
        ExternalKind::Table => (
            "table",
            None,
            spaces
                .tables
                .get(export.index as usize)
                .map(describe_table),
        ),
        ExternalKind::Memory => (
            "memory",
            None,
            spaces
                .memories
                .get(export.index as usize)
                .map(describe_memory),
        ),
        ExternalKind::Global => (
            "global",
            None,
            spaces.globals.get(export.index as usize).map(|ty| {
                format!(
                    "{}{}",
                    if ty.mutable { "mut " } else { "" },
                    ty.content_type
                )
            }),
        ),
        ExternalKind::Tag => (
            "tag",
            spaces
                .tags
                .get(export.index as usize)
                .and_then(|ty| spaces.type_sigs.get(*ty as usize))
                .and_then(|sig| sig.clone()),
            None,
        ),
    };
    ExportEntry {
        name: clip(export.name),
        kind,
        index: export.index,
        signature,
        detail,
    }
}

fn table_entry(index: u32, ty: &TableType) -> TableEntry {
    TableEntry {
        index,
        element_type: ty.element_type.to_string(),
        min: ty.initial,
        max: ty.maximum,
        table64: ty.table64,
        shared: ty.shared,
    }
}

fn describe_table(ty: &TableType) -> String {
    let mut text = format!("{}[{}", ty.element_type, ty.initial);
    if let Some(max) = ty.maximum {
        text.push_str(&format!("..{max}"));
    } else {
        text.push_str("..");
    }
    text.push(']');
    if ty.table64 {
        text.push_str(" i64");
    }
    if ty.shared {
        text.push_str(" shared");
    }
    text
}

fn describe_memory(ty: &MemoryType) -> String {
    let mut text = format!("pages[{}", ty.initial);
    if let Some(max) = ty.maximum {
        text.push_str(&format!("..{max}"));
    } else {
        text.push_str("..");
    }
    text.push(']');
    if ty.memory64 {
        text.push_str(" i64");
    }
    if ty.shared {
        text.push_str(" shared");
    }
    if let Some(log2) = ty.page_size_log2 {
        text.push_str(&format!(" page_size=1<<{log2}"));
    }
    text
}

/// Renders the first instruction of a const expression as a short opcode name.
fn const_expr_kind(expr: &ConstExpr<'_>) -> Option<String> {
    let mut reader = expr.get_operators_reader();
    let op = reader.read().ok()?;
    Some(
        match op {
            Operator::I32Const { .. } => "i32.const",
            Operator::I64Const { .. } => "i64.const",
            Operator::F32Const { .. } => "f32.const",
            Operator::F64Const { .. } => "f64.const",
            Operator::V128Const { .. } => "v128.const",
            Operator::GlobalGet { .. } => "global.get",
            Operator::RefNull { .. } => "ref.null",
            Operator::RefFunc { .. } => "ref.func",
            _ => "expr",
        }
        .to_string(),
    )
}

fn component_section_kind(payload: &Payload<'_>) -> Option<&'static str> {
    Some(match payload {
        Payload::TypeSection(_) => return None, // core type section, depth >= 1
        Payload::CoreTypeSection(_) => "core-type",
        Payload::InstanceSection(_) => "core-instance",
        Payload::ComponentInstanceSection(_) => "instance",
        Payload::ComponentAliasSection(_) => "alias",
        Payload::ComponentTypeSection(_) => "type",
        Payload::ComponentCanonicalSection(_) => "canonical",
        Payload::ComponentStartSection { .. } => "start",
        Payload::ComponentImportSection(_) => "import",
        Payload::ComponentExportSection(_) => "export",
        Payload::CustomSection(_) => "custom",
        _ => return None,
    })
}

fn custom_kind(name: &str, known: &KnownCustom<'_>) -> &'static str {
    match known {
        KnownCustom::Name(_) => "name",
        KnownCustom::ComponentName(_) => "component-name",
        KnownCustom::BranchHints(_) => "branch-hints",
        KnownCustom::Producers(_) => "producers",
        KnownCustom::Dylink0(_) => "dylink.0",
        KnownCustom::CoreDump(_) => "coredump",
        KnownCustom::CoreDumpStack(_) => "coredump-stack",
        KnownCustom::CoreDumpInstances(_) => "coredump-instances",
        KnownCustom::CoreDumpModules(_) => "coredump-modules",
        KnownCustom::Linking(_) => "linking",
        KnownCustom::Reloc(_) => "reloc",
        KnownCustom::Unknown => match name {
            "target-features" => "target-features",
            "sourceMappingURL" => "sourceMappingURL",
            _ if name.starts_with("reloc.") => "reloc",
            _ => "unknown",
        },
        _ => "unknown",
    }
}

fn custom_recognized(name: &str, known: &KnownCustom<'_>) -> bool {
    if !matches!(known, KnownCustom::Unknown) {
        return true;
    }
    matches!(name, "target-features" | "sourceMappingURL" | "dylink.0" | "dylink")
        || name.starts_with("reloc.")
}

/// Clip a string to `MAX_SIGNATURE_BYTES` on a char boundary.
fn clip(text: &str) -> String {
    if text.len() <= MAX_SIGNATURE_BYTES {
        return text.to_string();
    }
    let mut end = MAX_SIGNATURE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn truncated_msg(text: &str) -> String {
    clip(text)
}

impl Default for ComponentSummary {
    fn default() -> Self {
        ComponentSummary {
            imports: 0,
            exports: 0,
            nested_modules: 0,
            nested_components: 0,
            section_kinds: Vec::new(),
        }
    }
}
