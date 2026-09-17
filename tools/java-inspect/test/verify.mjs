import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { deflateRawSync } from "node:zlib"

const directory = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../pkg"))
const api = await import(pathToFileURL(path.join(directory, "turen_java_inspect_wasm.js")).href)
await api.default({ module_or_path: await readFile(path.join(directory, "turen_java_inspect_wasm_bg.wasm")) })

const encoder = new TextEncoder()

// ---------- .class fabricator (JVMS §4 layout, assembled by hand) ----------

const u16 = (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff])
const u32 = (v) => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

class Pool {
  constructor() {
    this.items = []
  }
  push(encoded) {
    this.items.push(encoded)
    return this.items.length // 1-based index
  }
  utf8(text) {
    const bytes = encoder.encode(text)
    return this.push(concat(new Uint8Array([1]), u16(bytes.length), bytes))
  }
  namedClass(name) {
    return this.push(concat(new Uint8Array([7]), u16(this.utf8(name))))
  }
  string(text) {
    return this.push(concat(new Uint8Array([8]), u16(this.utf8(text))))
  }
  nat(name, desc) {
    return this.push(concat(new Uint8Array([12]), u16(this.utf8(name)), u16(this.utf8(desc))))
  }
  methodref(owner, name, desc) {
    return this.push(concat(new Uint8Array([10]), u16(this.namedClass(owner)), u16(this.nat(name, desc))))
  }
  interfaceMethodref(owner, name, desc) {
    return this.push(concat(new Uint8Array([11]), u16(this.namedClass(owner)), u16(this.nat(name, desc))))
  }
  fieldref(owner, name, desc) {
    return this.push(concat(new Uint8Array([9]), u16(this.namedClass(owner)), u16(this.nat(name, desc))))
  }
  methodHandle(kind, index) {
    return this.push(concat(new Uint8Array([15, kind]), u16(index)))
  }
  invokeDynamic(bsm, name, desc) {
    return this.push(concat(new Uint8Array([18]), u16(bsm), u16(this.nat(name, desc))))
  }
  integer(value) {
    return this.push(concat(new Uint8Array([3]), u32(value >>> 0)))
  }
  bytes() {
    // JVMS constant_pool_count includes the reserved index 0.
    return concat(u16(this.items.length + 1), ...this.items)
  }
}

const member = (access, name, desc, attrs = []) =>
  concat(
    u16(access),
    u16(name),
    u16(desc),
    u16(attrs.length),
    ...attrs.map(([nameIndex, body]) => concat(u16(nameIndex), u32(body.length), body)),
  )

const codeAttr = (maxStack, maxLocals, code, exceptions = [], subs = []) =>
  concat(
    u16(maxStack),
    u16(maxLocals),
    u32(code.length),
    code,
    u16(exceptions.length),
    ...exceptions.map((row) => concat(...row.map(u16))),
    u16(subs.length),
    ...subs.map(([nameIndex, body]) => concat(u16(nameIndex), u32(body.length), body)),
  )

const classBytes = ({ minor = 0, major = 52, pool, access = 0x0021, thisClass, superClass, interfaces = [], fields = [], methods = [], attrs = [] }) =>
  concat(
    new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
    u16(minor),
    u16(major),
    pool.bytes(),
    u16(access),
    u16(thisClass),
    u16(superClass),
    u16(interfaces.length),
    ...interfaces.map(u16),
    u16(fields.length),
    ...fields,
    u16(methods.length),
    ...methods,
    u16(attrs.length),
    ...attrs.map(([nameIndex, body]) => concat(u16(nameIndex), u32(body.length), body)),
  )

