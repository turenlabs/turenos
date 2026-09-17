//! Unit tests for the capa-match static-subset matcher.
//!
//! Rules are fabricated as capa YAML documents and driven through the real
//! `ruledoc` -> `ast::compile` -> `eval` pipeline — no duplicated logic, no
//! mocks. Binary fixtures are minimal hand-built PE32/ELF64 images exercising
//! the goblin extraction path.

use serde_json::{json, Value};

use crate::{ast, eval, extract};

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

fn w16(b: &mut [u8], off: usize, v: u16) {
    b[off..off + 2].copy_from_slice(&v.to_le_bytes());
}
fn w32(b: &mut [u8], off: usize, v: u32) {
    b[off..off + 4].copy_from_slice(&v.to_le_bytes());
}
fn w64(b: &mut [u8], off: usize, v: u64) {
    b[off..off + 8].copy_from_slice(&v.to_le_bytes());
}
fn put(b: &mut [u8], off: usize, s: &[u8]) {
    b[off..off + s.len()].copy_from_slice(s);
}

/// Minimal PE32: `.text` (rva 0x1000, raw 0x200..0x800) carries the import and
/// export tables; `.tls` (rva 0x2000, raw 0x800..0xa00) is a plain named
/// section. `imports` are (dll, [symbol..]); `exports` are
/// (name, forwarder-target like "KERNEL32.HeapAlloc" or None).
fn test_pe(imports: &[(&str, &[&str])], exports: &[(&str, Option<&str>)]) -> Vec<u8> {
    const TEXT_RVA: usize = 0x1000;
    const TEXT_RAW: usize = 0x200;
    const TEXT_SIZE: usize = 0x600;
    let rva = |off: usize| (TEXT_RVA + off) as u32;

    let mut text = vec![0u8; TEXT_SIZE];
    let mut cur = 0x100usize;

    let mut import_dir_rva = 0u32;
    let mut import_dir_size = 0u32;
    if !imports.is_empty() {
        let desc_base = cur;
        cur += (imports.len() + 1) * 20;
        import_dir_rva = rva(desc_base);
        let mut dpos = desc_base;
        for (dll, syms) in imports {
            let ilt = cur;
            cur += 4 * (syms.len() + 1);
            let iat = cur;
            cur += 4 * (syms.len() + 1);
            let name = cur;
            cur += dll.len() + 1;
            let mut hints = Vec::new();
            for s in *syms {
                hints.push(cur);
                cur += 2 + s.len() + 1;
            }
            w32(&mut text, dpos, rva(ilt));
            w32(&mut text, dpos + 12, rva(name));
            w32(&mut text, dpos + 16, rva(iat));
            dpos += 20;
            for (i, (s, h)) in syms.iter().zip(hints.iter()).enumerate() {
                w32(&mut text, ilt + i * 4, rva(*h));
                w32(&mut text, iat + i * 4, rva(*h));
                put(&mut text, *h + 2, s.as_bytes()); // u16 hint stays 0
            }
            put(&mut text, name, dll.as_bytes());
        }
        import_dir_size = (cur - desc_base) as u32;
    }

    let mut export_dir_rva = 0u32;
    let mut export_dir_size = 0u32;
    if !exports.is_empty() {
        cur = (cur + 15) & !15;
        let edt = cur;
        cur += 40;
        let addr_tab = cur;
        cur += 4 * exports.len();
        let name_ptr = cur;
        cur += 4 * exports.len();
        let ords = cur;
        cur += 2 * exports.len();
        let lib_name = cur;
        cur += "test.dll".len() + 1;
        let mut name_offs = Vec::new();
        let mut fwd_offs = Vec::new();
        for (name, fwd) in exports {
            name_offs.push(cur);
            cur += name.len() + 1;
            fwd_offs.push(match fwd {
                Some(target) => {
                    let o = cur;
                    cur += target.len() + 1;
                    o
                }
                None => 0,
            });
        }
        export_dir_rva = rva(edt);
        export_dir_size = (cur - edt) as u32;
        w32(&mut text, edt + 12, rva(lib_name));
        w32(&mut text, edt + 16, 1); // ordinal base
        w32(&mut text, edt + 20, exports.len() as u32); // address table entries
        w32(&mut text, edt + 24, exports.len() as u32); // name pointers
        w32(&mut text, edt + 28, rva(addr_tab));
        w32(&mut text, edt + 32, rva(name_ptr));
        w32(&mut text, edt + 36, rva(ords));
        for (i, ((name, fwd), (&noff, &foff))) in exports
            .iter()
            .zip(name_offs.iter().zip(fwd_offs.iter()))
            .enumerate()
        {
            // A forwarder RVA must point inside the export directory range.
            let fn_rva = if fwd.is_some() { rva(foff) } else { 0x2000 + (i as u32) * 4 };
            w32(&mut text, addr_tab + i * 4, fn_rva);
            w32(&mut text, name_ptr + i * 4, rva(noff));
            w16(&mut text, ords + i * 2, i as u16);
            put(&mut text, noff, name.as_bytes());
            if let Some(target) = fwd {
                put(&mut text, foff, target.as_bytes());
            }
        }
        put(&mut text, lib_name, b"test.dll");
    }

    let opt_size = 0xe0usize;
    let mut file = vec![0u8; 0xa00];
    put(&mut file, 0, b"MZ");
    w32(&mut file, 0x3c, 0x80); // e_lfanew
    put(&mut file, 0x80, b"PE\0\0");
    let coff = 0x84;
    w16(&mut file, coff, 0x14c); // machine i386
    w16(&mut file, coff + 2, 2); // two sections
    w16(&mut file, coff + 16, opt_size as u16);
    w16(&mut file, coff + 18, 0x2102); // EXECUTABLE_IMAGE | 32BIT | DLL
    let opt = coff + 20;
    w16(&mut file, opt, 0x10b); // PE32
    w32(&mut file, opt + 0x10, 0x2000); // entry point
    w32(&mut file, opt + 0x1c, 0x400000); // image base
    w32(&mut file, opt + 0x20, 0x1000); // section alignment
    w32(&mut file, opt + 0x24, 0x200); // file alignment
    w32(&mut file, opt + 0x38, 0x3000); // size of image
    w32(&mut file, opt + 0x3c, 0x200); // size of headers
    w16(&mut file, opt + 0x44, 3); // subsystem console
    w32(&mut file, opt + 0x5c, 16); // number_of_rva_and_sizes
    w32(&mut file, opt + 0x60, export_dir_rva);
    w32(&mut file, opt + 0x64, export_dir_size);
    w32(&mut file, opt + 0x68, import_dir_rva);
    w32(&mut file, opt + 0x6c, import_dir_size);
    let sh = opt + opt_size;
    put(&mut file, sh, b".text\0\0\0");
    w32(&mut file, sh + 8, TEXT_SIZE as u32); // virtual size
    w32(&mut file, sh + 12, TEXT_RVA as u32); // virtual address
    w32(&mut file, sh + 16, TEXT_SIZE as u32); // size of raw data
    w32(&mut file, sh + 20, TEXT_RAW as u32); // pointer to raw data
    w32(&mut file, sh + 36, 0x6000_0020);
    put(&mut file, sh + 40, b".tls\0\0\0\0");
    w32(&mut file, sh + 48, 0x40);
    w32(&mut file, sh + 52, 0x2000);
    w32(&mut file, sh + 56, 0x200);
    w32(&mut file, sh + 60, 0x800);
    w32(&mut file, sh + 76, 0x4000_0040);
    file[TEXT_RAW..TEXT_RAW + TEXT_SIZE].copy_from_slice(&text);
    file
}

