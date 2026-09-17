//! Hand-rolled, bounds-checked JVMS class-file parser. Deliberately not the
//! `cafebabe`/`noak` crates: a focused parser keeps every read bounds-checked
//! against the real input, resolves constant-pool references leniently
//! (unresolvable refs degrade to `<bad ref #N>` strings plus a warning rather
//! than failing the whole parse), and keeps the dependency closure minimal.

use crate::{Fail, MAX_ANNOTATION_ELEMENTS, MAX_STRING_CHARS};

/// Big-endian bounds-checked cursor over the class bytes.
pub(crate) struct Reader<'a> {
    pub bytes: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    pub fn u1(&mut self) -> Result<u8, Fail> {
        if self.remaining() < 1 {
            return Err(Fail::new("truncated_class").with("offset", self.pos));
        }
        let value = self.bytes[self.pos];
        self.pos += 1;
        Ok(value)
    }

    pub fn u2(&mut self) -> Result<u16, Fail> {
        let bytes = self.take(2)?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    pub fn u4(&mut self) -> Result<u32, Fail> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn take(&mut self, count: usize) -> Result<&'a [u8], Fail> {
        if self.remaining() < count {
            return Err(Fail::new("truncated_class").with("offset", self.pos));
        }
        let slice = &self.bytes[self.pos..self.pos + count];
        self.pos += count;
        Ok(slice)
    }
}

/// One constant-pool entry. Slot 0 and the second slot of a long/double are
/// `None` so `cp[i]` stays index-aligned with the file's 1-based numbering.
#[derive(Debug)]
pub(crate) enum Cp {
    Utf8(String),
    Integer(i32),
    Float(f32),
    Long(i64),
    Double(f64),
    Class { name_index: u16 },
    String { string_index: u16 },
    Fieldref { class_index: u16, nat_index: u16 },
    Methodref { class_index: u16, nat_index: u16 },
    InterfaceMethodref { class_index: u16, nat_index: u16 },
    NameAndType { name_index: u16, descriptor_index: u16 },
    MethodHandle { kind: u8, index: u16 },
    MethodType { descriptor_index: u16 },
    Dynamic { bsm_index: u16, nat_index: u16 },
    InvokeDynamic { bsm_index: u16, nat_index: u16 },
    Module { name_index: u16 },
    Package { name_index: u16 },
}

impl Cp {
    pub fn tag_name(&self) -> &'static str {
        match self {
            Cp::Utf8(_) => "utf8",
            Cp::Integer(_) => "integer",
            Cp::Float(_) => "float",
            Cp::Long(_) => "long",
            Cp::Double(_) => "double",
            Cp::Class { .. } => "class",
            Cp::String { .. } => "string",
            Cp::Fieldref { .. } => "fieldref",
            Cp::Methodref { .. } => "methodref",
            Cp::InterfaceMethodref { .. } => "interface_methodref",
            Cp::NameAndType { .. } => "name_and_type",
            Cp::MethodHandle { .. } => "method_handle",
            Cp::MethodType { .. } => "method_type",
            Cp::Dynamic { .. } => "dynamic",
            Cp::InvokeDynamic { .. } => "invoke_dynamic",
            Cp::Module { .. } => "module",
            Cp::Package { .. } => "package",
        }
    }
}

/// A raw attribute: resolved name plus a bounded slice into the class bytes.
pub(crate) struct Attribute {
    pub name: String,
    pub offset: usize,
    pub length: usize,
}

/// field_info / method_info share the same shape.
pub(crate) struct Member {
    pub access_flags: u16,
    pub name_index: u16,
    pub descriptor_index: u16,
    pub attributes: Vec<Attribute>,
}

/// One parsed annotation (Runtime{Visible,Invisible}Annotations or nested).
pub(crate) struct Annotation {
    pub descriptor: String,
    pub elements: Vec<(String, String)>,
    pub truncated: bool,
}

/// Decoded Code attribute metrics (disassembly reads `code` separately).
pub(crate) struct CodeInfo {
    pub max_stack: u16,
    pub max_locals: u16,
    pub code_offset: usize,
    pub code_length: usize,
    pub exception_table_length: u16,
    pub sub_attributes: Vec<Attribute>,
}

