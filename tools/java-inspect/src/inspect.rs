//! `class_inspect` — bounded structural report for one `.class` file plus a
//! findings array (reflection, Unsafe, defineClass, process spawn, native
//! methods, serialization, script engines) resolved from constant-pool
//! methodref/fieldref entries, each tagged with its CP index.

use serde::Deserialize;

use crate::classfile::{
    class_flags, field_flags, jdk_name, method_flags, ref_kind, ClassFile, Cp,
};
use crate::{clean, OpResult, MAX_RESULTS, MAX_STRING_CHARS, MAX_WARNINGS};

#[derive(Default, Deserialize)]
pub(crate) struct InspectOptions {
    #[serde(default, alias = "dumpConstantPool")]
    dump_constant_pool: Option<bool>,
    #[serde(default, alias = "maxEntries")]
    max_entries: Option<usize>,
}

/// One security-relevant finding.
#[derive(serde::Serialize)]
struct Finding {
    kind: &'static str,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cp_index: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    member_index: Option<u16>,
}

pub(crate) fn run(bytes: &[u8], options: &InspectOptions) -> OpResult {
    let max_entries = options
        .max_entries
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let dump_cp = options.dump_constant_pool.unwrap_or(false);
    let class = ClassFile::parse(bytes)?;
    let mut warnings: Vec<String> = Vec::new();
    let mut truncated = false;
    if class.utf8_malformed {
        warnings.push("constant pool contains malformed modified UTF-8".into());
    }

    // Constant-pool tag summary.
    let mut tag_counts: std::collections::BTreeMap<&'static str, u64> =
        std::collections::BTreeMap::new();
    let mut parsed = 0usize;
    for entry in class.cp.iter().flatten() {
        *tag_counts.entry(entry.tag_name()).or_insert(0) += 1;
        parsed += 1;
    }
    let by_tag: serde_json::Map<String, serde_json::Value> = tag_counts
        .into_iter()
        .map(|(tag, count)| (tag.to_string(), count.into()))
        .collect();
    let mut constant_pool = serde_json::json!({
        "count": class.cp.len(),
        "entries": parsed,
        "by_tag": serde_json::Value::Object(by_tag),
    });
    if dump_cp {
        let mut rows = Vec::new();
        for (index, entry) in class.cp.iter().enumerate().take(max_entries + 1) {
            if index == 0 {
                continue;
            }
            rows.push(match entry {
                Some(e) => serde_json::json!({
                    "index": index,
                    "tag": e.tag_name(),
                    "value": clean(&cp_value(&class, index as u16, e), MAX_STRING_CHARS),
                }),
                None => serde_json::json!({ "index": index, "tag": "<wide tail>" }),
            });
        }
        if class.cp.len() - 1 > max_entries {
            truncated = true;
            if warnings.len() < MAX_WARNINGS {
                warnings.push(format!(
                    "constant pool dump truncated at {max_entries} of {} entries",
                    class.cp.len() - 1
                ));
            }
        }
        constant_pool["dump"] = rows.into();
        constant_pool["dump_truncated"] = (class.cp.len() - 1 > max_entries).into();
    }

    let interfaces: Vec<String> = class
        .interfaces
        .iter()
        .take(max_entries)
        .map(|index| {
            class
                .class_name_lenient(*index)
                .unwrap_or_else(|| format!("<bad ref #{index}>"))
        })
        .collect();
    if class.interfaces.len() > max_entries {
        truncated = true;
        warnings.push(format!(
            "interfaces truncated from {} to {max_entries}",
            class.interfaces.len()
        ));
    }

    let mut fields = Vec::new();
    for (index, field) in class.fields.iter().enumerate() {
        if index >= max_entries {
            truncated = true;
            break;
        }
        fields.push(member_json(&class, bytes, field, false, &mut warnings));
    }
    if class.fields.len() > max_entries {
        warnings.push(format!(
            "fields truncated from {} to {max_entries}",
            class.fields.len()
        ));
    }

    let mut methods = Vec::new();
    for (index, method) in class.methods.iter().enumerate() {
        if index >= max_entries {
            truncated = true;
            break;
        }
        methods.push(member_json(&class, bytes, method, true, &mut warnings));
    }
    if class.methods.len() > max_entries {
        warnings.push(format!(
            "methods truncated from {} to {max_entries}",
            class.methods.len()
        ));
    }

    // Class-level attribute summary + selected decodes.
    let mut attributes = Vec::new();
    for attr in class.attributes.iter().take(max_entries) {
        attributes.push(serde_json::json!({
            "name": attr.name,
            "length": attr.length,
        }));
    }
    if class.attributes.len() > max_entries {
        truncated = true;
    }

    let source_file = decode_source_file(&class, bytes, &mut warnings);
    let signature = decode_signature(&class, bytes);
    let inner_classes = decode_inner(&class, bytes, max_entries, &mut warnings, &mut truncated);
    let class_annotations =
        decode_annotation_attrs(&class, bytes, &class.attributes, &mut warnings);
    let (bootstrap_methods, uses_invokedynamic, uses_lambdas, uses_string_concat) =
        decode_bootstrap(&class, bytes, &mut warnings);
    let nest = decode_simple_cp_list(&class, bytes, "NestMembers");
    let permitted = decode_simple_cp_list(&class, bytes, "PermittedSubclasses");
    let record = decode_record(&class, bytes, max_entries, &mut warnings, &mut truncated);

    let findings = collect_findings(&class, max_entries, &mut truncated);

    let kind = if class.access_flags & 0x8000 != 0 {
        "module"
    } else if class.access_flags & 0x2000 != 0 {
        "annotation"
    } else if class.access_flags & 0x0200 != 0 {
        "interface"
    } else if class.access_flags & 0x4000 != 0 {
        "enum"
    } else {
        "class"
    };

    let this_class = class
        .class_name_lenient(class.this_class)
        .unwrap_or_else(|| format!("<bad ref #{}>", class.this_class));
    let super_class = if class.super_class == 0 {
        serde_json::Value::Null
    } else {
        class
            .class_name_lenient(class.super_class)
            .unwrap_or_else(|| format!("<bad ref #{}>", class.super_class))
            .into()
    };

    Ok(serde_json::json!({
        "schema_version": 1,
        "format": "class",
        "input_size": bytes.len(),
        "minor_version": class.minor,
        "major_version": class.major,
        "jdk": jdk_name(class.major),
        "kind": kind,
        "access_flags": format!("0x{:04x}", class.access_flags),
        "access": class_flags(class.access_flags),
        "this_class": this_class,
        "super_class": super_class,
        "interfaces": interfaces,
        "constant_pool": constant_pool,
        "fields": fields,
        "fields_total": class.fields.len(),
        "methods": methods,
        "methods_total": class.methods.len(),
        "attributes": attributes,
        "source_file": source_file,
        "signature": signature,
        "inner_classes": inner_classes,
        "annotations": class_annotations,
        "bootstrap_methods": bootstrap_methods,
        "uses_invokedynamic": uses_invokedynamic,
        "uses_lambdas": uses_lambdas,
        "uses_string_concat": uses_string_concat,
        "nest_members": nest,
        "permitted_subclasses": permitted,
        "record_components": record,
        "findings": findings,
        "warnings": warnings,
        "truncated": truncated,
    }))
}