/// Minimal ELF64 shared object: amd64, SysV ABI (capa -> "linux"), a PT_LOAD
/// mapping vaddr == file offset, a PT_DYNAMIC with DT_NEEDED "libc.so.6" plus
/// symtab/strtab/rela pointers, four dynsyms (two UNDEF imports, one exported
/// global), and one RELA entry referencing sym index 3 so goblin knows the
/// table length.
fn test_elf() -> Vec<u8> {
    let mut file = vec![0u8; 0x4c0];
    put(&mut file, 0, b"\x7fELF");
    file[4] = 2; // 64-bit
    file[5] = 1; // little-endian
    file[6] = 1; // version
    file[7] = 0; // System V ABI
    w16(&mut file, 0x10, 3); // ET_DYN
    w16(&mut file, 0x12, 62); // x86-64
    w32(&mut file, 0x14, 1);
    w64(&mut file, 0x20, 0x40); // e_phoff
    w64(&mut file, 0x28, 0x300); // e_shoff
    w16(&mut file, 0x34, 64); // e_ehsize
    w16(&mut file, 0x36, 56); // e_phentsize
    w16(&mut file, 0x38, 2); // e_phnum
    w16(&mut file, 0x3a, 64); // e_shentsize
    w16(&mut file, 0x3c, 6); // e_shnum
    w16(&mut file, 0x3e, 5); // e_shstrndx

    // PT_LOAD covering the whole file, vaddr == offset.
    w32(&mut file, 0x40, 1); // PT_LOAD
    w32(&mut file, 0x44, 5); // RX
    w64(&mut file, 0x48, 0); // p_offset
    w64(&mut file, 0x50, 0); // p_vaddr
    w64(&mut file, 0x58, 0);
    w64(&mut file, 0x60, 0x4c0); // p_filesz
    w64(&mut file, 0x68, 0x4c0); // p_memsz
    w64(&mut file, 0x70, 0x1000);
    // PT_DYNAMIC -> .dynamic at 0x180
    w32(&mut file, 0x78, 2);
    w32(&mut file, 0x7c, 6); // RW
    w64(&mut file, 0x80, 0x180);
    w64(&mut file, 0x88, 0x180);
    w64(&mut file, 0x90, 0);
    w64(&mut file, 0x98, 0x80);
    w64(&mut file, 0xa0, 0x80);
    w64(&mut file, 0xa8, 8);

    put(&mut file, 0xb0, &[0x55, 0x48, 0x89, 0xe5, 0xe8, 0, 0, 0, 0, 0x5d, 0xc3, 0, 0, 0, 0, 0]);

    // .dynamic @0x180, eight {tag, val} entries of 16 bytes.
    let dynents: [(u64, u64); 8] = [
        (1, 1),      // DT_NEEDED -> "libc.so.6"
        (5, 0x200),  // DT_STRTAB
        (10, 0x40),  // DT_STRSZ
        (6, 0x220),  // DT_SYMTAB
        (11, 24),    // DT_SYMENT
        (7, 0x280),  // DT_RELA
        (8, 24),     // DT_RELASZ
        (0, 0),      // DT_NULL
    ];
    for (i, (tag, val)) in dynents.iter().enumerate() {
        w64(&mut file, 0x180 + i * 16, *tag);
        w64(&mut file, 0x188 + i * 16, *val);
    }

    // .dynstr @0x200: index 1 "libc.so.6", 11 "recv", 16 "send", 21 "libmy_export"
    put(&mut file, 0x200, b"\0libc.so.6\0recv\0send\0libmy_export\0");

    // .dynsym @0x220, 4 x 24 bytes: st_name(4) st_info(1) st_other(1)
    // st_shndx(2) st_value(8) st_size(8)
    w32(&mut file, 0x220 + 24, 11); // recv, UNDEF -> import
    file[0x220 + 24 + 4] = 0x12; // STB_GLOBAL | STT_FUNC
    w32(&mut file, 0x220 + 48, 16); // send, UNDEF -> import
    file[0x220 + 48 + 4] = 0x12;
    w32(&mut file, 0x220 + 72, 21); // libmy_export, defined in .text
    file[0x220 + 72 + 4] = 0x12;
    w16(&mut file, 0x220 + 72 + 6, 1); // st_shndx = .text
    w64(&mut file, 0x220 + 72 + 8, 0x1000);
    w64(&mut file, 0x220 + 72 + 16, 8);

    // .rela.dyn @0x280: one entry, r_sym = 3 so goblin sizes dynsyms to 4.
    w64(&mut file, 0x288, (3 << 32) | 7); // r_info: sym 3, R_X86_64_JUMP_SLOT

    // .shstrtab @0x480: .text=1 .dynsym=7 .dynstr=15 .dynamic=23 .rela.dyn=32 .shstrtab=42
    put(&mut file, 0x480, b"\0.text\0.dynsym\0.dynstr\0.dynamic\0.rela.dyn\0.shstrtab\0");

    #[allow(clippy::too_many_arguments)]
    fn shdr(
        file: &mut [u8],
        i: usize,
        name: u32,
        ty: u32,
        flags: u64,
        addr: u64,
        off: u64,
        size: u64,
        link: u32,
        info: u32,
        align: u64,
        entsize: u64,
    ) {
        let b = 0x300 + i * 64;
        w32(file, b, name);
        w32(file, b + 4, ty);
        w64(file, b + 8, flags);
        w64(file, b + 16, addr);
        w64(file, b + 24, off);
        w64(file, b + 32, size);
        w32(file, b + 40, link);
        w32(file, b + 44, info);
        w64(file, b + 48, align);
        w64(file, b + 56, entsize);
    }
    shdr(&mut file, 1, 1, 1, 6, 0x1000, 0x0b0, 0x10, 0, 0, 16, 0); // .text PROGBITS
    shdr(&mut file, 2, 7, 11, 0, 0x220, 0x220, 0x60, 3, 1, 8, 24); // .dynsym -> .dynstr
    shdr(&mut file, 3, 15, 3, 0, 0x200, 0x200, 0x40, 0, 0, 1, 0); // .dynstr
    shdr(&mut file, 4, 23, 6, 0, 0x180, 0x180, 0x80, 3, 0, 8, 16); // .dynamic
    shdr(&mut file, 5, 42, 3, 0, 0x480, 0x480, 0x40, 0, 0, 1, 0); // .shstrtab
    file
}