/// One decoded bootstrap-method record.
pub(crate) struct BootstrapMethod {
    pub method_ref: u16,
    pub arguments: Vec<u16>,
}

pub(crate) struct ClassFile {
    pub minor: u16,
    pub major: u16,
    /// Index-aligned constant pool; `None` at slot 0 and wide-entry tails.
    pub cp: Vec<Option<Cp>>,
    pub access_flags: u16,
    pub this_class: u16,
    pub super_class: u16,
    pub interfaces: Vec<u16>,
    pub fields: Vec<Member>,
    pub methods: Vec<Member>,
    pub attributes: Vec<Attribute>,
    /// Set when any CONSTANT_Utf8 carried malformed (modified) UTF-8.
    pub utf8_malformed: bool,
}

impl ClassFile {
    /// Parse a complete ClassFile structure. Structural truncation and bad
    /// magic fail closed; constant-pool *resolution* stays lenient.
    pub fn parse(bytes: &[u8]) -> Result<ClassFile, Fail> {
        let mut reader = Reader::new(bytes);
        if reader.u4()? != 0xCAFE_BABE {
            return Err(Fail::new("bad_magic"));
        }
        let minor = reader.u2()?;
        let major = reader.u2()?;
        let cp = Self::read_constant_pool(&mut reader)?;
        let utf8_malformed = cp
            .iter()
            .flatten()
            .any(|entry| matches!(entry, Cp::Utf8(text) if text.contains('\u{FFFD}')));
        let mut class = ClassFile {
            minor,
            major,
            cp,
            access_flags: reader.u2()?,
            this_class: reader.u2()?,
            super_class: reader.u2()?,
            interfaces: Vec::new(),
            fields: Vec::new(),
            methods: Vec::new(),
            attributes: Vec::new(),
            utf8_malformed,
        };
        let interface_count = reader.u2()?;
        for _ in 0..interface_count {
            class.interfaces.push(reader.u2()?);
        }
        class.fields = Self::read_members(&mut reader, &class)?;
        class.methods = Self::read_members(&mut reader, &class)?;
        class.attributes = Self::read_attributes(&mut reader, &class)?;
        Ok(class)
    }

    fn read_constant_pool(reader: &mut Reader) -> Result<Vec<Option<Cp>>, Fail> {
        let count = reader.u2()? as usize;
        // constant_pool_count counts slots including the reserved index 0.
        let mut cp: Vec<Option<Cp>> = Vec::with_capacity(count.min(1 << 20));
        cp.push(None);
        while cp.len() < count {
            let tag = reader.u1()?;
            let entry = match tag {
                1 => {
                    let length = reader.u2()? as usize;
                    Cp::Utf8(decode_mutf8(reader.take(length)?))
                }
                3 => Cp::Integer(reader.u4()? as i32),
                4 => Cp::Float(f32::from_bits(reader.u4()?)),
                5 => {
                    let high = reader.u4()? as u64;
                    let low = reader.u4()? as u64;
                    Cp::Long(((high << 32) | low) as i64)
                }
                6 => {
                    let high = reader.u4()? as u64;
                    let low = reader.u4()? as u64;
                    Cp::Double(f64::from_bits((high << 32) | low))
                }
                7 => Cp::Class {
                    name_index: reader.u2()?,
                },
                8 => Cp::String {
                    string_index: reader.u2()?,
                },
                9 => Cp::Fieldref {
                    class_index: reader.u2()?,
                    nat_index: reader.u2()?,
                },
                10 => Cp::Methodref {
                    class_index: reader.u2()?,
                    nat_index: reader.u2()?,
                },
                11 => Cp::InterfaceMethodref {
                    class_index: reader.u2()?,
                    nat_index: reader.u2()?,
                },
                12 => Cp::NameAndType {
                    name_index: reader.u2()?,
                    descriptor_index: reader.u2()?,
                },
                15 => Cp::MethodHandle {
                    kind: reader.u1()?,
                    index: reader.u2()?,
                },
                16 => Cp::MethodType {
                    descriptor_index: reader.u2()?,
                },
                17 => Cp::Dynamic {
                    bsm_index: reader.u2()?,
                    nat_index: reader.u2()?,
                },
                18 => Cp::InvokeDynamic {
                    bsm_index: reader.u2()?,
                    nat_index: reader.u2()?,
                },
                19 => Cp::Module {
                    name_index: reader.u2()?,
                },
                20 => Cp::Package {
                    name_index: reader.u2()?,
                },
                other => {
                    return Err(Fail::new("bad_constant_pool")
                        .with("tag", other)
                        .with("index", cp.len() as u64))
                }
            };
            let wide = matches!(entry, Cp::Long(_) | Cp::Double(_));
            cp.push(Some(entry));
            if wide && cp.len() < count {
                cp.push(None); // long/double occupy two slots
            }
        }
        Ok(cp)
    }

