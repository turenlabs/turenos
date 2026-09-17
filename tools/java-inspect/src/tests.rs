//! Unit tests. `.class` fixtures are fabricated in test code — the JVMS
//! format is compact and well-documented, so we hand-assemble constant
//! pools, members, and Code attributes rather than committing binaries.
//! JARs are written through the `zip` crate's own writer (stored and
//! deflated entries) so the test exercises the real inflate path.

use std::io::{Cursor, Write};

use serde_json::Value;

// ---------- .class fabricator ----------

/// Encoded constant-pool entries; indices are 1-based. `push` returns the
/// entry's index; wide entries push an empty placeholder for the second slot.
#[derive(Default)]
struct Pool {
    items: Vec<Vec<u8>>,
}

impl Pool {
    fn push(&mut self, encoded: Vec<u8>) -> u16 {
        self.items.push(encoded);
        self.items.len() as u16
    }
    fn utf8(&mut self, s: &str) -> u16 {
        let mut e = vec![1u8];
        e.extend_from_slice(&(s.len() as u16).to_be_bytes());
        e.extend_from_slice(s.as_bytes());
        self.push(e)
    }
    fn class(&mut self, name_index: u16) -> u16 {
        self.push(vec![7, (name_index >> 8) as u8, name_index as u8])
    }
    fn named_class(&mut self, name: &str) -> u16 {
        let n = self.utf8(name);
        self.class(n)
    }
    fn string(&mut self, s: &str) -> u16 {
        let u = self.utf8(s);
        self.push(vec![8, (u >> 8) as u8, u as u8])
    }
    fn nat(&mut self, name: &str, desc: &str) -> u16 {
        let n = self.utf8(name);
        let d = self.utf8(desc);
        self.push(vec![12, (n >> 8) as u8, n as u8, (d >> 8) as u8, d as u8])
    }
    fn methodref(&mut self, owner: &str, name: &str, desc: &str) -> u16 {
        let c = self.named_class(owner);
        let t = self.nat(name, desc);
        self.push(vec![10, (c >> 8) as u8, c as u8, (t >> 8) as u8, t as u8])
    }
    fn interface_methodref(&mut self, owner: &str, name: &str, desc: &str) -> u16 {
        let c = self.named_class(owner);
        let t = self.nat(name, desc);
        self.push(vec![11, (c >> 8) as u8, c as u8, (t >> 8) as u8, t as u8])
    }
    fn fieldref(&mut self, owner: &str, name: &str, desc: &str) -> u16 {
        let c = self.named_class(owner);
        let t = self.nat(name, desc);
        self.push(vec![9, (c >> 8) as u8, c as u8, (t >> 8) as u8, t as u8])
    }
    fn method_handle(&mut self, kind: u8, index: u16) -> u16 {
        self.push(vec![15, kind, (index >> 8) as u8, index as u8])
    }
    fn invoke_dynamic(&mut self, bsm: u16, name: &str, desc: &str) -> u16 {
        let t = self.nat(name, desc);
        self.push(vec![18, (bsm >> 8) as u8, bsm as u8, (t >> 8) as u8, t as u8])
    }
    fn integer(&mut self, value: i32) -> u16 {
        let mut e = vec![3u8];
        e.extend_from_slice(&value.to_be_bytes());
        self.push(e)
    }
    fn long(&mut self, value: i64) -> u16 {
        let mut e = vec![5u8];
        e.extend_from_slice(&value.to_be_bytes());
        let index = self.push(e);
        self.items.push(Vec::new()); // second slot
        index
    }
    /// Serialized as `u2 constant_pool_count` + concatenated entries.
    /// JVMS counts the reserved index 0, so the count is items + 1.
    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&((self.items.len() + 1) as u16).to_be_bytes());
        for item in &self.items {
            out.extend_from_slice(item);
        }
        out
    }
}

struct MemberSpec {
    access: u16,
    name: u16,
    desc: u16,
    attrs: Vec<(u16, Vec<u8>)>,
}

impl MemberSpec {
    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.access.to_be_bytes());
        out.extend_from_slice(&self.name.to_be_bytes());
        out.extend_from_slice(&self.desc.to_be_bytes());
        out.extend_from_slice(&(self.attrs.len() as u16).to_be_bytes());
        for (name, body) in &self.attrs {
            out.extend_from_slice(&name.to_be_bytes());
            out.extend_from_slice(&(body.len() as u32).to_be_bytes());
            out.extend_from_slice(body);
        }
        out
    }
}