/// NUL-separated strings so every entry is one distinct extracted string.
fn blob_with(strings: &[&str]) -> Vec<u8> {
    let mut out = vec![0u8];
    for s in strings {
        out.extend_from_slice(s.as_bytes());
        out.push(0);
    }
    out
}

/// Buffer carrying `marker` as one long ASCII run (substring territory).
fn blob_containing(marker: &str) -> Vec<u8> {
    let mut out = b"junk-prefix ".to_vec();
    out.extend_from_slice(marker.as_bytes());
    out.extend_from_slice(b" junk-suffix\0");
    out
}

// ---------------------------------------------------------------------------
// rule fabrication through the real ruledoc -> ast::compile pipeline
// ---------------------------------------------------------------------------

fn meta(namespace: &str, static_scope: &str) -> String {
    let ns = if namespace.is_empty() {
        String::new()
    } else {
        format!("    namespace: {namespace}\n")
    };
    format!("{ns}    scopes:\n      static: {static_scope}\n      dynamic: unsupported\n")
}

fn doc(name: &str, meta_lines: &str, features: &str) -> String {
    format!("rule:\n  meta:\n    name: {name}\n{meta_lines}  features:\n{features}")
}

fn compile_rules(docs: &[String]) -> ast::Ruleset {
    let mut rules = Vec::new();
    let mut errors = Vec::new();
    for (i, document) in docs.iter().enumerate() {
        match crate::ruledoc::rule_to_json(&format!("test{i}.yml"), document) {
            Ok(rule) => rules.push(rule),
            Err(error) => errors.push(json!({"file": format!("test{i}.yml"), "error": error})),
        }
    }
    ast::compile(&json!({
        "v": 1,
        "commit": "test-commit",
        "imported": true,
        "rules": rules,
        "errors": errors,
    }))
}

fn rule<'a>(set: &'a ast::Ruleset, name: &str) -> &'a ast::Rule {
    set.rules.iter().find(|rule| rule.name == name).expect("rule exists")
}

fn matched_names(set: &ast::Ruleset, input: &[u8]) -> Vec<String> {
    let features = extract::FeatureSet::extract(input);
    let mut evaluator = eval::Evaluator::new(set, &features, input);
    let mut out = Vec::new();
    for (index, rule) in set.rules.iter().enumerate() {
        if rule.skip_reason.is_none() && evaluator.eval_rule(index).0 {
            out.push(rule.name.clone());
        }
    }
    out
}

fn report(set: &ast::Ruleset, input: &[u8], options: &str) -> Value {
    let options = crate::parse_options(options).expect("options parse");
    let output = crate::match_report(input, &options, set).expect("match_report ok");
    serde_json::from_str(&output).expect("report is JSON")
}

const FILE: &str = "file";

// ---------------------------------------------------------------------------
// statement semantics
// ---------------------------------------------------------------------------

#[test]
fn and_requires_all_children() {
    let set = compile_rules(&[doc(
        "and rule",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - string: \"beta\"\n",
    )]);
    assert!(matched_names(&set, &blob_with(&["alpha"])).is_empty());
    assert_eq!(matched_names(&set, &blob_with(&["alpha", "beta"])), ["and rule"]);
}

#[test]
fn or_matches_any_child() {
    let set = compile_rules(&[doc(
        "or rule",
        &meta("t", FILE),
        "    - or:\n        - string: \"alpha\"\n        - string: \"beta\"\n",
    )]);
    assert_eq!(matched_names(&set, &blob_with(&["beta"])), ["or rule"]);
    assert!(matched_names(&set, &blob_with(&["gamma"])).is_empty());
}