    fn read_members(reader: &mut Reader, class: &ClassFile) -> Result<Vec<Member>, Fail> {
        let count = reader.u2()? as usize;
        let mut members = Vec::with_capacity(count.min(1 << 16));
        for _ in 0..count {
            members.push(Member {
                access_flags: reader.u2()?,
                name_index: reader.u2()?,
                descriptor_index: reader.u2()?,
                attributes: Self::read_attributes(reader, class)?,
            });
        }
        Ok(members)
    }

    pub(crate) fn read_attributes(
        reader: &mut Reader,
        class: &ClassFile,
    ) -> Result<Vec<Attribute>, Fail> {
        let count = reader.u2()? as usize;
        let mut attributes = Vec::with_capacity(count.min(1 << 16));
        for _ in 0..count {
            let name_index = reader.u2()?;
            let length = reader.u4()? as usize;
            if reader.remaining() < length {
                return Err(Fail::new("truncated_class")
                    .with("offset", reader.pos)
                    .with("attribute_length", length as u64));
            }
            let name = class
                .utf8_lenient(name_index)
                .unwrap_or_else(|| format!("<bad name #{name_index}>"));
            attributes.push(Attribute {
                name,
                offset: reader.pos,
                length,
            });
            reader.take(length)?;
        }
        Ok(attributes)
    }

    /// Constant-pool lookup; returns `None` for out-of-range or empty slots.
    pub fn entry(&self, index: u16) -> Option<&Cp> {
        self.cp.get(index as usize).and_then(|e| e.as_ref())
    }

    /// Lenient Utf8 resolution — `None` when the index is unusable.
    pub fn utf8_lenient(&self, index: u16) -> Option<String> {
        match self.entry(index) {
            Some(Cp::Utf8(text)) => Some(text.clone()),
            _ => None,
        }
    }

    /// Lenient internal class-name resolution via a Class entry.
    pub fn class_name_lenient(&self, index: u16) -> Option<String> {
        match self.entry(index) {
            Some(Cp::Class { name_index }) => self.utf8_lenient(*name_index),
            _ => None,
        }
    }

    /// Lenient NameAndType resolution -> (name, descriptor).
    pub fn nat_lenient(&self, index: u16) -> Option<(String, String)> {
        match self.entry(index) {
            Some(Cp::NameAndType {
                name_index,
                descriptor_index,
            }) => Some((
                self.utf8_lenient(*name_index)
                    .unwrap_or_else(|| format!("<bad ref #{name_index}>")),
                self.utf8_lenient(*descriptor_index)
                    .unwrap_or_else(|| format!("<bad ref #{descriptor_index}>")),
            )),
            _ => None,
        }
    }

    /// Display a member's name/descriptor index leniently.
    pub fn member_text(&self, index: u16) -> String {
        self.utf8_lenient(index)
            .unwrap_or_else(|| format!("<bad ref #{index}>"))
    }

    /// javap-style resolution of a constant-pool index used by a bytecode
    /// operand — e.g. `Method java/lang/Object."<init>":()V`.
    pub fn describe_cp(&self, index: u16) -> String {
        self.describe_cp_at(index, 0)
    }