// Canonical class: com/example/Foo extends java/lang/Object, private int
// counter, <init> calling Object.<init>, static main, SourceFile=Foo.java.
const helloWorld = () => {
  const pool = new Pool()
  const thisClass = pool.namedClass("com/example/Foo")
  const superClass = pool.namedClass("java/lang/Object")
  const initRef = pool.methodref("java/lang/Object", "<init>", "()V")
  const hello = pool.string("hello world")
  const nameInit = pool.utf8("<init>")
  const descInit = pool.utf8("()V")
  const nameMain = pool.utf8("main")
  const descMain = pool.utf8("([Ljava/lang/String;)V")
  const nameField = pool.utf8("counter")
  const descField = pool.utf8("I")
  const aCode = pool.utf8("Code")
  const aSource = pool.utf8("SourceFile")
  const src = pool.utf8("Foo.java")
  const initCode = new Uint8Array([
    0x2a, // aload_0
    0xb7, (initRef >> 8) & 0xff, initRef & 0xff, // invokespecial #initRef
    0x12, hello & 0xff, // ldc #hello
    0x57, // pop
    0xb1, // return
  ])
  return classBytes({
    pool,
    thisClass,
    superClass,
    fields: [member(0x0002, nameField, descField)],
    methods: [
      member(0x0001, nameInit, descInit, [[aCode, codeAttr(1, 1, initCode)]]),
      member(0x0009, nameMain, descMain, [[aCode, codeAttr(0, 1, new Uint8Array([0xb1]))]]),
    ],
    attrs: [[aSource, u16(src)]],
  })
}

// Class with hostile constant-pool refs for findings coverage.
const evilClass = () => {
  const pool = new Pool()
  const thisClass = pool.namedClass("com/example/Evil")
  const superClass = pool.namedClass("java/lang/Object")
  const exec = pool.methodref("java/lang/Runtime", "exec", "(Ljava/lang/String;)Ljava/lang/Process;")
  const unsafe = pool.fieldref("sun/misc/Unsafe", "theUnsafe", "Lsun/misc/Unsafe;")
  const forName = pool.methodref("java/lang/Class", "forName", "(Ljava/lang/String;)Ljava/lang/Class;")
  const define = pool.methodref("java/lang/ClassLoader", "defineClass", "([BII)Ljava/lang/Class;")
  const name = pool.utf8("readObject")
  const desc = pool.utf8("(Ljava/io/ObjectInputStream;)V")
  const serializable = pool.namedClass("java/io/Serializable")
  const bytes = classBytes({
    pool,
    thisClass,
    superClass,
    interfaces: [serializable],
    methods: [member(0x0102, name, desc)], // private native readObject
  })
  return { bytes, exec, unsafe, forName, define }
}

// ---------- minimal ZIP/JAR writer (stored + deflate) ----------

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const u16le = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff])
const u32le = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff])

const zipEntry = (name, content, { deflate = false } = {}) => {
  const nameBytes = encoder.encode(name)
  const data = deflate ? deflateRawSync(content) : content
  const crc = crc32(content)
  const local = concat(
    u32le(0x04034b50),
    u16le(20),
    u16le(0),
    u16le(deflate ? 8 : 0),
    u16le(0),
    u16le(0),
    u32le(crc),
    u32le(data.length),
    u32le(content.length),
    u16le(nameBytes.length),
    u16le(0),
    nameBytes,
    data,
  )
  return { name, nameBytes, crc, data, content, deflate, local }
}

const buildJar = (entries) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    locals.push(entry.local)
    centrals.push(
      concat(
        u32le(0x02014b50),
        u16le(20),
        u16le(20),
        u16le(0),
        u16le(entry.deflate ? 8 : 0),
        u16le(0),
        u16le(0),
        u32le(entry.crc),
        u32le(entry.data.length),
        u32le(entry.content.length),
        u16le(entry.nameBytes.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(offset),
        entry.nameBytes,
      ),
    )
    offset += entry.local.length
  }
  const centralStart = offset
  const central = concat(...centrals)
  const end = concat(
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(central.length),
    u32le(centralStart),
    u16le(0),
  )
  return concat(...locals, central, end)
}

const manifest = encoder.encode(
  "Manifest-Version: 1.0\r\nMain-Class: com.example.Foo\r\nSHA-256-Digest: abc=\r\n",
)
const testJar = (classBytesValue) =>
  buildJar([
    zipEntry("META-INF/MANIFEST.MF", manifest),
    zipEntry("com/example/Foo.class", classBytesValue, { deflate: true }),
    zipEntry("com/example/data.txt", encoder.encode("hello")),
    zipEntry("META-INF/TEST.SF", encoder.encode("Signature-Version: 1.0\r\n")),
    zipEntry("META-INF/TEST.RSA", new Uint8Array([0x30, 0x82, 1, 2])),
    zipEntry("module-info.class", classBytesValue),
  ])