#[test]
fn not_negates_conjunction() {
    // not(a, b) == !(a && b): one child present still satisfies the negation.
    let set = compile_rules(&[doc(
        "not rule",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - not:\n            - string: \"beta\"\n            - string: \"gamma\"\n",
    )]);
    assert_eq!(matched_names(&set, &blob_with(&["alpha", "beta"])), ["not rule"]);
    assert!(matched_names(&set, &blob_with(&["alpha", "beta", "gamma"])).is_empty());
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["not rule"]);
}

#[test]
fn optional_never_blocks() {
    let set = compile_rules(&[doc(
        "opt rule",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - optional:\n            - string: \"beta\"\n",
    )]);
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["opt rule"]);
    assert_eq!(matched_names(&set, &blob_with(&["alpha", "beta"])), ["opt rule"]);
}

#[test]
fn n_or_more_threshold() {
    let set = compile_rules(&[doc(
        "some rule",
        &meta("t", FILE),
        "    - 2 or more:\n        - string: \"aaa1\"\n        - string: \"bbb1\"\n        - string: \"ccc1\"\n",
    )]);
    assert!(matched_names(&set, &blob_with(&["aaa1"])).is_empty());
    assert_eq!(matched_names(&set, &blob_with(&["aaa1", "ccc1"])), ["some rule"]);
}

#[test]
fn string_is_whole_value_equality() {
    let set = compile_rules(&[doc(
        "exact",
        &meta("t", FILE),
        "    - string: \"alpha\"\n",
    )]);
    // `string:` is exact equality against an extracted string, not a search.
    assert!(matched_names(&set, &blob_containing("alpha beta gamma")).is_empty());
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["exact"]);
}

#[test]
fn substring_is_containment() {
    let set = compile_rules(&[doc(
        "sub",
        &meta("t", FILE),
        "    - substring: \"alpha\"\n",
    )]);
    assert_eq!(matched_names(&set, &blob_containing("alphabet soup")), ["sub"]);
    assert!(matched_names(&set, &blob_containing("beta soup")).is_empty());
}

#[test]
fn regex_anchors_and_case_flag() {
    let set = compile_rules(&[
        doc("re-start", &meta("t", FILE), "    - string: /^abc/i\n"),
        doc("re-any", &meta("t", FILE), "    - string: /abc/\n"),
    ]);
    // ^abc/i anchors at the start of an extracted string; /abc/ floats.
    assert_eq!(matched_names(&set, &blob_with(&["abc0 tail"])), ["re-start", "re-any"]);
    assert_eq!(matched_names(&set, &blob_with(&["zzabc tail"])), ["re-any"]);
    assert!(matched_names(&set, &blob_with(&["nothing here"])).is_empty());
}

#[test]
fn bytes_exact_reports_location() {
    let set = compile_rules(&[doc(
        "hex",
        &meta("t", FILE),
        "    - bytes: \"4D 5A 90 00\"\n",
    )]);
    let input = blob_with(&["nothing"]);
    let mut mz = vec![0u8; 16];
    put(&mut mz, 0, &[0x4d, 0x5a, 0x90, 0x00]);
    mz.extend_from_slice(&input);
    assert_eq!(matched_names(&set, &mz), ["hex"]);
    let out = report(&set, &mz, "{}");
    let evidence = &out["capabilities"][0]["evidence"][0];
    assert_eq!(evidence["locations"][0], 0);
    assert_eq!(evidence["count"], 1);
    assert!(matched_names(&set, &input).is_empty());
}

#[test]
fn bytes_whole_byte_wildcard() {
    let set = compile_rules(&[doc(
        "wild",
        &meta("t", FILE),
        "    - bytes: \"4D ?? 5A\"\n",
    )]);
    let mut input = vec![0x41u8; 8];
    input.extend_from_slice(&[0x4d, 0x77, 0x5a]);
    assert_eq!(matched_names(&set, &input), ["wild"]);
    let mut miss = vec![0x41u8; 8];
    miss.extend_from_slice(&[0x5a, 0x4d]);
    assert!(matched_names(&set, &miss).is_empty());
}

#[test]
fn bytes_invalid_pattern_is_unsupported() {
    let set = compile_rules(&[doc(
        "bad bytes",
        &meta("t", FILE),
        "    - or:\n        - string: \"okay\"\n        - bytes: \"GG HH\"\n",
    )]);
    let rule = rule(&set, "bad bytes");
    assert!(rule.degraded);
    assert_eq!(rule.unsupported, ["bytes"]);
    assert_eq!(matched_names(&set, &blob_with(&["okay"])), ["bad bytes"]);
}

#[test]
fn count_string_or_more() {
    let set = compile_rules(&[doc(
        "counter",
        &meta("t", FILE),
        "    - count(string(rep0)): 2 or more\n",
    )]);
    assert!(matched_names(&set, &blob_with(&["rep0"])).is_empty());
    assert_eq!(matched_names(&set, &blob_with(&["rep0", "rep0"])), ["counter"]);
    assert_eq!(matched_names(&set, &blob_with(&["rep0", "rep0", "rep0"])), ["counter"]);
}

#[test]
fn count_string_range_respects_max() {
    let set = compile_rules(&[doc(
        "ranged",
        &meta("t", FILE),
        "    - count(string(rep0)): (2, 3)\n",
    )]);
    assert!(matched_names(&set, &blob_with(&["rep0"])).is_empty());
    assert_eq!(matched_names(&set, &blob_with(&["rep0", "rep0"])), ["ranged"]);
    assert!(matched_names(&set, &blob_with(&["rep0", "rep0", "rep0", "rep0"])).is_empty());
}