    /// Depth-bounded inner form: MethodHandle resolution recurses into the
    /// target once, and a malformed chain of handles must not blow the
    /// (small) wasm stack — cap at 4 hops.
    fn describe_cp_at(&self, index: u16, depth: usize) -> String {
        if depth > 4 {
            return "WARNING: method handle chain too deep".to_string();
        }
        match self.entry(index) {
            Some(Cp::Class { .. }) => {
                format!("class {}", self.class_name_lenient(index).unwrap_or_default())
            }
            Some(Cp::String { string_index }) => {
                let text = self
                    .utf8_lenient(*string_index)
                    .unwrap_or_else(|| format!("<bad ref #{string_index}>"));
                format!("String \"{}\"", escape(&text, 96))
            }
            Some(Cp::Fieldref {
                class_index,
                nat_index,
            }) => self.describe_ref("Field", *class_index, *nat_index),
            Some(Cp::Methodref {
                class_index,
                nat_index,
            }) => self.describe_ref("Method", *class_index, *nat_index),
            Some(Cp::InterfaceMethodref {
                class_index,
                nat_index,
            }) => self.describe_ref("InterfaceMethod", *class_index, *nat_index),
            Some(Cp::Integer(value)) => format!("int {value}"),
            Some(Cp::Float(value)) => format!("float {}", render_f32(*value)),
            Some(Cp::Long(value)) => format!("long {value}"),
            Some(Cp::Double(value)) => format!("double {}", render_f64(*value)),
            Some(Cp::MethodType { descriptor_index }) => {
                let desc = self
                    .utf8_lenient(*descriptor_index)
                    .unwrap_or_else(|| format!("<bad ref #{descriptor_index}>"));
                format!("MethodType {desc}")
            }
            Some(Cp::MethodHandle { kind, index }) => {
                let target = self.describe_cp_at(*index, depth + 1);
                format!("MethodHandle {}:#{index} {target}", ref_kind(*kind))
            }
            Some(Cp::InvokeDynamic { bsm_index, nat_index })
            | Some(Cp::Dynamic { bsm_index, nat_index }) => {
                let (name, desc) = self
                    .nat_lenient(*nat_index)
                    .unwrap_or_else(|| ("<bad ref>".into(), String::new()));
                let kind = if matches!(self.entry(index), Some(Cp::InvokeDynamic { .. })) {
                    "InvokeDynamic"
                } else {
                    "Dynamic"
                };
                format!("{kind} #{bsm_index}:{name}:{desc}")
            }
            Some(Cp::Module { name_index }) | Some(Cp::Package { name_index }) => {
                let name = self
                    .utf8_lenient(*name_index)
                    .unwrap_or_else(|| format!("<bad ref #{name_index}>"));
                format!("{} {}", entry_kind(self.entry(index)), name)
            }
            Some(Cp::NameAndType {
                name_index,
                descriptor_index,
            }) => {
                let name = self
                    .utf8_lenient(*name_index)
                    .unwrap_or_else(|| format!("<bad ref #{name_index}>"));
                let desc = self
                    .utf8_lenient(*descriptor_index)
                    .unwrap_or_else(|| format!("<bad ref #{descriptor_index}>"));
                format!("NameAndType {name}:{desc}")
            }
            Some(Cp::Utf8(text)) => format!("Utf8 \"{}\"", escape(text, 96)),
            None => format!("WARNING: bad constant pool index #{index}"),
        }
    }

    fn describe_ref(&self, kind: &str, class_index: u16, nat_index: u16) -> String {
        let owner = self
            .class_name_lenient(class_index)
            .unwrap_or_else(|| format!("<bad ref #{class_index}>"));
        let (name, desc) = self
            .nat_lenient(nat_index)
            .unwrap_or_else(|| ("<bad ref>".into(), String::new()));
        format!("{kind} {owner}.{name}:{desc}")
    }

    /// Decode a Code attribute body; `info` is the attribute payload slice.
    pub fn decode_code(&self, info: &[u8]) -> Result<CodeInfo, Fail> {
        let mut reader = Reader::new(info);
        let max_stack = reader.u2()?;
        let max_locals = reader.u2()?;
        let code_length = reader.u4()? as usize;
        if reader.remaining() < code_length {
            return Err(Fail::new("truncated_class").with("code_length", code_length as u64));
        }
        let code_offset = reader.pos;
        reader.take(code_length)?;
        let exception_table_length = reader.u2()?;
        let exception_bytes = exception_table_length as usize * 8;
        if reader.remaining() < exception_bytes {
            return Err(Fail::new("truncated_class").with("at", "exception_table"));
        }
        reader.take(exception_bytes)?;
        let sub_attributes = Self::read_attributes(&mut reader, self)?;
        Ok(CodeInfo {
            max_stack,
            max_locals,
            code_offset,
            code_length,
            exception_table_length,
            sub_attributes,
        })
    }