/// Render one constant-pool entry for the optional dump.
fn cp_value(class: &ClassFile, index: u16, entry: &Cp) -> String {
    match entry {
        Cp::Utf8(text) => format!("\"{}\"", crate::classfile::escape(text, 400)),
        Cp::Integer(v) => v.to_string(),
        Cp::Float(v) => v.to_string(),
        Cp::Long(v) => v.to_string(),
        Cp::Double(v) => v.to_string(),
        _ => class.describe_cp(index),
    }
}

/// Shared field/method row: name, descriptor, access, attribute names, and
/// for methods the decoded Code metrics (max_stack/max_locals/code_length/
/// exception_table_length) plus the checked-exceptions table.
fn member_json(
    class: &ClassFile,
    bytes: &[u8],
    member: &crate::classfile::Member,
    method: bool,
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    let mut object = serde_json::json!({
        "name": class.member_text(member.name_index),
        "descriptor": class.member_text(member.descriptor_index),
        "access_flags": format!("0x{:04x}", member.access_flags),
        "access": if method {
            method_flags(member.access_flags)
        } else {
            field_flags(member.access_flags)
        },
    });
    let attribute_names: Vec<&str> = member.attributes.iter().map(|a| a.name.as_str()).collect();
    object["attributes"] = attribute_names.into();

    let annotations = decode_annotation_attrs(class, bytes, &member.attributes, warnings);
    object["annotations"] = annotations;

    if let Some(attr) = ClassFile::find_attribute(&member.attributes, "ConstantValue") {
        let body = class.attribute_body(bytes, attr);
        let index = crate::classfile::Reader::new(body)
            .u2()
            .unwrap_or(0);
        object["constant_value"] = class.describe_cp(index).into();
    }

    if method {
        match ClassFile::find_attribute(&member.attributes, "Code") {
            Some(attr) => match class.decode_code(class.attribute_body(bytes, attr)) {
                Ok(code) => {
                    object["code"] = serde_json::json!({
                        "max_stack": code.max_stack,
                        "max_locals": code.max_locals,
                        "code_length": code.code_length,
                        "exception_table_length": code.exception_table_length,
                        "attributes": code
                            .sub_attributes
                            .iter()
                            .map(|a| a.name.as_str())
                            .collect::<Vec<_>>(),
                    });
                }
                Err(_) => {
                    object["code"] = serde_json::json!({ "error": "malformed_code_attribute" });
                    if warnings.len() < MAX_WARNINGS {
                        warnings.push(format!(
                            "method {} has malformed Code attribute",
                            class.member_text(member.name_index)
                        ));
                    }
                }
            },
            None => {
                object["code"] = serde_json::Value::Null;
            }
        }
        if let Some(attr) = ClassFile::find_attribute(&member.attributes, "Exceptions") {
            let mut reader = crate::classfile::Reader::new(class.attribute_body(bytes, attr));
            let mut exceptions = Vec::new();
            if let Ok(count) = reader.u2() {
                for _ in 0..count.min(MAX_RESULTS as u16) {
                    match reader.u2() {
                        Ok(index) => exceptions.push(
                            class
                                .class_name_lenient(index)
                                .unwrap_or_else(|| format!("<bad ref #{index}>")),
                        ),
                        Err(_) => break,
                    }
                }
            }
            object["exceptions"] = exceptions.into();
        }
    }
    object
}

