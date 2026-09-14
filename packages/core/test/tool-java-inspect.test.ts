import { describe, expect } from "bun:test"
import { deflateRawSync } from "node:zlib"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { JavaInspectRuntime } from "@turenlabs/core/tool/java-inspect-runtime"
import { JavaInspectTools } from "@turenlabs/core/tool/java-inspect-tools"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(Layer.empty)

// .class fabricator and minimal ZIP/JAR writer ported from wasm-tools
// tools/java-inspect/test/verify.mjs (JVMS §4 layout, assembled by hand).
const encoder = new TextEncoder()
const u16 = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff])
const u32 = (v: number) =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

class Pool {
  items: Uint8Array[] = []
  push(encoded: Uint8Array) {
    this.items.push(encoded)
    return this.items.length // 1-based index
  }
  utf8(text: string) {
    const bytes = encoder.encode(text)
    return this.push(concat(new Uint8Array([1]), u16(bytes.length), bytes))
  }
  namedClass(name: string) {
    return this.push(concat(new Uint8Array([7]), u16(this.utf8(name))))
  }
  string(text: string) {
    return this.push(concat(new Uint8Array([8]), u16(this.utf8(text))))
  }
  nat(name: string, desc: string) {
    return this.push(concat(new Uint8Array([12]), u16(this.utf8(name)), u16(this.utf8(desc))))
  }
  methodref(owner: string, name: string, desc: string) {
    return this.push(concat(new Uint8Array([10]), u16(this.namedClass(owner)), u16(this.nat(name, desc))))
  }
  bytes() {
    // JVMS constant_pool_count includes the reserved index 0.
    return concat(u16(this.items.length + 1), ...this.items)
  }
}

const member = (access: number, name: number, desc: number, attrs: [number, Uint8Array][] = []) =>
  concat(
    u16(access),
    u16(name),
    u16(desc),
    u16(attrs.length),
    ...attrs.map(([nameIndex, body]) => concat(u16(nameIndex), u32(body.length), body)),
  )

const codeAttr = (maxStack: number, maxLocals: number, code: Uint8Array) =>
  concat(u16(maxStack), u16(maxLocals), u32(code.length), code, u16(0), u16(0))

const classBytes = (input: {
  minor?: number
  major?: number
  pool: Pool
  access?: number
  thisClass: number
  superClass: number
  interfaces?: number[]
  fields?: Uint8Array[]
  methods?: Uint8Array[]
  attrs?: [number, Uint8Array][]
}) =>
  concat(
    new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
    u16(input.minor ?? 0),
    u16(input.major ?? 52),
    input.pool.bytes(),
    u16(input.access ?? 0x0021),
    u16(input.thisClass),
    u16(input.superClass),
    u16((input.interfaces ?? []).length),
    ...(input.interfaces ?? []).map(u16),
    u16((input.fields ?? []).length),
    ...(input.fields ?? []),
    u16((input.methods ?? []).length),
    ...(input.methods ?? []),
    u16((input.attrs ?? []).length),
    ...(input.attrs ?? []).map(([nameIndex, body]) => concat(u16(nameIndex), u32(body.length), body)),
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
    0xb7,
    (initRef >> 8) & 0xff,
    initRef & 0xff, // invokespecial #initRef
    0x12,
    hello & 0xff, // ldc #hello
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

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const u16le = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff])
const u32le = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff])

const zipEntry = (name: string, content: Uint8Array, options: { deflate?: boolean } = {}) => {
  const nameBytes = encoder.encode(name)
  const deflate = options.deflate ?? false
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
  return { nameBytes, crc, data, content, deflate, local }
}

const buildJar = (entries: ReturnType<typeof zipEntry>[]) => {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
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

describe("JavaInspectRuntime and JavaInspectTools", () => {
  it.live("inspects class and jar fixtures through a fresh java-inspect worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const clazz = helloWorld()
          const jar = buildJar([
            zipEntry(
              "META-INF/MANIFEST.MF",
              encoder.encode("Manifest-Version: 1.0\r\nMain-Class: com.example.Foo\r\n"),
            ),
            zipEntry("com/example/Foo.class", clazz, { deflate: true }),
            zipEntry("META-INF/TEST.SF", encoder.encode("Signature-Version: 1.0\r\n")),
          ])
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(`${tmp.path}/Foo.class`, clazz),
              Bun.write(`${tmp.path}/app.jar`, jar),
              Bun.write(`${tmp.path}/garbage.bin`, encoder.encode("not a class")),
            ]),
          )

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["class_inspect", "class_disassemble", "jar_inspect"]) expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_java_inspect_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspected = yield* call("call-class-inspect", "class_inspect", { path: "Foo.class" })
          expect(inspected.type).toBe("text")
          if (inspected.type !== "text") return
          expect(inspected.value).toContain('"schema_version": 1')
          expect(inspected.value).toContain('"format": "class"')
          expect(inspected.value).toContain('"major_version": 52')
          expect(inspected.value).toContain('"jdk": "Java SE 8"')
          expect(inspected.value).toContain('"this_class": "com/example/Foo"')
          expect(inspected.value).toContain('"super_class": "java/lang/Object"')
          expect(inspected.value).toContain('"source_file": "Foo.java"')
          expect(inspected.value).toContain('"methods_total": 2')

          const disassembled = yield* call("call-class-disassemble", "class_disassemble", { path: "Foo.class" })
          expect(disassembled.type).toBe("text")
          if (disassembled.type !== "text") return
          expect(disassembled.value).toContain('"methods_total": 2')
          expect(disassembled.value).toContain('"methods_selected": 2')
          expect(disassembled.value).toContain("aload_0")
          expect(disassembled.value).toContain("invokespecial #")
          expect(disassembled.value).toContain("// Method java/lang/Object.<init>:()V")

          const jarred = yield* call("call-jar-inspect", "jar_inspect", { path: "app.jar" })
          expect(jarred.type).toBe("text")
          if (jarred.type !== "text") return
          expect(jarred.value).toContain('"format": "jar"')
          expect(jarred.value).toContain('"entries_total": 3')
          expect(jarred.value).toContain('"class_entries": 1')
          expect(jarred.value).toContain('"signed": true')
          expect(jarred.value).toContain('"Main-Class": "com.example.Foo"')
          expect(jarred.value).toContain('"name": "META-INF/TEST.SF"')

          const selected = yield* call("call-jar-inspect-entry", "jar_inspect", {
            path: "app.jar",
            entryIndex: 1,
          })
          expect(selected.type).toBe("text")
          if (selected.type !== "text") return
          expect(selected.value).toContain('"name": "com/example/Foo.class"')
          expect(selected.value).toContain('"is_class": true')
          expect(selected.value).toContain('"this_class": "com/example/Foo"')

          const failed = yield* call("call-class-inspect-bad", "class_inspect", { path: "garbage.bin" })
          expect(failed.type).toBe("error")
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                ToolRegistry.node,
                ToolRegistry.toolsNode,
                LocationMutation.node,
                JavaInspectRuntime.node,
                JavaInspectTools.node,
              ]),
              [
                [
                  Location.node,
                  Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
                ],
                [PermissionV2.node, permission],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