    /// Decode a Runtime{Visible,Invisible}Annotations attribute body.
    pub fn decode_annotations(&self, info: &[u8]) -> Result<Vec<Annotation>, Fail> {
        let mut reader = Reader::new(info);
        let count = reader.u2()? as usize;
        let mut budget = MAX_ANNOTATION_ELEMENTS;
        let mut annotations = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            annotations.push(self.read_annotation(&mut reader, &mut budget, 0)?);
        }
        Ok(annotations)
    }

    fn read_annotation(
        &self,
        reader: &mut Reader,
        budget: &mut usize,
        depth: usize,
    ) -> Result<Annotation, Fail> {
        if depth > 8 {
            return Err(Fail::new("annotation_too_deep"));
        }
        let type_index = reader.u2()?;
        let pair_count = reader.u2()? as usize;
        let mut elements = Vec::with_capacity(pair_count.min(64));
        let mut truncated = false;
        for _ in 0..pair_count {
            let name_index = reader.u2()?;
            let name = self.member_text(name_index);
            if *budget == 0 {
                // Consume the value anyway to keep the stream aligned.
                self.skip_element_value(reader, depth)?;
                truncated = true;
                continue;
            }
            *budget -= 1;
            let value = self.read_element_value(reader, depth)?;
            elements.push((name, value));
        }
        Ok(Annotation {
            descriptor: self.member_text(type_index),
            elements,
            truncated,
        })
    }

    fn read_element_value(&self, reader: &mut Reader, depth: usize) -> Result<String, Fail> {
        if depth > 8 {
            return Err(Fail::new("annotation_too_deep"));
        }
        let tag = reader.u1()?;
        let text = match tag {
            b'B' | b'C' | b'D' | b'F' | b'I' | b'J' | b'S' | b'Z' | b's' => {
                let index = reader.u2()?;
                self.describe_cp(index)
            }
            b'e' => {
                let type_name = self.member_text(reader.u2()?);
                let const_name = self.member_text(reader.u2()?);
                format!("{type_name}.{const_name}")
            }
            b'c' => {
                let index = reader.u2()?;
                format!("class {}", self.member_text(index))
            }
            b'@' => {
                let mut nested_budget = 8;
                let nested = self.read_annotation(reader, &mut nested_budget, depth + 1)?;
                let mut text = format!("@{}", nested.descriptor);
                if let Some((name, value)) = nested.elements.first() {
                    text.push_str(&format!("({name}={value})"));
                }
                text
            }
            b'[' => {
                let count = reader.u2()? as usize;
                let mut parts = Vec::with_capacity(count.min(64));
                for _ in 0..count.min(64) {
                    parts.push(self.read_element_value(reader, depth + 1)?);
                }
                for _ in 64..count {
                    self.skip_element_value(reader, depth + 1)?;
                }
                if count > 64 {
                    format!("[{} ... +{} more]", parts.join(", "), count - 64)
                } else {
                    format!("[{}]", parts.join(", "))
                }
            }
            _ => {
                return Err(Fail::new("bad_annotation").with("tag", tag));
            }
        };
        Ok(text)
    }

    /// Consume one element_value without materializing it (budget-exhausted
    /// path keeps the reader aligned so later annotations still parse).
    fn skip_element_value(&self, reader: &mut Reader, depth: usize) -> Result<(), Fail> {
        if depth > 8 {
            return Err(Fail::new("annotation_too_deep"));
        }
        match reader.u1()? {
            b'B' | b'C' | b'D' | b'F' | b'I' | b'J' | b'S' | b'Z' | b's' | b'c' => {
                reader.u2()?;
            }
            b'e' => {
                reader.u2()?;
                reader.u2()?;
            }
            b'@' => {
                reader.u2()?;
                let pairs = reader.u2()?;
                for _ in 0..pairs {
                    reader.u2()?;
                    self.skip_element_value(reader, depth + 1)?;
                }
            }
            b'[' => {
                let count = reader.u2()?;
                for _ in 0..count {
                    self.skip_element_value(reader, depth + 1)?;
                }
            }
            other => return Err(Fail::new("bad_annotation").with("tag", other)),
        }
        Ok(())
    }

    /// Decode the BootstrapMethods attribute body.
    pub fn decode_bootstrap_methods(&self, info: &[u8]) -> Result<Vec<BootstrapMethod>, Fail> {
        let mut reader = Reader::new(info);
        let count = reader.u2()? as usize;
        let mut methods = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            let method_ref = reader.u2()?;
            let arg_count = reader.u2()? as usize;
            let mut arguments = Vec::with_capacity(arg_count.min(256));
            for _ in 0..arg_count {
                arguments.push(reader.u2()?);
            }
            methods.push(BootstrapMethod {
                method_ref,
                arguments,
            });
        }
        Ok(methods)
    }

    /// Decode the InnerClasses attribute body:
    /// (inner, outer, name, flags) rows resolved leniently.
    pub fn decode_inner_classes(
        &self,
        info: &[u8],
    ) -> Result<Vec<(u16, u16, u16, u16)>, Fail> {
        let mut reader = Reader::new(info);
        let count = reader.u2()? as usize;
        let mut rows = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            rows.push((reader.u2()?, reader.u2()?, reader.u2()?, reader.u2()?));
        }
        Ok(rows)
    }

    /// First attribute with `name`, if present.
    pub fn find_attribute<'a>(attributes: &'a [Attribute], name: &str) -> Option<&'a Attribute> {
        attributes.iter().find(|attr| attr.name == name)
    }

    /// Attribute payload slice (offset/length were bounds-checked at parse).
    pub fn attribute_body<'a>(&self, bytes: &'a [u8], attr: &Attribute) -> &'a [u8] {
        &bytes[attr.offset..attr.offset + attr.length]
    }
}