#[test]
fn count_or_fewer() {
    let set = compile_rules(&[doc(
        "fewer",
        &meta("t", FILE),
        "    - count(string(rep0)): 1 or fewer\n",
    )]);
    assert_eq!(matched_names(&set, &blob_with(&[])), ["fewer"]);
    assert_eq!(matched_names(&set, &blob_with(&["rep0"])), ["fewer"]);
    assert!(matched_names(&set, &blob_with(&["rep0", "rep0"])).is_empty());
}

#[test]
fn count_over_match_target() {
    let set = compile_rules(&[
        doc("leaf", &meta("t", FILE), "    - string: \"alpha\"\n"),
        doc("via-count", &meta("t", FILE), "    - count(match(leaf)): 1 or more\n"),
    ]);
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["leaf", "via-count"]);
    assert!(matched_names(&set, &blob_with(&[])).is_empty());
}

// ---------------------------------------------------------------------------
// match: references and cycles
// ---------------------------------------------------------------------------

#[test]
fn match_rule_reference() {
    let set = compile_rules(&[
        doc("base cap", &meta("t", FILE), "    - string: \"alpha\"\n"),
        doc("user", &meta("t", FILE), "    - match: base cap\n"),
    ]);
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["base cap", "user"]);
}

#[test]
fn match_namespace_covers_members() {
    let set = compile_rules(&[
        doc("deep", &meta("outer/inner", FILE), "    - string: \"alpha\"\n"),
        doc("ns user", &meta("t", FILE), "    - match: outer\n"),
        doc("ns deep", &meta("t", FILE), "    - match: outer/inner\n"),
    ]);
    // `match: outer` covers the whole namespace subtree. Evaluation order
    // follows rule order, so "ns user" sorts before "ns deep" here.
    assert_eq!(
        matched_names(&set, &blob_with(&["alpha"])),
        ["deep", "ns user", "ns deep"]
    );
}

#[test]
fn match_unresolved_degrades_and_skips() {
    let set = compile_rules(&[doc(
        "dangling",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - match: no such rule\n",
    )]);
    let rule = rule(&set, "dangling");
    assert_eq!(rule.skip_reason.as_deref(), Some("requires-unsupported-features"));
    assert!(rule.unsupported.iter().any(|k| k == "unresolved-match:no such rule"));
    assert!(matched_names(&set, &blob_with(&["alpha"])).is_empty());
}

#[test]
fn match_cycle_is_reported_not_fatal() {
    let set = compile_rules(&[
        doc(
            "cycle a",
            &meta("t", FILE),
            "    - and:\n        - string: \"a\"\n        - match: cycle b\n",
        ),
        doc(
            "cycle b",
            &meta("t", FILE),
            "    - and:\n        - string: \"b\"\n        - match: cycle a\n",
        ),
    ]);
    let features = extract::FeatureSet::extract(&blob_with(&["a", "b"]));
    let mut evaluator = eval::Evaluator::new(&set, &features, &blob_with(&["a", "b"]));
    assert!(!evaluator.eval_rule(0).0);
    assert!(!evaluator.eval_rule(1).0);
    assert!(evaluator.warnings.iter().any(|w| w.contains("cycle")));
}

// ---------------------------------------------------------------------------
// unsupported-feature folding and honesty flags
// ---------------------------------------------------------------------------

#[test]
fn unsupported_and_child_skips_rule() {
    let set = compile_rules(&[doc(
        "needs disasm",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - mnemonic: mov\n",
    )]);
    let rule = rule(&set, "needs disasm");
    assert_eq!(rule.skip_reason.as_deref(), Some("requires-unsupported-features"));
    assert_eq!(rule.unsupported, ["mnemonic"]);
    assert!(matched_names(&set, &blob_with(&["alpha"])).is_empty());
}

#[test]
fn unsupported_or_branch_degrades() {
    let set = compile_rules(&[doc(
        "half blind",
        &meta("t", FILE),
        "    - or:\n        - string: \"alpha\"\n        - mnemonic: mov\n",
    )]);
    let rule = rule(&set, "half blind");
    assert!(rule.degraded);
    assert_eq!(rule.unsupported, ["mnemonic"]);
    assert!(rule.skip_reason.is_none());
    let out = report(&set, &blob_with(&["alpha"]), "{}");
    let cap = &out["capabilities"][0];
    assert_eq!(cap["name"], "half blind");
    assert_eq!(cap["degraded"], true);
    assert_eq!(cap["unsupported"], json!(["mnemonic"]));
}

#[test]
fn not_over_unsupported_still_reports_degraded() {
    // not(unsupported) folds to true so the rule can match; the dropped
    // feature is still reported so consumers see the approximation.
    let set = compile_rules(&[doc(
        "negated",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - not:\n            - mnemonic: mov\n",
    )]);
    let rule = rule(&set, "negated");
    assert!(rule.degraded);
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["negated"]);
}

#[test]
fn subscope_statement_skips() {
    let set = compile_rules(&[doc(
        "bb rule",
        &meta("t", FILE),
        "    - and:\n        - string: \"alpha\"\n        - basic block:\n            - or:\n                - mnemonic: cmp\n",
    )]);
    let rule = rule(&set, "bb rule");
    assert_eq!(rule.skip_reason.as_deref(), Some("requires-unsupported-features"));
    assert_eq!(rule.unsupported, ["mnemonic", "subscope"]);
}

#[test]
fn narrower_static_scope_is_skipped_honestly() {
    // A `static: basic block` rule would need per-scope extraction this
    // subset never performs; evaluating it against the file-scope union
    // would fabricate matches, so it is skipped instead.
    let set = compile_rules(&[doc(
        "bb scoped",
        &meta("t", "basic block"),
        "    - or:\n        - string: \"alpha\"\n",
    )]);
    let rule = rule(&set, "bb scoped");
    assert_eq!(rule.skip_reason.as_deref(), Some("static-scope-unsupported"));
    assert!(matched_names(&set, &blob_with(&["alpha"])).is_empty());
}