/// Code attribute body (max_stack, max_locals, code, exception table, subs).
fn code_attr(
    max_stack: u16,
    max_locals: u16,
    code: &[u8],
    exceptions: &[[u16; 4]],
    subs: &[(u16, Vec<u8>)],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&max_stack.to_be_bytes());
    out.extend_from_slice(&max_locals.to_be_bytes());
    out.extend_from_slice(&(code.len() as u32).to_be_bytes());
    out.extend_from_slice(code);
    out.extend_from_slice(&(exceptions.len() as u16).to_be_bytes());
    for row in exceptions {
        for v in row {
            out.extend_from_slice(&v.to_be_bytes());
        }
    }
    out.extend_from_slice(&(subs.len() as u16).to_be_bytes());
    for (name, body) in subs {
        out.extend_from_slice(&name.to_be_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
    }
    out
}

fn u2s(value: u16) -> [u8; 2] {
    value.to_be_bytes()
}

#[allow(clippy::too_many_arguments)]
fn class_bytes(
    minor: u16,
    major: u16,
    pool: &Pool,
    access: u16,
    this: u16,
    sup: u16,
    interfaces: &[u16],
    fields: &[MemberSpec],
    methods: &[MemberSpec],
    attrs: &[(u16, Vec<u8>)],
) -> Vec<u8> {
    let mut out = vec![0xCA, 0xFE, 0xBA, 0xBE];
    out.extend_from_slice(&minor.to_be_bytes());
    out.extend_from_slice(&major.to_be_bytes());
    out.extend_from_slice(&pool.bytes());
    out.extend_from_slice(&access.to_be_bytes());
    out.extend_from_slice(&this.to_be_bytes());
    out.extend_from_slice(&sup.to_be_bytes());
    out.extend_from_slice(&(interfaces.len() as u16).to_be_bytes());
    for i in interfaces {
        out.extend_from_slice(&i.to_be_bytes());
    }
    out.extend_from_slice(&(fields.len() as u16).to_be_bytes());
    for f in fields {
        out.extend_from_slice(&f.bytes());
    }
    out.extend_from_slice(&(methods.len() as u16).to_be_bytes());
    for m in methods {
        out.extend_from_slice(&m.bytes());
    }
    out.extend_from_slice(&(attrs.len() as u16).to_be_bytes());
    for (name, body) in attrs {
        out.extend_from_slice(&name.to_be_bytes());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(body);
    }
    out
}

/// The canonical "HelloWorld" shape: Foo extends Object, a field, a
/// `<init>` that invokes Object.<init>, a static `main`, SourceFile.
fn hello_world() -> (Vec<u8>, Pool) {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Foo");
    let sup = pool.named_class("java/lang/Object");
    let init_ref = pool.methodref("java/lang/Object", "<init>", "()V");
    let hello = pool.string("hello world");
    let name_init = pool.utf8("<init>");
    let desc_init = pool.utf8("()V");
    let name_main = pool.utf8("main");
    let desc_main = pool.utf8("([Ljava/lang/String;)V");
    let name_field = pool.utf8("counter");
    let desc_field = pool.utf8("I");
    let a_code = pool.utf8("Code");
    let a_source = pool.utf8("SourceFile");
    let src = pool.utf8("Foo.java");

    // <init>: aload_0; invokespecial #init_ref; ldc #hello; pop; return
    let init_code = [
        0x2a,
        0xb7,
        (init_ref >> 8) as u8,
        init_ref as u8,
        0x12,
        hello as u8,
        0x57,
        0xb1,
    ];
    let methods = vec![
        MemberSpec {
            access: 0x0001,
            name: name_init,
            desc: desc_init,
            attrs: vec![(a_code, code_attr(1, 1, &init_code, &[], &[]))],
        },
        MemberSpec {
            access: 0x0009, // public static
            name: name_main,
            desc: desc_main,
            attrs: vec![(a_code, code_attr(0, 1, &[0xb1], &[], &[]))],
        },
    ];
    let fields = vec![MemberSpec {
        access: 0x0002, // private
        name: name_field,
        desc: desc_field,
        attrs: vec![],
    }];
    let bytes = class_bytes(
        0,
        52,
        &pool,
        0x0021, // public + super
        this,
        sup,
        &[],
        &fields,
        &methods,
        &[(a_source, u2s(src).to_vec())],
    );
    (bytes, pool)
}

fn parse(text: String) -> Value {
    serde_json::from_str(&text).expect("ops must return valid JSON")
}

fn ok(text: String) -> Value {
    let value = parse(text);
    assert!(value.get("error").is_none(), "unexpected error: {value}");
    value
}

fn failing(text: String, code: &str) -> Value {
    let value = parse(text);
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["error"], code, "expected {code}, got {value}");
    value
}

// ---------- class_inspect ----------