fn entry_kind(entry: Option<&Cp>) -> &'static str {
    entry.map(|e| e.tag_name()).unwrap_or("<empty>")
}

/// MethodHandle reference_kind number -> JVMS name.
pub(crate) fn ref_kind(kind: u8) -> &'static str {
    match kind {
        1 => "REF_getField",
        2 => "REF_getStatic",
        3 => "REF_putField",
        4 => "REF_putStatic",
        5 => "REF_invokeVirtual",
        6 => "REF_invokeStatic",
        7 => "REF_invokeSpecial",
        8 => "REF_newInvokeSpecial",
        9 => "REF_invokeInterface",
        _ => "REF_unknown",
    }
}

/// Escape and cap a string for inline `//` comments (no newlines leaked).
pub(crate) fn escape(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    if text.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

fn render_f32(value: f32) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        format!("{value:?}")
    }
}

fn render_f64(value: f64) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        format!("{value:?}")
    }
}

/// Decode modified UTF-8 (MUTF-8) into a String. Class files encode NUL as
/// 0xC0 0x80 and supplementary characters as UTF-16 surrogate pairs, so the
/// correct model is: decode 1/2/3-byte sequences into u16 code units, then
/// `String::from_utf16_lossy` — lone surrogates degrade to U+FFFD.
fn decode_mutf8(bytes: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte < 0x80 {
            units.push(byte as u16);
            i += 1;
        } else if byte & 0xE0 == 0xC0 {
            if i + 1 < bytes.len() && bytes[i + 1] & 0xC0 == 0x80 {
                units.push((((byte & 0x1F) as u16) << 6) | (bytes[i + 1] & 0x3F) as u16);
                i += 2;
            } else {
                units.push(0xFFFD);
                i += 1;
            }
        } else if byte & 0xF0 == 0xE0 {
            if i + 2 < bytes.len()
                && bytes[i + 1] & 0xC0 == 0x80
                && bytes[i + 2] & 0xC0 == 0x80
            {
                units.push(
                    (((byte & 0x0F) as u16) << 12)
                        | (((bytes[i + 1] & 0x3F) as u16) << 6)
                        | (bytes[i + 2] & 0x3F) as u16,
                );
                i += 3;
            } else {
                units.push(0xFFFD);
                i += 1;
            }
        } else {
            units.push(0xFFFD);
            i += 1;
        }
    }
    let decoded = String::from_utf16_lossy(&units);
    crate::clean(&decoded, MAX_STRING_CHARS)
}

