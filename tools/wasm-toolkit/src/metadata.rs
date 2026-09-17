//! `wasm_metadata`: producers section, name-section summary,
//! `sourceMappingURL`, and a component-model outline. Parse-only.

use crate::{encoding_of, error_json, serialize_bounded, Options};
use serde::Serialize;
use std::collections::BTreeMap;
use wasmparser::{ComponentExternalKind, ComponentTypeRef, KnownCustom, Payload};

#[derive(Serialize)]
struct MetadataReport {
    schema_version: u32,
    input_bytes: usize,
    encoding: &'static str,
    /// `null` when no producers section exists.
    producers: Option<BTreeMap<String, Vec<NamedVersion>>>,
    producers_error: Option<String>,
    name_section: Option<NameSummary>,
    source_mapping_url: Option<String>,
    custom_sections: Vec<CustomSectionEntry>,
    custom_sections_total: u64,
    component: Option<ComponentOutline>,
    warnings: Vec<String>,
    truncated: bool,
}

impl MetadataReport {
    /// Bounded warning push: never grows `warnings` past `MAX_LIST`.
    fn warn(&mut self, message: String) {
        crate::push_warning(&mut self.warnings, &mut self.truncated, message);
    }
}

#[derive(Serialize)]
struct NamedVersion {
    name: String,
    version: String,
}

#[derive(Serialize, Default)]
struct NameSummary {
    /// `"name"` for core modules, `"component-name"` for components.
    section: &'static str,
    /// Module/component name from subsection 0, if present.
    module_name: Option<String>,
    /// Per-subsection entry counts keyed by subsection kind.
    subsections: Vec<NameSubsection>,
    named_total: u64,
}

#[derive(Serialize)]
struct NameSubsection {
    kind: &'static str,
    entries: u64,
}

#[derive(Serialize)]
struct CustomSectionEntry {
    name: String,
    offset: u64,
    size: u64,
    recognized: bool,
    depth: u32,
}

#[derive(Serialize, Default)]
struct ComponentOutline {
    imports: Vec<ComponentExternal>,
    imports_total: u64,
    exports: Vec<ComponentExternal>,
    exports_total: u64,
    nested_modules: u64,
    nested_components: u64,
}

#[derive(Serialize)]
struct ComponentExternal {
    name: String,
    kind: &'static str,
    /// Entity index for exports; absent for imports.
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<u32>,
    /// Referenced type index for imports; absent for exports.
    #[serde(skip_serializing_if = "Option::is_none")]
    type_index: Option<u32>,
    /// Implements-target, version suffix, or external id when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    qualifiers: Option<String>,
}

const MAX_NAME_BYTES: usize = 1_024;