fn decode_source_file(
    class: &ClassFile,
    bytes: &[u8],
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    match ClassFile::find_attribute(&class.attributes, "SourceFile") {
        None => serde_json::Value::Null,
        Some(attr) => {
            let body = class.attribute_body(bytes, attr);
            match crate::classfile::Reader::new(body).u2() {
                Ok(index) => class
                    .utf8_lenient(index)
                    .map(Into::into)
                    .unwrap_or_else(|| {
                        if warnings.len() < MAX_WARNINGS {
                            warnings.push(format!("SourceFile references bad utf8 #{index}"));
                        }
                        format!("<bad ref #{index}>").into()
                    }),
                Err(_) => {
                    if warnings.len() < MAX_WARNINGS {
                        warnings.push("SourceFile attribute truncated".to_string());
                    }
                    serde_json::Value::Null
                }
            }
        }
    }
}

fn decode_signature(class: &ClassFile, bytes: &[u8]) -> serde_json::Value {
    match ClassFile::find_attribute(&class.attributes, "Signature") {
        None => serde_json::Value::Null,
        Some(attr) => {
            let body = class.attribute_body(bytes, attr);
            match crate::classfile::Reader::new(body).u2() {
                Ok(index) => class
                    .utf8_lenient(index)
                    .map(Into::into)
                    .unwrap_or(serde_json::Value::Null),
                Err(_) => serde_json::Value::Null,
            }
        }
    }
}