/// JDK release name for a class-file major version.
pub(crate) fn jdk_name(major: u16) -> String {
    let name = match major {
        45 => "JDK 1.1",
        46 => "JDK 1.2",
        47 => "JDK 1.3",
        48 => "JDK 1.4",
        49 => "Java SE 5",
        50 => "Java SE 6",
        51 => "Java SE 7",
        52 => "Java SE 8",
        53 => "Java SE 9",
        54 => "Java SE 10",
        55 => "Java SE 11",
        56 => "Java SE 12",
        57 => "Java SE 13",
        58 => "Java SE 14",
        59 => "Java SE 15",
        60 => "Java SE 16",
        61 => "Java SE 17",
        62 => "Java SE 18",
        63 => "Java SE 19",
        64 => "Java SE 20",
        65 => "Java SE 21",
        66 => "Java SE 22",
        67 => "Java SE 23",
        68 => "Java SE 24",
        69 => "Java SE 25",
        _ => return format!("unknown (major {major})"),
    };
    name.to_string()
}

/// Named access flags for a class (JVMS table 4.1-A).
pub(crate) fn class_flags(flags: u16) -> Vec<&'static str> {
    let mut names = Vec::new();
    if flags & 0x0001 != 0 {
        names.push("public");
    }
    if flags & 0x0010 != 0 {
        names.push("final");
    }
    if flags & 0x0020 != 0 {
        names.push("super");
    }
    if flags & 0x0200 != 0 {
        names.push("interface");
    }
    if flags & 0x0400 != 0 {
        names.push("abstract");
    }
    if flags & 0x1000 != 0 {
        names.push("synthetic");
    }
    if flags & 0x2000 != 0 {
        names.push("annotation");
    }
    if flags & 0x4000 != 0 {
        names.push("enum");
    }
    if flags & 0x8000 != 0 {
        names.push("module");
    }
    names
}

/// Named access flags for a field (JVMS table 4.5-A).
pub(crate) fn field_flags(flags: u16) -> Vec<&'static str> {
    let mut names = Vec::new();
    if flags & 0x0001 != 0 {
        names.push("public");
    }
    if flags & 0x0002 != 0 {
        names.push("private");
    }
    if flags & 0x0004 != 0 {
        names.push("protected");
    }
    if flags & 0x0008 != 0 {
        names.push("static");
    }
    if flags & 0x0010 != 0 {
        names.push("final");
    }
    if flags & 0x0040 != 0 {
        names.push("volatile");
    }
    if flags & 0x0080 != 0 {
        names.push("transient");
    }
    if flags & 0x1000 != 0 {
        names.push("synthetic");
    }
    if flags & 0x4000 != 0 {
        names.push("enum");
    }
    names
}

/// Named access flags for a method (JVMS table 4.6-A).
pub(crate) fn method_flags(flags: u16) -> Vec<&'static str> {
    let mut names = Vec::new();
    if flags & 0x0001 != 0 {
        names.push("public");
    }
    if flags & 0x0002 != 0 {
        names.push("private");
    }
    if flags & 0x0004 != 0 {
        names.push("protected");
    }
    if flags & 0x0008 != 0 {
        names.push("static");
    }
    if flags & 0x0010 != 0 {
        names.push("final");
    }
    if flags & 0x0020 != 0 {
        names.push("synchronized");
    }
    if flags & 0x0040 != 0 {
        names.push("bridge");
    }
    if flags & 0x0080 != 0 {
        names.push("varargs");
    }
    if flags & 0x0100 != 0 {
        names.push("native");
    }
    if flags & 0x0400 != 0 {
        names.push("abstract");
    }
    if flags & 0x0800 != 0 {
        names.push("strict");
    }
    if flags & 0x1000 != 0 {
        names.push("synthetic");
    }
    names
}