pub(crate) fn metadata(bytes: &[u8], options: &Options) -> String {
    let encoding = encoding_of(bytes);
    if encoding == "unknown" {
        return error_json("not_a_wasm_module");
    }
    let max_items = options.max_items();

    let (producers, producers_error) = match wasm_metadata::Producers::from_wasm(bytes) {
        Ok(Some(producers)) => {
            let mut fields = BTreeMap::new();
            for (field, values) in producers.iter() {
                let mut entries = Vec::new();
                for (name, version) in values.iter() {
                    if entries.len() < max_items {
                        entries.push(NamedVersion {
                            name: clip(name),
                            version: clip(version),
                        });
                    }
                }
                fields.insert(clip(field), entries);
            }
            (Some(fields), None)
        }
        Ok(None) => (None, None),
        Err(error) => (None, Some(clip(&error.to_string()))),
    };

    let mut report = MetadataReport {
        schema_version: 1,
        input_bytes: bytes.len(),
        encoding,
        producers,
        producers_error,
        name_section: None,
        source_mapping_url: None,
        custom_sections: Vec::new(),
        custom_sections_total: 0,
        component: (encoding == "component").then(ComponentOutline::default),
        warnings: Vec::new(),
        truncated: false,
    };

    let mut depth: u32 = 0;
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        let payload = match payload {
            Ok(payload) => payload,
            Err(error) => {
                report.warn(clip(&format!("parse_failed: {error}")));
                break;
            }
        };
        match payload {
            Payload::ModuleSection { .. } => {
                if let Some(c) = report.component.as_mut() {
                    if depth == 0 {
                        c.nested_modules += 1;
                    }
                }
                depth += 1;
                continue;
            }
            Payload::ComponentSection { .. } => {
                if let Some(c) = report.component.as_mut() {
                    if depth == 0 {
                        c.nested_components += 1;
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

        match payload {
            Payload::CustomSection(reader) => {
                report.custom_sections_total += 1;
                let known = reader.as_known();
                if report.custom_sections.len() < max_items {
                    report.custom_sections.push(CustomSectionEntry {
                        name: clip(reader.name()),
                        offset: reader.range().start,
                        size: reader.data().len() as u64,
                        recognized: recognized(reader.name(), &known),
                        depth,
                    });
                } else {
                    report.truncated = true;
                }

                if depth == 0 && report.name_section.is_none() {
                    match known {
                        KnownCustom::Name(names) => {
                            report.name_section = Some(read_name_section(names, "name"));
                        }
                        KnownCustom::ComponentName(names) => {
                            report.name_section =
                                Some(read_component_name_section(names));
                        }
                        _ => {}
                    }
                }
                if depth == 0 && reader.name() == "sourceMappingURL" {
                    match std::str::from_utf8(reader.data()) {
                        Ok(url) => report.source_mapping_url = Some(clip(url)),
                        Err(_) => report.warn("sourceMappingURL section is not utf-8".to_string()),
                    }
                }
            }
            Payload::ComponentImportSection(reader) if depth == 0 => {
                // Errors are buffered so `report` stays borrowable only via `c`.
                let mut errors = Vec::new();
                let mut truncated_flag = false;
                if let Some(c) = report.component.as_mut() {
                    for import in reader {
                        match import {
                            Ok(import) => {
                                c.imports_total += 1;
                                if c.imports.len() < max_items {
                                    c.imports.push(ComponentExternal {
                                        name: clip(import.name.name),
                                        kind: type_ref_kind(&import.ty),
                                        index: None,
                                        type_index: type_ref_index(&import.ty),
                                        qualifiers: extern_name_qualifiers(
                                            &import.name,
                                        ),
                                    });
                                } else {
                                    truncated_flag = true;
                                }
                            }
                            Err(error) => {
                                if errors.len() < crate::MAX_WARNINGS {
                                    errors.push(clip(&format!("component_import: {error}")));
                                } else {
                                    truncated_flag = true;
                                }
                            }
                        }
                    }
                }
                if truncated_flag {
                    report.truncated = true;
                }
                for error in errors {
                    report.warn(error);
                }
            }
            Payload::ComponentExportSection(reader) if depth == 0 => {
                let mut errors = Vec::new();
                let mut truncated_flag = false;
                if let Some(c) = report.component.as_mut() {
                    for export in reader {
                        match export {
                            Ok(export) => {
                                c.exports_total += 1;
                                if c.exports.len() < max_items {
                                    c.exports.push(ComponentExternal {
                                        name: clip(export.name.name),
                                        kind: external_kind(export.kind),
                                        index: Some(export.index),
                                        type_index: None,
                                        qualifiers: extern_name_qualifiers(
                                            &export.name,
                                        ),
                                    });
                                } else {
                                    truncated_flag = true;
                                }
                            }
                            Err(error) => {
                                if errors.len() < crate::MAX_WARNINGS {
                                    errors.push(clip(&format!("component_export: {error}")));
                                } else {
                                    truncated_flag = true;
                                }
                            }
                        }
                    }
                }
                if truncated_flag {
                    report.truncated = true;
                }
                for error in errors {
                    report.warn(error);
                }
            }
            _ => {}
        }
    }

    serialize_bounded(&report)
}

fn read_name_section(
    reader: wasmparser::NameSectionReader<'_>,
    section: &'static str,
) -> NameSummary {
    let mut summary = NameSummary {
        section,
        ..NameSummary::default()
    };
    for subsection in reader {
        let Ok(subsection) = subsection else {
            break;
        };
        use wasmparser::Name::*;
        let (kind, entries) = match subsection {
            Module { name, .. } => {
                summary.module_name = Some(clip(name));
                ("module", 1)
            }
            Function(map) => ("function", map.count() as u64),
            Local(map) => ("local", map.count() as u64),
            Label(map) => ("label", map.count() as u64),
            Type(map) => ("type", map.count() as u64),
            Table(map) => ("table", map.count() as u64),
            Memory(map) => ("memory", map.count() as u64),
            Global(map) => ("global", map.count() as u64),
            Element(map) => ("element", map.count() as u64),
            Data(map) => ("data", map.count() as u64),
            Field(map) => ("field", map.count() as u64),
            Tag(map) => ("tag", map.count() as u64),
            Unknown { .. } => ("unknown", 1),
        };
        summary.named_total += entries;
        summary.subsections.push(NameSubsection { kind, entries });
        if summary.subsections.len() >= crate::MAX_LIST {
            break;
        }
    }
    summary
}

fn read_component_name_section(
    reader: wasmparser::ComponentNameSectionReader<'_>,
) -> NameSummary {
    let mut summary = NameSummary {
        section: "component-name",
        ..NameSummary::default()
    };
    for subsection in reader {
        let Ok(subsection) = subsection else {
            break;
        };
        use wasmparser::ComponentName::*;
        let (kind, entries) = match subsection {
            Component { name, .. } => {
                summary.module_name = Some(clip(name));
                ("component", 1)
            }
            CoreFuncs(map) => ("core-func", map.count() as u64),
            CoreGlobals(map) => ("core-global", map.count() as u64),
            CoreMemories(map) => ("core-memory", map.count() as u64),
            CoreTables(map) => ("core-table", map.count() as u64),
            CoreTags(map) => ("core-tag", map.count() as u64),
            CoreModules(map) => ("core-module", map.count() as u64),
            CoreInstances(map) => ("core-instance", map.count() as u64),
            CoreTypes(map) => ("core-type", map.count() as u64),
            Types(map) => ("type", map.count() as u64),
            Instances(map) => ("instance", map.count() as u64),
            Components(map) => ("component", map.count() as u64),
            Funcs(map) => ("func", map.count() as u64),
            Values(map) => ("value", map.count() as u64),
            Unknown { .. } => ("unknown", 1),
        };
        summary.named_total += entries;
        summary.subsections.push(NameSubsection { kind, entries });
        if summary.subsections.len() >= crate::MAX_LIST {
            break;
        }
    }
    summary
}

fn type_ref_kind(ty: &ComponentTypeRef) -> &'static str {
    match ty {
        ComponentTypeRef::Module(_) => "module",
        ComponentTypeRef::Func(_) => "func",
        ComponentTypeRef::Value(_) => "value",
        ComponentTypeRef::Type(_) => "type",
        ComponentTypeRef::Instance(_) => "instance",
        ComponentTypeRef::Component(_) => "component",
    }
}

fn type_ref_index(ty: &ComponentTypeRef) -> Option<u32> {
    match ty {
        ComponentTypeRef::Module(i)
        | ComponentTypeRef::Func(i)
        | ComponentTypeRef::Instance(i)
        | ComponentTypeRef::Component(i) => Some(*i),
        ComponentTypeRef::Type(_) | ComponentTypeRef::Value(_) => None,
    }
}

fn external_kind(kind: ComponentExternalKind) -> &'static str {
    match kind {
        ComponentExternalKind::Module => "module",
        ComponentExternalKind::Func => "func",
        ComponentExternalKind::Value => "value",
        ComponentExternalKind::Type => "type",
        ComponentExternalKind::Instance => "instance",
        ComponentExternalKind::Component => "component",
    }
}

fn extern_name_qualifiers(name: &wasmparser::ComponentExternName<'_>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(implements) = name.implements {
        parts.push(format!("implements={}", clip(implements)));
    }
    if let Some(version) = name.version_suffix {
        parts.push(format!("version={}", clip(version)));
    }
    if let Some(id) = name.external_id {
        parts.push(format!("id={}", clip(id)));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn recognized(name: &str, known: &KnownCustom<'_>) -> bool {
    if !matches!(known, KnownCustom::Unknown) {
        return true;
    }
    matches!(name, "target-features" | "sourceMappingURL" | "dylink.0" | "dylink")
        || name.starts_with("reloc.")
}

fn clip(text: &str) -> String {
    if text.len() <= MAX_NAME_BYTES {
        return text.to_string();
    }
    let mut end = MAX_NAME_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}