fn decode_inner(
    class: &ClassFile,
    bytes: &[u8],
    max_entries: usize,
    warnings: &mut Vec<String>,
    truncated: &mut bool,
) -> serde_json::Value {
    let Some(attr) = ClassFile::find_attribute(&class.attributes, "InnerClasses") else {
        return Vec::<serde_json::Value>::new().into();
    };
    match class.decode_inner_classes(class.attribute_body(bytes, attr)) {
        Ok(rows) => {
            let mut out = Vec::new();
            for (inner, outer, name, flags) in rows.iter().take(max_entries) {
                out.push(serde_json::json!({
                    "inner_class": if *inner == 0 { serde_json::Value::Null } else {
                        class.class_name_lenient(*inner)
                            .unwrap_or_else(|| format!("<bad ref #{inner}>")).into()
                    },
                    "outer_class": if *outer == 0 { serde_json::Value::Null } else {
                        class.class_name_lenient(*outer)
                            .unwrap_or_else(|| format!("<bad ref #{outer}>")).into()
                    },
                    "inner_name": if *name == 0 { serde_json::Value::Null } else {
                        class.utf8_lenient(*name)
                            .unwrap_or_else(|| format!("<bad ref #{name}>")).into()
                    },
                    "access_flags": format!("0x{flags:04x}"),
                }));
            }
            if rows.len() > max_entries {
                *truncated = true;
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!(
                        "InnerClasses truncated from {} to {max_entries}",
                        rows.len()
                    ));
                }
            }
            out.into()
        }
        Err(_) => {
            if warnings.len() < MAX_WARNINGS {
                warnings.push("InnerClasses attribute malformed".to_string());
            }
            serde_json::json!([{ "error": "malformed_inner_classes" }])
        }
    }
}

/// Summarize Runtime{Visible,Invisible}Annotations attribute lists on one
/// attribute set (class, field, or method).
fn decode_annotation_attrs(
    class: &ClassFile,
    bytes: &[u8],
    attributes: &[crate::classfile::Attribute],
    warnings: &mut Vec<String>,
) -> serde_json::Value {
    let mut out = Vec::new();
    for name in [
        "RuntimeVisibleAnnotations",
        "RuntimeInvisibleAnnotations",
        "RuntimeVisibleParameterAnnotations",
        "RuntimeInvisibleParameterAnnotations",
    ] {
        for attr in attributes.iter().filter(|a| a.name == name) {
            match class.decode_annotations(class.attribute_body(bytes, attr)) {
                Ok(annotations) => {
                    for annotation in annotations {
                        out.push(serde_json::json!({
                            "attribute": name,
                            "descriptor": annotation.descriptor,
                            "elements": annotation
                                .elements
                                .iter()
                                .map(|(k, v)| serde_json::json!({"name": k, "value": v}))
                                .collect::<Vec<_>>(),
                            "truncated": annotation.truncated,
                        }));
                    }
                }
                Err(_) => {
                    if warnings.len() < MAX_WARNINGS {
                        warnings.push(format!("{name} attribute malformed"));
                    }
                    out.push(serde_json::json!({
                        "attribute": name,
                        "error": "malformed_annotations",
                    }));
                }
            }
        }
    }
    out.into()
}