#[test]
fn inspect_minimal_class() {
    let (bytes, _) = hello_world();
    let report = ok(crate::class_inspect(&bytes, "{}"));
    assert_eq!(report["format"], "class");
    assert_eq!(report["major_version"], 52);
    assert_eq!(report["minor_version"], 0);
    assert_eq!(report["jdk"], "Java SE 8");
    assert_eq!(report["kind"], "class");
    assert_eq!(report["access_flags"], "0x0021");
    assert_eq!(report["this_class"], "com/example/Foo");
    assert_eq!(report["super_class"], "java/lang/Object");
    assert_eq!(report["source_file"], "Foo.java");
    assert_eq!(report["fields_total"], 1);
    assert_eq!(report["fields"][0]["name"], "counter");
    assert_eq!(report["fields"][0]["descriptor"], "I");
    assert_eq!(report["methods_total"], 2);
    assert_eq!(report["methods"][0]["name"], "<init>");
    assert_eq!(report["methods"][0]["code"]["code_length"], 8);
    assert_eq!(report["methods"][0]["code"]["max_stack"], 1);
    assert_eq!(report["methods"][0]["code"]["max_locals"], 1);
    assert_eq!(report["methods"][0]["code"]["exception_table_length"], 0);
    assert!(report["methods"][1]["code"]["code_length"] == 1);
    let tags = &report["constant_pool"]["by_tag"];
    assert!(tags["utf8"].as_u64().unwrap() >= 6);
    assert!(tags["methodref"].as_u64().unwrap() == 1);
    assert!(tags["string"].as_u64().unwrap() == 1);
    assert!(report["constant_pool"]["dump"].is_null());
    assert_eq!(report["findings"], serde_json::json!([]));
    assert_eq!(report["truncated"], false);
}