#[test]
fn file_rule_requiring_function_scope_rule_folds_unsatisfiable() {
    // `match:` on a skipped-scope rule is false; under `and:` the
    // referencing file-scope rule becomes unsatisfiable too, while an
    // `or:` sibling branch still lets it match (degraded).
    let set = compile_rules(&[
        doc(
            "fn scoped",
            &meta("t", "function"),
            "    - string: \"alpha\"\n",
        ),
        doc(
            "and user",
            &meta("t", FILE),
            "    - and:\n        - match: fn scoped\n        - string: \"alpha\"\n",
        ),
        doc(
            "or user",
            &meta("t", FILE),
            "    - or:\n        - match: fn scoped\n        - string: \"alpha\"\n",
        ),
    ]);
    assert_eq!(rule(&set, "fn scoped").skip_reason.as_deref(), Some("static-scope-unsupported"));
    assert_eq!(
        rule(&set, "and user").skip_reason.as_deref(),
        Some("requires-unsupported-features")
    );
    assert!(rule(&set, "or user").degraded);
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["or user"]);
}

#[test]
fn missing_scope_is_skipped() {
    let set = compile_rules(&[doc(
        "no scope",
        "    namespace: t\n",
        "    - string: \"alpha\"\n",
    )]);
    let rule = rule(&set, "no scope");
    assert_eq!(rule.skip_reason.as_deref(), Some("static-scope-unsupported"));
    assert!(matched_names(&set, &blob_with(&["alpha"])).is_empty());
}

#[test]
fn unparseable_yaml_becomes_parse_error_not_failure() {
    let mut docs = vec![doc("ok", &meta("t", FILE), "    - string: \"alpha\"\n")];
    docs.push("rule:\n  meta:\n    name: [unclosed\n".to_string());
    docs.push("rule:\n  meta:\n    name: no features\n".to_string());
    let set = compile_rules(&docs);
    assert_eq!(set.parse_errors.len(), 2);
    assert_eq!(matched_names(&set, &blob_with(&["alpha"])), ["ok"]);
}

#[test]
fn unparseable_regex_is_unsupported() {
    let set = compile_rules(&[doc(
        "bad re",
        &meta("t", FILE),
        "    - or:\n        - string: \"okay\"\n        - string: /a(/\n",
    )]);
    let rule = rule(&set, "bad re");
    assert_eq!(rule.unsupported, ["regex-uncompilable"]);
    assert_eq!(matched_names(&set, &blob_with(&["okay"])), ["bad re"]);
}

#[test]
fn inline_description_is_stripped() {
    let set = compile_rules(&[doc(
        "described",
        &meta("t", FILE),
        "    - and:\n        - api: kernel32.CheckRemoteDebuggerPresent = obvious anti-debug\n",
    )]);
    let pe = test_pe(&[("kernel32.dll", &["CheckRemoteDebuggerPresent"])], &[]);
    assert_eq!(matched_names(&set, &pe), ["described"]);
}

#[test]
fn characteristic_embedded_pe() {
    let set = compile_rules(&[doc(
        "dropper",
        &meta("t", FILE),
        "    - count(characteristic(embedded pe)): 1 or more\n",
    )]);
    let mut input = vec![0u8; 256];
    put(&mut input, 64, b"MZ");
    w32(&mut input, 64 + 0x3c, 0x40);
    put(&mut input, 64 + 0x40, b"PE\0\0");
    assert_eq!(matched_names(&set, &input), ["dropper"]);
    assert!(matched_names(&set, &vec![0u8; 256]).is_empty());
}

// ---------------------------------------------------------------------------
// PE / ELF extraction
// ---------------------------------------------------------------------------

#[test]
fn pe_globals_sections_imports_exports() {
    let pe = test_pe(
        &[("kernel32.dll", &["CheckRemoteDebuggerPresent", "CreateFileW"])],
        &[("ServiceMain", None), ("FwdFunc", Some("KERNEL32.HeapAlloc"))],
    );
    let features = extract::FeatureSet::extract(&pe);
    assert_eq!(features.formats, ["pe"]);
    assert_eq!(features.os, "windows");
    assert_eq!(features.arch, "i386");
    assert!(features.sections.iter().any(|s| s.name == ".tls"));
    assert!(features.apis.contains("CheckRemoteDebuggerPresent"));
    assert!(features.apis.contains("CreateFileW"));
    // A/W-trimmed base is generated like capa's extractors.
    assert!(features.apis.contains("CreateFile"));
    assert!(features.imports.contains("kernel32.CreateFileW"));
    assert!(features.imports.contains("kernel32"));
    assert!(features.libraries.iter().any(|l| l == "kernel32.dll"));
    assert!(features.exports.contains("ServiceMain"));
    assert!(features.has_forwarded_export);
    // Reexport targets keep their case; only the library part is lowercased.
    assert!(features.exports.contains("kernel32.HeapAlloc"));
}

#[test]
fn pe_features_match_rules() {
    let pe = test_pe(
        &[("kernel32.dll", &["CheckRemoteDebuggerPresent", "CreateFileW"])],
        &[("ServiceMain", None)],
    );
    let set = compile_rules(&[doc(
        "pe rule",
        &meta("t", FILE),
        "    - and:\n        - format: pe\n        - os: windows\n        - arch: i386\n        - section: .tls\n        - api: kernel32.CheckRemoteDebuggerPresent\n        - import: kernel32.CreateFileW\n        - export: ServiceMain\n",
    )]);
    assert_eq!(matched_names(&set, &pe), ["pe rule"]);
}

#[test]
fn pe_aw_symbol_normalization() {
    let pe = test_pe(&[("kernel32.dll", &["CreateFileW"])], &[]);
    let set = compile_rules(&[
        doc("full", &meta("t", FILE), "    - api: CreateFileW\n"),
        doc("trimmed", &meta("t", FILE), "    - api: kernel32.CreateFile\n"),
        doc("dll import", &meta("t", FILE), "    - import: kernel32.dll\n"),
        doc("lib import", &meta("t", FILE), "    - import: kernel32\n"),
    ]);
    // Evaluation order follows rule order in the ruleset.
    assert_eq!(matched_names(&set, &pe), ["full", "trimmed", "dll import", "lib import"]);
}

