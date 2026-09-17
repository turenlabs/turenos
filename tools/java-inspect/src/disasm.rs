//! `class_disassemble` — javap-style bytecode listing for one `.class`.
//! Constant-pool operands resolve inline as `//` comments; unknown opcodes,
//! truncated operands, and malformed Code attributes surface as explicit
//! `// WARNING` lines plus a `warnings` array — nothing is silently skipped.

use serde::Deserialize;

use crate::classfile::{method_flags, ClassFile};
use crate::opcode::{disassemble_code, render_lines};
use crate::{Fail, OpResult, MAX_DISASM_BYTES, MAX_RESULTS, MAX_WARNINGS};

#[derive(Default, Deserialize)]
pub(crate) struct DisasmOptions {
    #[serde(default, alias = "methodIndex")]
    method_index: Option<usize>,
    #[serde(default, alias = "methodName")]
    method_name: Option<String>,
    #[serde(default, alias = "maxMethods")]
    max_methods: Option<usize>,
}

pub(crate) fn run(bytes: &[u8], options: &DisasmOptions) -> OpResult {
    let max_methods = options
        .max_methods
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let class = ClassFile::parse(bytes)?;
    let mut warnings: Vec<String> = Vec::new();
    if class.utf8_malformed && warnings.len() < MAX_WARNINGS {
        warnings.push("constant pool contains malformed modified UTF-8".into());
    }

    // Method selection: exact index wins, then exact name (all overloads),
    // else every method in file order.
    let selected: Vec<usize> = if let Some(index) = options.method_index {
        if index >= class.methods.len() {
            return Err(Fail::new("method_not_found")
                .with("method_index", index as u64)
                .with("methods_total", class.methods.len() as u64));
        }
        vec![index]
    } else if let Some(name) = &options.method_name {
        let matches: Vec<usize> = class
            .methods
            .iter()
            .enumerate()
            .filter(|(_, m)| class.utf8_lenient(m.name_index).as_deref() == Some(name.as_str()))
            .map(|(i, _)| i)
            .collect();
        if matches.is_empty() {
            return Err(Fail::new("method_not_found").with("method_name", name.clone()));
        }
        matches
    } else {
        (0..class.methods.len()).collect()
    };

    let mut methods_out = Vec::new();
    let mut text_bytes = 0usize;
    let mut truncated = false;
    for (row, index) in selected.iter().enumerate() {
        if row >= max_methods {
            truncated = true;
            if warnings.len() < MAX_WARNINGS {
                warnings.push(format!(
                    "selected methods truncated at {max_methods}"
                ));
            }
            break;
        }
        let method = &class.methods[*index];
        let name = class.member_text(method.name_index);
        let descriptor = class.member_text(method.descriptor_index);
        let mut entry = serde_json::json!({
            "index": index,
            "name": name,
            "descriptor": descriptor,
            "access_flags": format!("0x{:04x}", method.access_flags),
            "access": method_flags(method.access_flags),
        });
        let text = match ClassFile::find_attribute(&method.attributes, "Code") {
            Some(attr) => match class.decode_code(class.attribute_body(bytes, attr)) {
                Ok(code) => {
                    let body = class.attribute_body(bytes, attr);
                    let code_bytes = &body[code.code_offset..code.code_offset + code.code_length];
                    let lines = disassemble_code(code_bytes, &class, &mut warnings, MAX_WARNINGS);
                    entry["max_stack"] = code.max_stack.into();
                    entry["max_locals"] = code.max_locals.into();
                    entry["code_length"] = code.code_length.into();
                    entry["exception_table_length"] = code.exception_table_length.into();
                    render_lines(&lines)
                }
                Err(_) => {
                    if warnings.len() < MAX_WARNINGS {
                        warnings.push(format!(
                            "method {name}{descriptor} has malformed Code attribute"
                        ));
                    }
                    "// WARNING: malformed Code attribute\n".to_string()
                }
            },
            None => "// WARNING: method has no Code attribute (native or abstract)\n".to_string(),
        };
        if text_bytes + text.len() > MAX_DISASM_BYTES {
            let budget = MAX_DISASM_BYTES - text_bytes;
            let mut cut = crate::clean(&text, budget);
            cut.push_str("// WARNING: disassembly text truncated at 2 MiB limit\n");
            entry["text"] = cut.into();
            entry["text_truncated"] = true.into();
            truncated = true;
            text_bytes = MAX_DISASM_BYTES;
            methods_out.push(entry);
            break;
        }
        text_bytes += text.len();
        entry["text"] = text.into();
        methods_out.push(entry);
    }

    let this_class = class
        .class_name_lenient(class.this_class)
        .unwrap_or_else(|| format!("<bad ref #{}>", class.this_class));
    Ok(serde_json::json!({
        "schema_version": 1,
        "format": "class",
        "this_class": this_class,
        "major_version": class.major,
        "minor_version": class.minor,
        "jdk": crate::classfile::jdk_name(class.major),
        "methods_total": class.methods.len(),
        "methods_selected": methods_out.len(),
        "methods": methods_out,
        "text_bytes": text_bytes,
        "warnings": warnings,
        "truncated": truncated,
    }))
}