/// BootstrapMethods attribute -> target summary plus lambda/string-concat
/// usage flags.
fn decode_bootstrap(
    class: &ClassFile,
    bytes: &[u8],
    warnings: &mut Vec<String>,
) -> (serde_json::Value, bool, bool, bool) {
    let mut uses_invokedynamic = false;
    let mut uses_lambdas = false;
    let mut uses_string_concat = false;
    for entry in class.cp.iter().flatten() {
        if matches!(entry, Cp::InvokeDynamic { .. }) {
            uses_invokedynamic = true;
        }
    }
    let Some(attr) = ClassFile::find_attribute(&class.attributes, "BootstrapMethods") else {
        return (Vec::<serde_json::Value>::new().into(), uses_invokedynamic, false, false);
    };
    match class.decode_bootstrap_methods(class.attribute_body(bytes, attr)) {
        Ok(methods) => {
            let mut out = Vec::new();
            for (index, method) in methods.iter().enumerate() {
                let target = class.describe_cp(method.method_ref);
                let args: Vec<serde_json::Value> = method
                    .arguments
                    .iter()
                    .take(64)
                    .map(|arg| {
                        serde_json::json!({
                            "cp_index": arg,
                            "value": class.describe_cp(*arg),
                        })
                    })
                    .collect();
                let resolved = resolve_bootstrap_owner(class, method.method_ref);
                if resolved.contains("LambdaMetafactory") {
                    uses_lambdas = true;
                }
                if resolved.contains("StringConcatFactory") {
                    uses_string_concat = true;
                }
                out.push(serde_json::json!({
                    "index": index,
                    "method_ref": method.method_ref,
                    "target": target,
                    "resolved_owner": resolved,
                    "arguments": args,
                    "arguments_truncated": method.arguments.len() > 64,
                }));
            }
            (
                out.into(),
                uses_invokedynamic,
                uses_lambdas,
                uses_string_concat,
            )
        }
        Err(_) => {
            if warnings.len() < MAX_WARNINGS {
                warnings.push("BootstrapMethods attribute malformed".to_string());
            }
            (
                serde_json::json!([{ "error": "malformed_bootstrap_methods" }]),
                uses_invokedynamic,
                uses_lambdas,
                uses_string_concat,
            )
        }
    }
}