#[test]
fn constant_pool_dump_option() {
    let (bytes, _) = hello_world();
    let report = ok(crate::class_inspect(&bytes, r#"{"dump_constant_pool":true}"#));
    let dump = report["constant_pool"]["dump"].as_array().unwrap();
    assert!(dump.len() >= 10);
    let utf8_row = dump.iter().find(|r| r["tag"] == "utf8").unwrap();
    assert!(utf8_row["value"].as_str().unwrap().starts_with('"'));
    let method_row = dump.iter().find(|r| r["tag"] == "methodref").unwrap();
    assert!(method_row["value"]
        .as_str()
        .unwrap()
        .contains("java/lang/Object.<init>"));
}

#[test]
fn findings_detection() {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Evil");
    let sup = pool.named_class("java/lang/Object");
    let exec = pool.methodref("java/lang/Runtime", "exec", "(Ljava/lang/String;)Ljava/lang/Process;");
    let pb = pool.methodref("java/lang/ProcessBuilder", "<init>", "([Ljava/lang/String;)V");
    let reflect = pool.methodref("java/lang/Class", "forName", "(Ljava/lang/String;)Ljava/lang/Class;");
    let define = pool.methodref("java/lang/ClassLoader", "defineClass", "([BII)Ljava/lang/Class;");
    let unsafe_f = pool.fieldref("sun/misc/Unsafe", "theUnsafe", "Lsun/misc/Unsafe;");
    let script = pool.methodref("javax/script/ScriptEngine", "eval", "(Ljava/lang/String;)Ljava/lang/Object;");
    let _ois = pool.methodref("java/io/ObjectInputStream", "readObject", "()Ljava/lang/Object;");
    let read_obj = pool.utf8("readObject");
    let ro_desc = pool.utf8("(Ljava/io/ObjectInputStream;)V");
    let nat_name = pool.utf8("go");
    let nat_desc = pool.utf8("()V");
    let a_code = pool.utf8("Code");
    let serializable = pool.named_class("java/io/Serializable");

    let methods = vec![
        MemberSpec {
            access: 0x0001,
            name: nat_name,
            desc: nat_desc,
            attrs: vec![(a_code, code_attr(1, 1, &[0xb1], &[], &[]))],
        },
        MemberSpec {
            access: 0x0002,
            name: read_obj,
            desc: ro_desc,
            attrs: vec![],
        },
        MemberSpec {
            access: 0x0101, // public native
            name: pool.utf8("natives"),
            desc: nat_desc,
            attrs: vec![],
        },
    ];
    let bytes = class_bytes(
        0, 52, &pool, 0x0021, this, sup, &[serializable], &[], &methods, &[],
    );
    let report = ok(crate::class_inspect(&bytes, "{}"));
    let findings = report["findings"].as_array().unwrap();
    let kinds: Vec<&str> = findings
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    for expected in [
        "process_spawn",
        "reflection",
        "class_loader_define",
        "unsafe_usage",
        "script_engine",
        "serialization_call",
        "serialization_method",
        "native_method",
        "serializable",
    ] {
        assert!(kinds.contains(&expected), "missing {expected} in {kinds:?}");
    }
    let exec_finding = findings
        .iter()
        .find(|f| f["detail"].as_str().unwrap().contains("Runtime.exec"))
        .unwrap();
    assert_eq!(exec_finding["cp_index"], exec);
    assert!(findings
        .iter()
        .any(|f| f["cp_index"] == pb && f["kind"] == "process_spawn"));
    assert!(findings
        .iter()
        .any(|f| f["cp_index"] == reflect && f["kind"] == "reflection"));
    assert!(findings
        .iter()
        .any(|f| f["cp_index"] == define && f["kind"] == "class_loader_define"));
    assert!(findings
        .iter()
        .any(|f| f["cp_index"] == unsafe_f && f["kind"] == "unsafe_usage"));
    assert!(findings
        .iter()
        .any(|f| f["cp_index"] == script && f["kind"] == "script_engine"));
}

#[test]
fn invokedynamic_bootstrap_lambda() {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Lam");
    let sup = pool.named_class("java/lang/Object");
    // BootstrapMethods[0] -> MethodHandle(REF_invokeStatic) -> LambdaMetafactory.metafactory
    let metafactory = pool.methodref(
        "java/lang/invoke/LambdaMetafactory",
        "metafactory",
        "(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;Ljava/lang/invoke/MethodType;)Ljava/lang/invoke/CallSite;",
    );
    let handle = pool.method_handle(6, metafactory);
    let _indy = pool.invoke_dynamic(0, "run", "()Ljava/lang/Runnable;");
    let name = pool.utf8("go");
    let desc = pool.utf8("()V");
    let a_code = pool.utf8("Code");
    let a_bsm = pool.utf8("BootstrapMethods");

    let mut bsm_body = Vec::new();
    bsm_body.extend_from_slice(&1u16.to_be_bytes()); // num_bootstrap_methods
    bsm_body.extend_from_slice(&handle.to_be_bytes()); // bootstrap_method_ref
    bsm_body.extend_from_slice(&0u16.to_be_bytes()); // num args

    let methods = vec![MemberSpec {
        access: 0x0001,
        name,
        desc,
        attrs: vec![(a_code, code_attr(1, 1, &[0xb1], &[], &[]))],
    }];
    let bytes = class_bytes(
        0, 52, &pool, 0x0021, this, sup, &[], &[], &methods, &[(a_bsm, bsm_body)],
    );
    let report = ok(crate::class_inspect(&bytes, "{}"));
    assert_eq!(report["uses_invokedynamic"], true);
    assert_eq!(report["uses_lambdas"], true);
    assert_eq!(report["uses_string_concat"], false);
    let bsm = &report["bootstrap_methods"][0];
    assert_eq!(bsm["method_ref"], handle);
    assert!(bsm["resolved_owner"]
        .as_str()
        .unwrap()
        .contains("LambdaMetafactory"));
}

#[test]
fn annotations_and_inner_classes() {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Outer");
    let sup = pool.named_class("java/lang/Object");
    let inner = pool.named_class("com/example/Outer$Inner");
    let inner_name = pool.utf8("Inner");
    let anno_type = pool.utf8("Lcom/example/Marker;");
    let elem_name = pool.utf8("value");
    let a_inner = pool.utf8("InnerClasses");
    let a_anno = pool.utf8("RuntimeVisibleAnnotations");

    // InnerClasses: one row
    let mut inner_body = Vec::new();
    inner_body.extend_from_slice(&1u16.to_be_bytes());
    inner_body.extend_from_slice(&inner.to_be_bytes());
    inner_body.extend_from_slice(&this.to_be_bytes());
    inner_body.extend_from_slice(&inner_name.to_be_bytes());
    inner_body.extend_from_slice(&0x0009u16.to_be_bytes()); // public static

    // RuntimeVisibleAnnotations: 1 annotation, 1 pair (value=42 int)
    let int_entry = pool.integer(42);
    let mut anno_body = Vec::new();
    anno_body.extend_from_slice(&1u16.to_be_bytes()); // num_annotations
    anno_body.extend_from_slice(&anno_type.to_be_bytes());
    anno_body.extend_from_slice(&1u16.to_be_bytes()); // num pairs
    anno_body.extend_from_slice(&elem_name.to_be_bytes());
    anno_body.push(b'I');
    anno_body.extend_from_slice(&int_entry.to_be_bytes());

    let bytes = class_bytes(
        0,
        52,
        &pool,
        0x0021,
        this,
        sup,
        &[],
        &[],
        &[],
        &[(a_inner, inner_body), (a_anno, anno_body)],
    );
    let report = ok(crate::class_inspect(&bytes, "{}"));
    assert_eq!(report["inner_classes"][0]["inner_name"], "Inner");
    assert_eq!(report["annotations"][0]["descriptor"], "Lcom/example/Marker;");
    assert_eq!(
        report["annotations"][0]["elements"][0]["name"],
        "value"
    );
    assert!(report["annotations"][0]["elements"][0]["value"]
        .as_str()
        .unwrap()
        .contains("42"));
}

// ---------- class_disassemble ----------

#[test]
fn disasm_basic_listing() {
    let (bytes, _) = hello_world();
    let report = ok(crate::class_disassemble(&bytes, "{}"));
    assert_eq!(report["this_class"], "com/example/Foo");
    assert_eq!(report["methods_total"], 2);
    let init = &report["methods"][0];
    assert_eq!(init["name"], "<init>");
    let text = init["text"].as_str().unwrap();
    assert!(text.contains("aload_0"), "{text}");
    assert!(text.contains("invokespecial #"), "{text}");
    assert!(text.contains("// Method java/lang/Object.<init>:()V"), "{text}");
    assert!(text.contains("ldc #"), "{text}");
    assert!(text.contains("// String \"hello world\""), "{text}");
    assert!(text.trim_end().ends_with("return"), "{text}");
}

#[test]
fn disasm_switches_wide_and_misc() {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Sw");
    let sup = pool.named_class("java/lang/Object");
    let name = pool.utf8("m");
    let desc = pool.utf8("()V");
    let a_code = pool.utf8("Code");
    let imethod = pool.interface_methodref("java/util/List", "size", "()I");
    let cls = pool.named_class("java/lang/Object");
    let big = pool.long(0x1122334455667788);

    let code: Vec<u8> = vec![
        0x10, 0x07, // bipush 7
        0x11, 0x01, 0x00, // sipush 256
        0x3c, // istore_1
        0x99, 0x00, 0x09, // ifeq -> offset 6+9=15
        0xa7, 0x00, 0x0c, // goto -> 9+12=21
        0xbb, // new at 12
        (cls >> 8) as u8,
        cls as u8,
        0xb1, // return at 15
        0xbe, // arraylength at 16
        0xbf, // athrow at 17
        0xc0, // checkcast at 18
        (cls >> 8) as u8,
        cls as u8,
        0xb1, // return at 21
        0xc4, 0x15, 0x01, 0x2c, // wide iload 300 at 22
        0xc4, 0x84, 0x00, 0x05, 0xff, 0xfe, // wide iinc 5 -2 at 26
        0x84, 0x02, 0xfd, // iinc 2 -3 at 32
        0xb9, // invokeinterface at 35
        (imethod >> 8) as u8,
        imethod as u8,
        0x01,
        0x00,
        0xbc, 0x0a, // newarray int at 40
        0xbd, // anewarray at 42
        (cls >> 8) as u8,
        cls as u8,
        0xc5, // multianewarray at 45
        (cls >> 8) as u8,
        cls as u8,
        0x02,
        0x14, // ldc2_w at 49
        (big >> 8) as u8,
        big as u8,
        0xc6, 0x00, 0x05, // ifnull -> 52+5=57 at 52
        0xb1, // return at 55
    ];

    let methods = vec![MemberSpec {
        access: 0x0001,
        name,
        desc,
        attrs: vec![(a_code, code_attr(4, 4, &code, &[], &[]))],
    }];
    let bytes = class_bytes(0, 52, &pool, 0x0021, this, sup, &[], &[], &methods, &[]);
    let report = ok(crate::class_disassemble(&bytes, "{}"));
    let text = report["methods"][0]["text"].as_str().unwrap();
    for needle in [
        "bipush 7",
        "sipush 256",
        "istore_1",
        "ifeq 15",
        "goto 21",
        "new #",
        "// class java/lang/Object",
        "arraylength",
        "athrow",
        "checkcast #",
        "wide iload 300",
        "wide iinc 5 -2",
        "iinc 2 -3",
        "invokeinterface #",
        "InterfaceMethod java/util/List.size:()I",
        "newarray int",
        "anewarray #",
        "multianewarray #",
        "ldc2_w #",
        "long 1234605616436508552",
        "ifnull 57",
    ] {
        assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
    }
}

#[test]
fn disasm_tableswitch_lookupswitch() {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Switches");
    let sup = pool.named_class("java/lang/Object");
    let name = pool.utf8("s");
    let desc = pool.utf8("(I)I");
    let a_code = pool.utf8("Code");

    // Layout:
    //   0: iconst_1
    //   1: tableswitch (pad 2: bytes 2,3) body 4..16, cases 16..24 -> next 24
    //  24: lookupswitch (pad 3: 25..27) body 28..36, pairs 36..52 -> next 52
    //  52: return
    let mut code = vec![0x04, 0xaa];
    code.extend_from_slice(&[0x00, 0x00]); // pad
    code.extend_from_slice(&21i32.to_be_bytes()); // default -> 1+21=22
    code.extend_from_slice(&1i32.to_be_bytes()); // low
    code.extend_from_slice(&2i32.to_be_bytes()); // high
    code.extend_from_slice(&17i32.to_be_bytes()); // case 1 -> 1+17=18
    code.extend_from_slice(&19i32.to_be_bytes()); // case 2 -> 1+19=20
    assert_eq!(code.len(), 24);
    code.push(0xab);
    code.extend_from_slice(&[0x00, 0x00, 0x00]); // pad to 28
    code.extend_from_slice(&24i32.to_be_bytes()); // default -> 24+24=48
    code.extend_from_slice(&2i32.to_be_bytes()); // npairs
    code.extend_from_slice(&7i32.to_be_bytes()); // match 7
    code.extend_from_slice(&20i32.to_be_bytes()); // -> 24+20=44
    code.extend_from_slice(&9i32.to_be_bytes()); // match 9
    code.extend_from_slice(&22i32.to_be_bytes()); // -> 24+22=46
    assert_eq!(code.len(), 52);
    code.push(0xb1); // return at 52

    let methods = vec![MemberSpec {
        access: 0x0001,
        name,
        desc,
        attrs: vec![(a_code, code_attr(2, 2, &code, &[], &[]))],
    }];
    let bytes = class_bytes(0, 52, &pool, 0x0021, this, sup, &[], &[], &methods, &[]);
    let report = ok(crate::class_disassemble(&bytes, "{}"));
    let text = report["methods"][0]["text"].as_str().unwrap();
    assert!(text.contains("tableswitch { // 1 to 2"), "{text}");
    assert!(text.contains("1: 18"), "{text}");
    assert!(text.contains("2: 20"), "{text}");
    assert!(text.contains("default: 22"), "{text}");
    assert!(text.contains("lookupswitch { // 2 pairs"), "{text}");
    assert!(text.contains("7: 44"), "{text}");
    assert!(text.contains("9: 46"), "{text}");
    assert!(text.contains("default: 48"), "{text}");
    assert!(text.trim_end().ends_with("return"), "{text}");
}

#[test]
fn disasm_unknown_opcode_and_truncated() {
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Bad");
    let sup = pool.named_class("java/lang/Object");
    let name = pool.utf8("m");
    let desc = pool.utf8("()V");
    let a_code = pool.utf8("Code");

    // 0xcb is an undefined opcode -> explicit WARNING, then stop.
    let methods = vec![
        MemberSpec {
            access: 0x0001,
            name,
            desc,
            attrs: vec![(a_code, code_attr(1, 1, &[0x2a, 0xcb, 0xb1], &[], &[]))],
        },
        // invokevirtual missing its second index byte -> truncated operand.
        MemberSpec {
            access: 0x0001,
            name,
            desc,
            attrs: vec![(a_code, code_attr(1, 1, &[0xb6, 0x00], &[], &[]))],
        },
    ];
    let bytes = class_bytes(0, 52, &pool, 0x0021, this, sup, &[], &[], &methods, &[]);
    let report = ok(crate::class_disassemble(&bytes, "{}"));
    let t0 = report["methods"][0]["text"].as_str().unwrap();
    assert!(t0.contains("aload_0"), "{t0}");
    assert!(t0.contains("// WARNING: unknown opcode 0xcb"), "{t0}");
    assert!(!t0.contains("return"), "{t0}");
    let t1 = report["methods"][1]["text"].as_str().unwrap();
    assert!(t1.contains("// WARNING: truncated operand for invokevirtual"), "{t1}");
    assert!(report["warnings"].as_array().unwrap().len() >= 2);
}

#[test]
fn disasm_method_selection_and_no_code() {
    let (bytes, _) = hello_world();
    // by index
    let report = ok(crate::class_disassemble(&bytes, r#"{"method_index":1}"#));
    assert_eq!(report["methods_selected"], 1);
    assert_eq!(report["methods"][0]["name"], "main");
    // by name
    let report = ok(crate::class_disassemble(&bytes, r#"{"method_name":"<init>"}"#));
    assert_eq!(report["methods"][0]["name"], "<init>");
    // missing
    failing(
        crate::class_disassemble(&bytes, r#"{"method_name":"nope"}"#),
        "method_not_found",
    );
    failing(
        crate::class_disassemble(&bytes, r#"{"method_index":99}"#),
        "method_not_found",
    );

    // native method -> explicit no-Code marker
    let mut pool = Pool::default();
    let this = pool.named_class("com/example/Nat");
    let sup = pool.named_class("java/lang/Object");
    let name = pool.utf8("n");
    let desc = pool.utf8("()V");
    let methods = vec![MemberSpec {
        access: 0x0101,
        name,
        desc,
        attrs: vec![],
    }];
    let bytes = class_bytes(0, 52, &pool, 0x0021, this, sup, &[], &[], &methods, &[]);
    let report = ok(crate::class_disassemble(&bytes, "{}"));
    assert!(report["methods"][0]["text"]
        .as_str()
        .unwrap()
        .contains("// WARNING: method has no Code attribute"));
}

// ---------- malformed class inputs ----------

#[test]
fn malformed_inputs_fail_closed() {
    failing(crate::class_inspect(b"", "{}"), "empty_input");
    failing(
        crate::class_inspect(&[0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 52, 0, 1], "{}"),
        "bad_magic",
    );
    // truncated constant pool: Utf8 entry claims 5 bytes, 1 present
    let mut bytes = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52, 0, 3];
    bytes.extend_from_slice(&[1, 0, 5, b'A']);
    failing(crate::class_inspect(&bytes, "{}"), "truncated_class");

    // constant pool count runs past EOF
    let mut bytes = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52, 0, 9];
    bytes.extend_from_slice(&[7, 0, 1]); // one Class entry, count wants 8
    failing(crate::class_inspect(&bytes, "{}"), "truncated_class");

    // unknown cp tag
    let mut bytes = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52, 0, 2, 0x7f, 0x00];
    bytes.extend_from_slice(&[0; 10]);
    failing(crate::class_inspect(&bytes, "{}"), "bad_constant_pool");

    // oversized attribute length
    let mut pool = Pool::default();
    let this = pool.named_class("A");
    let sup = pool.named_class("java/lang/Object");
    let a_src = pool.utf8("SourceFile");
    let mut body = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52];
    body.extend_from_slice(&pool.bytes());
    body.extend_from_slice(&0x0021u16.to_be_bytes());
    body.extend_from_slice(&this.to_be_bytes());
    body.extend_from_slice(&sup.to_be_bytes());
    body.extend_from_slice(&[0; 6]); // no ifaces/fields/methods
    body.extend_from_slice(&1u16.to_be_bytes()); // 1 attribute
    body.extend_from_slice(&a_src.to_be_bytes());
    body.extend_from_slice(&999u32.to_be_bytes()); // attribute_length way past EOF
    body.extend_from_slice(&[0, 0]);
    failing(crate::class_inspect(&body, "{}"), "truncated_class");

    // this_class index past the pool: structural parse OK, resolution lenient
    let mut pool = Pool::default();
    let _u = pool.utf8("x");
    let sup = pool.named_class("java/lang/Object");
    let bytes = class_bytes(0, 52, &pool, 0x0000, 200, sup, &[], &[], &[], &[]);
    let report = ok(crate::class_inspect(&bytes, "{}"));
    assert_eq!(report["this_class"], "<bad ref #200>");

    // oversized input
    let too_big = vec![0u8; 33 * 1024 * 1024];
    failing(crate::class_inspect(&too_big, "{}"), "input_too_large");
}

#[test]
fn options_validation() {
    let (bytes, _) = hello_world();
    failing(crate::class_inspect(&bytes, "{"), "invalid_options");
    failing(crate::class_inspect(&bytes, "[]"), "invalid_options");
    failing(crate::class_inspect(&bytes, "42"), "invalid_options");
    failing(
        crate::class_inspect(&bytes, &format!("{{{}\"a\":1}}", " ".repeat(5000))),
        "options_too_large",
    );
    failing(crate::jar_inspect(&bytes, "["), "invalid_options");
}

// ---------- jar_inspect ----------

/// Build a JAR via the zip crate writer: manifest + one real .class +
/// signing files + multi-release + module-info.
fn test_jar(class_bytes_fixture: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer
        .start_file("META-INF/MANIFEST.MF", stored)
        .unwrap();
    writer
        .write_all(
            b"Manifest-Version: 1.0\r\nMain-Class: com.example.Foo\r\nMulti-Release: true\r\nSHA-256-Digest: abc=\r\n",
        )
        .unwrap();
    writer.start_file("com/example/Foo.class", deflated).unwrap();
    writer.write_all(class_bytes_fixture).unwrap();
    writer.start_file("com/example/data.txt", stored).unwrap();
    writer.write_all(b"hello").unwrap();
    writer.start_file("META-INF/TEST.SF", stored).unwrap();
    writer.write_all(b"Signature-Version: 1.0\r\nSHA-256-Digest-Manifest: xyz=\r\n").unwrap();
    writer.start_file("META-INF/TEST.RSA", stored).unwrap();
    writer.write_all(b"\x30\x82fake").unwrap();
    writer
        .start_file("META-INF/versions/9/com/example/Foo.class", deflated)
        .unwrap();
    writer.write_all(class_bytes_fixture).unwrap();
    writer.start_file("module-info.class", stored).unwrap();
    writer.write_all(class_bytes_fixture).unwrap();
    writer.start_file("META-INF/", stored).unwrap();
    writer.finish().unwrap().into_inner()
}

#[test]
fn jar_basic() {
    let (class, _) = hello_world();
    let jar = test_jar(&class);
    let report = ok(crate::jar_inspect(&jar, "{}"));
    assert_eq!(report["format"], "jar");
    assert_eq!(report["entries_total"], 8);
    assert_eq!(report["class_entries"], 3); // Foo + versions/9/Foo + module-info
    assert_eq!(report["multi_release"], true);
    assert_eq!(report["multi_release_manifest"], true);
    assert_eq!(report["versioned_entries"], 1);
    assert_eq!(report["versions"], serde_json::json!(["9"]));
    assert_eq!(report["module_info"], "module-info.class");
    assert_eq!(report["signed"], true);
    let signing: Vec<&str> = report["signing_files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert!(signing.contains(&"META-INF/TEST.SF"));
    assert!(signing.contains(&"META-INF/TEST.RSA"));
    let manifest = &report["manifest"];
    assert_eq!(manifest["present"], true);
    assert_eq!(manifest["main_attributes"]["Main-Class"], "com.example.Foo");
    assert_eq!(manifest["main_attributes"]["Manifest-Version"], "1.0");
    assert!(manifest["digest_attributes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d == "SHA-256-Digest"));
    assert!(manifest["text"].as_str().unwrap().contains("Main-Class"));
    // entry table
    let entries = report["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 8);
    let class_entry = entries
        .iter()
        .find(|e| e["name"] == "com/example/Foo.class")
        .unwrap();
    assert_eq!(class_entry["is_class"], true);
    assert_eq!(class_entry["method"], "deflated");
}

#[test]
fn jar_selected_entry() {
    let (class, _) = hello_world();
    let jar = test_jar(&class);
    // index 1 = com/example/Foo.class (deflated)
    let report = ok(crate::jar_inspect(&jar, r#"{"entry_index":1}"#));
    let selected = &report["selected_entry"];
    assert_eq!(selected["name"], "com/example/Foo.class");
    assert_eq!(selected["is_class"], true);
    assert_eq!(selected["class"]["this_class"], "com/example/Foo");
    assert_eq!(selected["class"]["major_version"], 52);

    // non-class entry
    let report = ok(crate::jar_inspect(&jar, r#"{"entry_index":2}"#));
    assert_eq!(report["selected_entry"]["is_class"], false);
    assert!(report["selected_entry"]["class"].is_null());

    failing(
        crate::jar_inspect(&jar, r#"{"entry_index":99}"#),
        "entry_not_found",
    );
    failing(crate::jar_inspect(b"not a zip", "{}"), "bad_zip");
}

// ---------- mutation fuzz (deterministic, bounded) ----------

/// Every truncation and single-byte mutation of a valid class must return
/// well-formed JSON — a parser panic would surface as `internal_error`,
/// which this test rejects (fail-closed codes are fine, crashes are not).
#[test]
fn fuzz_truncations_and_mutations_never_panic() {
    let (class, _) = hello_world();
    for len in 0..class.len() {
        let value = parse(crate::class_inspect(&class[..len], "{}"));
        assert_ne!(value["error"], "internal_error", "panic at len {len}");
        let value = parse(crate::class_disassemble(&class[..len], "{}"));
        assert_ne!(value["error"], "internal_error", "panic at len {len}");
    }
    for i in 0..class.len() {
        let mut mutated = class.clone();
        mutated[i] ^= 0xFF;
        let value = parse(crate::class_inspect(&mutated, "{}"));
        assert_ne!(value["error"], "internal_error", "panic at byte {i}");
        let value = parse(crate::class_disassemble(&mutated, "{}"));
        assert_ne!(value["error"], "internal_error", "panic at byte {i}");
        let value = parse(crate::jar_inspect(&mutated, "{}"));
        assert_ne!(value["error"], "internal_error", "panic at byte {i}");
    }
    // Same for the fabricated jar.
    let jar = test_jar(&class);
    for len in 0..jar.len().min(512) {
        let value = parse(crate::jar_inspect(&jar[..len], "{}"));
        assert_ne!(value["error"], "internal_error", "panic at len {len}");
    }
}

// ---------- determinism ----------

#[test]
fn deterministic_output() {
    let (class, _) = hello_world();
    assert_eq!(
        crate::class_inspect(&class, "{}"),
        crate::class_inspect(&class, "{}")
    );
    assert_eq!(
        crate::class_disassemble(&class, "{}"),
        crate::class_disassemble(&class, "{}")
    );
    let jar = test_jar(&class);
    assert_eq!(
        crate::jar_inspect(&jar, "{}"),
        crate::jar_inspect(&jar, "{}")
    );
}