// ---------- helpers ----------

const ok = (text) => {
  const value = JSON.parse(text)
  assert.equal(value.error, undefined, text.slice(0, 400))
  return value
}
const failing = (text, code) => {
  const value = JSON.parse(text)
  assert.equal(value.schema_version, 1, text)
  assert.equal(value.error, code, text)
  return value
}

// ---------- class_inspect ----------

const clazz = helloWorld()
const report = ok(api.class_inspect(clazz, "{}"))
assert.equal(report.schema_version, 1)
assert.equal(report.format, "class")
assert.equal(report.major_version, 52)
assert.equal(report.jdk, "Java SE 8")
assert.equal(report.kind, "class")
assert.equal(report.access_flags, "0x0021")
assert.equal(report.this_class, "com/example/Foo")
assert.equal(report.super_class, "java/lang/Object")
assert.equal(report.source_file, "Foo.java")
assert.equal(report.fields_total, 1)
assert.equal(report.fields[0].name, "counter")
assert.equal(report.methods_total, 2)
assert.equal(report.methods[0].name, "<init>")
assert.equal(report.methods[0].code.max_stack, 1)
assert.equal(report.methods[0].code.max_locals, 1)
assert.equal(report.methods[0].code.code_length, 8)
assert.equal(report.methods[0].code.exception_table_length, 0)
assert.ok(report.constant_pool.by_tag.utf8 >= 6)
assert.equal(report.constant_pool.by_tag.methodref, 1)
assert.equal(report.constant_pool.by_tag.string, 1)

const dumped = ok(api.class_inspect(clazz, '{"dump_constant_pool":true}'))
assert.ok(Array.isArray(dumped.constant_pool.dump))
assert.ok(dumped.constant_pool.dump.some((row) => row.tag === "methodref" && row.value.includes("java/lang/Object")))

const evil = evilClass()
const evilReport = ok(api.class_inspect(evil.bytes, "{}"))
const kinds = evilReport.findings.map((f) => f.kind)
for (const kind of ["process_spawn", "unsafe_usage", "reflection", "class_loader_define", "serialization_method", "serializable", "native_method"]) {
  assert.ok(kinds.includes(kind), `missing ${kind} in ${JSON.stringify(kinds)}`)
}
const execFinding = evilReport.findings.find((f) => f.detail.includes("Runtime.exec"))
assert.equal(execFinding.cp_index, evil.exec)
assert.ok(evilReport.findings.some((f) => f.cp_index === evil.unsafe && f.kind === "unsafe_usage"))
assert.ok(evilReport.findings.some((f) => f.cp_index === evil.forName && f.kind === "reflection"))
assert.ok(evilReport.findings.some((f) => f.cp_index === evil.define && f.kind === "class_loader_define"))

// ---------- class_disassemble ----------

const disasm = ok(api.class_disassemble(clazz, "{}"))
assert.equal(disasm.this_class, "com/example/Foo")
assert.equal(disasm.methods_total, 2)
assert.equal(disasm.methods_selected, 2)
const initText = disasm.methods[0].text
assert.ok(initText.includes("aload_0"), initText)
assert.ok(initText.includes("invokespecial #"), initText)
assert.ok(initText.includes("// Method java/lang/Object.<init>:()V"), initText)
assert.ok(initText.includes('// String "hello world"'), initText)
assert.ok(initText.trimEnd().endsWith("return"), initText)

const oneMethod = ok(api.class_disassemble(clazz, '{"method_index":1}'))
assert.equal(oneMethod.methods_selected, 1)
assert.equal(oneMethod.methods[0].name, "main")
const byName = ok(api.class_disassemble(clazz, '{"method_name":"<init>"}'))
assert.equal(byName.methods[0].name, "<init>")
failing(api.class_disassemble(clazz, '{"method_name":"nope"}'), "method_not_found")
failing(api.class_disassemble(clazz, '{"method_index":42}'), "method_not_found")