/// Follow a MethodHandle to its underlying owner class name, if resolvable.
fn resolve_bootstrap_owner(class: &ClassFile, index: u16) -> String {
    match class.entry(index) {
        Some(Cp::MethodHandle { index: target, .. }) => match class.entry(*target) {
            Some(Cp::Methodref { class_index, .. })
            | Some(Cp::InterfaceMethodref { class_index, .. })
            | Some(Cp::Fieldref { class_index, .. }) => class
                .class_name_lenient(*class_index)
                .unwrap_or_else(|| String::new()),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// Decode a simple `u2 count + u2 cp_index[]` attribute of Class entries
/// (NestMembers, PermittedSubclasses).
fn decode_simple_cp_list(class: &ClassFile, bytes: &[u8], name: &str) -> serde_json::Value {
    let Some(attr) = ClassFile::find_attribute(&class.attributes, name) else {
        return Vec::<serde_json::Value>::new().into();
    };
    let mut reader = crate::classfile::Reader::new(class.attribute_body(bytes, attr));
    let mut out = Vec::new();
    if let Ok(count) = reader.u2() {
        for _ in 0..count.min(MAX_RESULTS as u16) {
            match reader.u2() {
                Ok(index) => out.push(
                    class
                        .class_name_lenient(index)
                        .unwrap_or_else(|| format!("<bad ref #{index}>")),
                ),
                Err(_) => break,
            }
        }
    }
    out.into()
}

/// Record attribute -> component list (name, descriptor, signature flag).
fn decode_record(
    class: &ClassFile,
    bytes: &[u8],
    max_entries: usize,
    warnings: &mut Vec<String>,
    truncated: &mut bool,
) -> serde_json::Value {
    let Some(attr) = ClassFile::find_attribute(&class.attributes, "Record") else {
        return Vec::<serde_json::Value>::new().into();
    };
    let body = class.attribute_body(bytes, attr);
    let mut reader = crate::classfile::Reader::new(body);
    let mut out = Vec::new();
    match reader.u2() {
        Ok(count) => {
            let total = count as usize;
            for _ in 0..count.min(max_entries as u16) {
                let name_index = match reader.u2() {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let descriptor_index = match reader.u2() {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let sub = match ClassFile::read_attributes(&mut reader, class) {
                    Ok(v) => v,
                    Err(_) => break,
                };
                out.push(serde_json::json!({
                    "name": class.member_text(name_index),
                    "descriptor": class.member_text(descriptor_index),
                    "attributes": sub.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
                }));
            }
            if total > max_entries {
                *truncated = true;
                if warnings.len() < MAX_WARNINGS {
                    warnings.push(format!(
                        "Record components truncated from {total} to {max_entries}"
                    ));
                }
            }
        }
        Err(_) => {
            if warnings.len() < MAX_WARNINGS {
                warnings.push("Record attribute malformed".to_string());
            }
        }
    }
    out.into()
}

/// Findings: scan constant-pool methodref/fieldref entries plus declared
/// members for security-relevant references. Each finding carries the CP
/// index it came from.
fn collect_findings(class: &ClassFile, max_entries: usize, truncated: &mut bool) -> serde_json::Value {
    let mut findings: Vec<Finding> = Vec::new();
    let mut push = |finding: Finding| {
        if findings.len() < max_entries {
            findings.push(finding);
        } else {
            *truncated = true;
        }
    };

    for (index, entry) in class.cp.iter().enumerate() {
        let Some(entry) = entry else { continue };
        let index16 = index as u16;
        match entry {
            Cp::Methodref { class_index, nat_index }
            | Cp::InterfaceMethodref { class_index, nat_index }
            | Cp::Fieldref { class_index, nat_index } => {
                let owner = class.class_name_lenient(*class_index).unwrap_or_default();
                let (name, descriptor) = class
                    .nat_lenient(*nat_index)
                    .unwrap_or_else(|| (String::new(), String::new()));
                let label = format!("{owner}.{name}{descriptor}");
                if is_reflection(&owner, &name) {
                    push(Finding {
                        kind: "reflection",
                        detail: label.clone(),
                        cp_index: Some(index16),
                        member_index: None,
                    });
                }
                if is_unsafe(&owner) {
                    push(Finding {
                        kind: "unsafe_usage",
                        detail: label.clone(),
                        cp_index: Some(index16),
                        member_index: None,
                    });
                }
                if is_define_class(&owner, &name) {
                    push(Finding {
                        kind: "class_loader_define",
                        detail: label.clone(),
                        cp_index: Some(index16),
                        member_index: None,
                    });
                }
                if is_process_spawn(&owner, &name) {
                    push(Finding {
                        kind: "process_spawn",
                        detail: label.clone(),
                        cp_index: Some(index16),
                        member_index: None,
                    });
                }
                if is_serialization_call(&owner, &name) {
                    push(Finding {
                        kind: "serialization_call",
                        detail: label.clone(),
                        cp_index: Some(index16),
                        member_index: None,
                    });
                }
                if is_script_engine(&owner) {
                    push(Finding {
                        kind: "script_engine",
                        detail: label,
                        cp_index: Some(index16),
                        member_index: None,
                    });
                }
            }
            Cp::MethodHandle { kind, index: target } => {
                // Bootstrap/handles to interesting sinks still surface via
                // their resolved ref below; MethodHandle alone is not a
                // finding, but defineClass handles deserve a marker.
                if let Some(resolved) = resolve_handle(class, *target) {
                    let (owner, name) = resolved;
                    if is_define_class(&owner, &name) || is_process_spawn(&owner, &name) {
                        push(Finding {
                            kind: "method_handle_sink",
                            detail: format!(
                                "{} {}.{name}",
                                ref_kind(*kind),
                                owner
                            ),
                            cp_index: Some(index16),
                            member_index: None,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    // Declared-member findings.
    for (index, method) in class.methods.iter().enumerate() {
        let name = class.member_text(method.name_index);
        let descriptor = class.member_text(method.descriptor_index);
        if method.access_flags & 0x0100 != 0 {
            push(Finding {
                kind: "native_method",
                detail: format!("{name}{descriptor}"),
                cp_index: None,
                member_index: Some(index as u16),
            });
        }
        if matches!(
            name.as_str(),
            "readObject" | "writeObject" | "readResolve" | "writeReplace" | "readExternal" | "writeExternal"
        ) {
            push(Finding {
                kind: "serialization_method",
                detail: format!("declares {name}{descriptor}"),
                cp_index: None,
                member_index: Some(index as u16),
            });
        }
    }
    for index in &class.interfaces {
        if let Some(name) = class.class_name_lenient(*index) {
            if name == "java/io/Serializable" || name == "java/io/Externalizable" {
                push(Finding {
                    kind: "serializable",
                    detail: format!("implements {name}"),
                    cp_index: Some(*index),
                    member_index: None,
                });
            }
        }
    }
    serde_json::to_value(findings).unwrap_or(serde_json::Value::Null)
}

fn is_reflection(owner: &str, name: &str) -> bool {
    owner.starts_with("java/lang/reflect/")
        || owner == "java/lang/invoke/MethodHandles"
        || owner == "java/lang/invoke/MethodHandle"
        || (owner == "java/lang/Class"
            && matches!(
                name,
                "forName"
                    | "getMethod"
                    | "getDeclaredMethod"
                    | "getMethods"
                    | "getDeclaredMethods"
                    | "getField"
                    | "getDeclaredField"
                    | "getFields"
                    | "getDeclaredFields"
                    | "getConstructor"
                    | "getDeclaredConstructor"
                    | "getConstructors"
                    | "newInstance"
                    | "getClassLoader"
            ))
}

fn is_unsafe(owner: &str) -> bool {
    owner == "sun/misc/Unsafe"
        || owner == "jdk/internal/misc/Unsafe"
        || owner.ends_with("/Unsafe")
}

fn is_define_class(owner: &str, name: &str) -> bool {
    (name == "defineClass" || name == "definePackage")
        && (owner.ends_with("ClassLoader") || owner.contains("ClassLoader"))
}

fn is_process_spawn(owner: &str, name: &str) -> bool {
    (owner == "java/lang/Runtime" && name == "exec")
        || (owner == "java/lang/ProcessBuilder"
            && matches!(name, "<init>" | "start" | "command"))
        || (owner == "java/lang/ProcessBuilder$Redirect")
}

fn is_serialization_call(owner: &str, name: &str) -> bool {
    (owner == "java/io/ObjectInputStream"
        && matches!(
            name,
            "readObject" | "readUnshared" | "defaultReadObject" | "resolveClass"
        ))
        || (owner == "java/io/ObjectOutputStream"
            && matches!(name, "writeObject" | "writeUnshared" | "defaultWriteObject"))
}

fn is_script_engine(owner: &str) -> bool {
    owner.starts_with("javax/script/")
        || owner.starts_with("jdk/nashorn/")
        || owner.starts_with("org/mozilla/javascript/")
        || owner.starts_with("org/graalvm/")
}

/// Resolve a MethodHandle target to (owner, name) when it points at a
/// Field/Method/InterfaceMethod ref.
fn resolve_handle(class: &ClassFile, index: u16) -> Option<(String, String)> {
    match class.entry(index)? {
        Cp::Methodref {
            class_index,
            nat_index,
        }
        | Cp::InterfaceMethodref {
            class_index,
            nat_index,
        }
        | Cp::Fieldref {
            class_index,
            nat_index,
        } => {
            let owner = class.class_name_lenient(*class_index)?;
            let (name, _) = class.nat_lenient(*nat_index)?;
            Some((owner, name))
        }
        _ => None,
    }
}