#[test]
fn forwarded_export_characteristic() {
    let pe = test_pe(&[], &[("FwdFunc", Some("KERNEL32.HeapAlloc"))]);
    let set = compile_rules(&[doc(
        "fwd",
        &meta("t", FILE),
        "    - characteristic: forwarded export\n",
    )]);
    assert_eq!(matched_names(&set, &pe), ["fwd"]);
}

#[test]
fn elf_globals_imports_exports() {
    let elf = test_elf();
    let features = extract::FeatureSet::extract(&elf);
    assert_eq!(features.formats, ["elf"]);
    assert_eq!(features.os, "linux");
    assert_eq!(features.arch, "amd64");
    assert!(features.sections.iter().any(|s| s.name == ".text"));
    assert!(features.apis.contains("recv"));
    assert!(features.apis.contains("send"));
    assert!(features.exports.contains("libmy_export"));
    assert!(features.libraries.iter().any(|l| l == "libc.so.6"));

    let set = compile_rules(&[doc(
        "elf rule",
        &meta("t", FILE),
        "    - and:\n        - format: elf\n        - os: linux\n        - arch: amd64\n        - api: recv\n        - import: libc.so.6\n        - export: libmy_export\n",
    )]);
    assert_eq!(matched_names(&set, &elf), ["elf rule"]);
}

// ---------------------------------------------------------------------------
// report-level behaviour (bounded output, options, honesty fields)
// ---------------------------------------------------------------------------

#[test]
fn empty_input_is_clean() {
    let set = compile_rules(&[doc("r", &meta("t", FILE), "    - string: \"x\"\n")]);
    let out = report(&set, &[], "{}");
    assert_eq!(out["schema_version"], 1);
    assert_eq!(out["capability_count"], 0);
    assert!(out["error"].is_null());
    assert_eq!(out["features"]["distinct_string_count"], 0);
}