// Unknown opcode -> explicit WARNING line.
const badPool = new Pool()
const badThis = badPool.namedClass("com/example/Bad")
const badSuper = badPool.namedClass("java/lang/Object")
const badName = badPool.utf8("m")
const badDesc = badPool.utf8("()V")
const badCode = badPool.utf8("Code")
const badClass = classBytes({
  pool: badPool,
  thisClass: badThis,
  superClass: badSuper,
  methods: [
    member(0x0001, badName, badDesc, [[badCode, codeAttr(1, 1, new Uint8Array([0x2a, 0xcb, 0xb1]))]]),
    member(0x0001, badName, badDesc, [[badCode, codeAttr(1, 1, new Uint8Array([0xb6, 0x00]))]]),
  ],
})
const badDisasm = ok(api.class_disassemble(badClass, "{}"))
assert.ok(badDisasm.methods[0].text.includes("// WARNING: unknown opcode 0xcb"), badDisasm.methods[0].text)
assert.ok(badDisasm.methods[1].text.includes("// WARNING: truncated operand for invokevirtual"), badDisasm.methods[1].text)
assert.ok(badDisasm.warnings.length >= 2)

// ---------- jar_inspect ----------

const jar = testJar(clazz)
const jarReport = ok(api.jar_inspect(jar, "{}"))
assert.equal(jarReport.format, "jar")
assert.equal(jarReport.entries_total, 6)
assert.equal(jarReport.class_entries, 2)
assert.equal(jarReport.signed, true)
assert.equal(jarReport.module_info, "module-info.class")
assert.ok(jarReport.signing_files.some((f) => f.name === "META-INF/TEST.SF"))
assert.ok(jarReport.signing_files.some((f) => f.name === "META-INF/TEST.RSA"))
assert.equal(jarReport.manifest.present, true)
assert.equal(jarReport.manifest.main_attributes["Main-Class"], "com.example.Foo")
assert.ok(jarReport.manifest.digest_attributes.includes("SHA-256-Digest"))
assert.ok(jarReport.manifest.text.includes("Manifest-Version"))
const classEntry = jarReport.entries.find((e) => e.name === "com/example/Foo.class")
assert.equal(classEntry.is_class, true)
assert.equal(classEntry.method, "deflated")

const selected = ok(api.jar_inspect(jar, `{"entry_index":${classEntry.index}}`))
assert.equal(selected.selected_entry.name, "com/example/Foo.class")
assert.equal(selected.selected_entry.is_class, true)
assert.equal(selected.selected_entry.class.this_class, "com/example/Foo")
assert.equal(selected.selected_entry.class.major_version, 52)
const notClass = ok(api.jar_inspect(jar, '{"entry_index":2}'))
assert.equal(notClass.selected_entry.is_class, false)
failing(api.jar_inspect(jar, '{"entry_index":99}'), "entry_not_found")

// ---------- malformed / limits ----------

failing(api.class_inspect(new Uint8Array(0), "{}"), "empty_input")
failing(api.class_inspect(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 52, 0, 1]), "{}"), "bad_magic")
failing(api.class_inspect(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 3, 1, 0, 5, 0x41]), "{}"), "truncated_class")
failing(api.class_inspect(concat(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 2, 0x7f, 0]), new Uint8Array(10)), "{}"), "bad_constant_pool")
failing(api.class_inspect(clazz, "{"), "invalid_options")
failing(api.class_inspect(clazz, "[]"), "invalid_options")
failing(api.class_inspect(clazz, `{${" ".repeat(4100)}}`), "options_too_large")
const tooBig = new Uint8Array(33_554_433)
tooBig.set([0xca, 0xfe, 0xba, 0xbe])
failing(api.class_inspect(tooBig, "{}"), "input_too_large")
failing(api.jar_inspect(encoder.encode("not a zip"), "{}"), "bad_zip")
failing(api.class_disassemble(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), "{}"), "truncated_class")

// ---------- determinism ----------

assert.equal(api.class_inspect(clazz, "{}"), api.class_inspect(clazz, "{}"))
assert.equal(api.class_disassemble(clazz, "{}"), api.class_disassemble(clazz, "{}"))
assert.equal(api.jar_inspect(jar, "{}"), api.jar_inspect(jar, "{}"))
assert.equal(api.jar_inspect(jar, `{"entry_index":${classEntry.index}}`), api.jar_inspect(jar, `{"entry_index":${classEntry.index}}`))

console.log("java-inspect WASM compatibility verified")