#[test]
fn capabilities_sorted_by_namespace_then_name() {
    let set = compile_rules(&[
        doc("b one", &meta("ns/b", FILE), "    - string: \"xxxx\"\n"),
        doc("a two", &meta("ns/a", FILE), "    - string: \"xxxx\"\n"),
        doc("a one", &meta("ns/a", FILE), "    - string: \"xxxx\"\n"),
    ]);
    let out = report(&set, &blob_with(&["xxxx"]), "{}");
    let names: Vec<&str> = out["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["a one", "a two", "b one"]);
    assert_eq!(out["capability_count"], 3);
}

#[test]
fn evidence_locations_bounded_but_counted() {
    let strings: Vec<String> = (0..20).map(|_| "rep0".to_string()).collect();
    let refs: Vec<&str> = strings.iter().map(String::as_str).collect();
    let set = compile_rules(&[doc("r", &meta("t", FILE), "    - string: \"rep0\"\n")]);
    let out = report(&set, &blob_with(&refs), "{}");
    let evidence = &out["capabilities"][0]["evidence"][0];
    assert_eq!(evidence["count"], 20);
    assert_eq!(evidence["locations"].as_array().unwrap().len(), 8); // MAX_LOCATIONS
}

#[test]
fn lib_rules_hidden_unless_requested() {
    let set = compile_rules(&[
        doc("lib helper", &format!("    lib: true\n{}", meta("t", FILE)), "    - string: \"xxxx\"\n"),
        doc("visible", &meta("t", FILE), "    - string: \"xxxx\"\n"),
    ]);
    let out = report(&set, &blob_with(&["xxxx"]), "{}");
    assert_eq!(out["capability_count"], 1);
    assert_eq!(out["lib_matched_count"], 1);
    let out = report(&set, &blob_with(&["xxxx"]), "{\"includeLib\":true}");
    assert_eq!(out["capability_count"], 2);
}

#[test]
fn max_results_reports_true_count() {
    let set = compile_rules(&[
        doc("r1", &meta("t", FILE), "    - string: \"xxxx\"\n"),
        doc("r2", &meta("t", FILE), "    - string: \"xxxx\"\n"),
        doc("r3", &meta("t", FILE), "    - string: \"xxxx\"\n"),
    ]);
    let out = report(&set, &blob_with(&["xxxx"]), "{\"maxResults\":2}");
    assert_eq!(out["capability_count"], 3);
    assert_eq!(out["capabilities"].as_array().unwrap().len(), 2);
    assert_eq!(out["results_truncated"], true);
    assert_eq!(out["truncated"], true);
}

#[test]
fn include_skipped_lists_rules_and_reasons() {
    let set = compile_rules(&[
        doc("ok", &meta("t", FILE), "    - string: \"xxxx\"\n"),
        doc("blind", &meta("t", FILE), "    - and:\n        - string: \"xxxx\"\n        - mnemonic: mov\n"),
    ]);
    let out = report(&set, &blob_with(&["xxxx"]), "{\"includeSkipped\":true}");
    assert_eq!(out["skipped_count"], 1);
    assert_eq!(out["skipped_by_reason"]["requires-unsupported-features"], 1);
    let skipped = &out["skipped_rules"][0];
    assert_eq!(skipped["name"], "blind");
    assert_eq!(skipped["reason"], "requires-unsupported-features");
}

#[test]
fn unsupported_feature_kinds_listed() {
    let set = compile_rules(&[
        doc("r", &meta("t", FILE), "    - or:\n        - string: \"xxxx\"\n        - mnemonic: mov\n        - number: 4\n"),
    ]);
    let out = report(&set, &blob_with(&["xxxx"]), "{}");
    let kinds: Vec<&str> = out["unsupported_features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"mnemonic"));
    assert!(kinds.contains(&"number"));
}

#[test]
fn scan_budget_exhaustion_sets_truncated() {
    // >2048 distinct substring patterns hits MAX_SUBSTRING_PATTERNS and must
    // surface as scan_truncated, not silently drop rules.
    let rules: Vec<Value> = (0..2100)
        .map(|i| {
            json!({
                "name": format!("sub{i}"),
                "ns": "t",
                "scope": "file",
                "dyn": "unsupported",
                "tree": [["f", "substring", format!("pat{i:05}x")]],
            })
        })
        .collect();
    let set = ast::compile(&json!({
        "v": 1, "commit": "t", "imported": true, "rules": rules, "errors": [],
    }));
    let out = report(&set, &blob_containing("pat00001x"), "{}");
    assert_eq!(out["scan_truncated"], true);
    assert_eq!(out["truncated"], true);
}

#[test]
fn features_op_reports_pe_details() {
    let pe = test_pe(
        &[("kernel32.dll", &["CreateFileW"])],
        &[("ServiceMain", None)],
    );
    let out = crate::features_report(&pe, &serde_json::Map::new()).expect("features report");
    assert_eq!(out["schema_version"], 1);
    assert_eq!(out["formats"], json!(["pe"]));
    assert_eq!(out["os"], "windows");
    assert_eq!(out["arch"], "i386");
    assert!(out["sections"].as_array().unwrap().iter().any(|s| s["name"] == ".tls"));
    let imports = out["imports"].as_array().unwrap();
    assert!(imports.iter().any(|i| i["dll"] == "kernel32.dll" && i["name"] == "CreateFileW"));
    assert!(out["exports"].as_array().unwrap().iter().any(|e| e == "ServiceMain"));
    assert!(out["api_features"].as_array().unwrap().iter().any(|a| a == "CreateFile"));
}

#[test]
fn ruleset_op_counts_and_namespaces() {
    let set = compile_rules(&[
        doc("a", &meta("n/one", FILE), "    - string: \"xxxx\"\n"),
        doc("b", &meta("n/two", FILE), "    - mnemonic: mov\n"),
        doc("lib", &format!("    lib: true\n{}", meta("n/one", FILE)), "    - string: \"xxxx\"\n"),
    ]);
    let out: Value = serde_json::from_str(
        &crate::ruleset_report(&serde_json::Map::new(), &set).expect("ruleset report"),
    )
    .unwrap();
    assert_eq!(out["rule_count"], 3);
    assert_eq!(out["lib_count"], 1);
    assert_eq!(out["skipped_count"], 1);
    assert_eq!(out["evaluable_count"], 2);
    assert_eq!(out["namespaces"]["n/one"], 2);
    assert_eq!(out["namespaces"]["n"], 3);
    assert_eq!(out["skipped_by_reason"]["requires-unsupported-features"], 1);
}

#[test]
fn boundary_rejects_bad_options_and_size() {
    // Option validation fires before ruleset decode/matching, so these are
    // safe to drive through the real exported functions.
    for bad in ["{bad", "[1]", "42", "\"x\""] {
        let out: Value = serde_json::from_str(&crate::capa_match(&[], bad)).unwrap();
        assert_eq!(out["error"], "invalid_options", "{bad}");
    }
    let out: Value =
        serde_json::from_str(&crate::capa_match(&[], &" ".repeat(crate::MAX_OPTIONS_BYTES + 1)))
            .unwrap();
    assert_eq!(out["error"], "options_too_large");
    let out: Value = serde_json::from_str(&crate::capa_match(&[], "{\"maxResults\":\"x\"}")).unwrap();
    assert_eq!(out["error"], "invalid_options");
    let out: Value = serde_json::from_str(&crate::capa_match(&[], "{\"includeLib\":7}")).unwrap();
    assert_eq!(out["error"], "invalid_options");

    let oversized = vec![0u8; crate::MAX_INPUT_BYTES + 1];
    let out: Value = serde_json::from_str(&crate::capa_match(&oversized, "{}")).unwrap();
    assert_eq!(out["error"], "input_too_large");
    let out: Value = serde_json::from_str(&crate::capa_features(&oversized, "{}")).unwrap();
    assert_eq!(out["error"], "input_too_large");
}

#[test]
fn report_is_deterministic() {
    let set = compile_rules(&[
        doc("a", &meta("n/one", FILE), "    - or:\n        - string: \"xxxx\"\n        - mnemonic: mov\n"),
        doc("b", &meta("n/two", FILE), "    - string: \"xxxx\"\n"),
    ]);
    let input = blob_with(&["xxxx"]);
    assert_eq!(
        crate::match_report(&input, &serde_json::Map::new(), &set),
        crate::match_report(&input, &serde_json::Map::new(), &set)
    );
}

#[test]
fn embedded_ruleset_reports_import_state() {
    let set = crate::load_ruleset().expect("embedded blob decodes");
    let imported = option_env!("CAPA_MATCH_RULES_IMPORTED") == Some("1");
    assert_eq!(set.imported, imported);
    if imported {
        assert_eq!(set.commit, "805f9eaccfb6a4e1ddffc809d71d1e2b5ccc15e5");
        assert!(set.rules.len() > 500, "real ruleset has ~1k rules");
        // The full upstream set normalized without a single failure.
        assert_eq!(set.parse_errors.len(), 0);
    }
}

#[test]
fn embedded_ruleset_matches_known_rule() {
    if option_env!("CAPA_MATCH_RULES_IMPORTED") != Some("1") {
        return;
    }
    let input = blob_containing("@ADVobfuscator@andrivet@@");
    let out: Value = serde_json::from_str(&crate::capa_match(&input, "{}")).unwrap();
    assert_eq!(out["ruleset"]["imported"], true);
    let names: Vec<&str> = out["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"obfuscated with ADVobfuscator"),
        "expected ADVobfuscator match, got {names:?}"
    );
}
