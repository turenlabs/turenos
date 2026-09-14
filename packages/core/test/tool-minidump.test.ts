import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { MinidumpRuntime } from "@turenlabs/core/tool/minidump-runtime"
import { MinidumpTools } from "@turenlabs/core/tool/minidump-tools"
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

const provide = (tmp: { path: string }) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        LocationMutation.node,
        MinidumpRuntime.node,
        MinidumpTools.node,
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
  )

// Fabricate a minimal MDMP in memory: header + 5 streams + tail blobs.
const STACK_BASE = 0x7fff0000
const STREAM_SYSINFO = 7
const STREAM_MODULES = 4
const STREAM_THREADS = 3
const STREAM_EXCEPTION = 6
const STREAM_MEMORY = 5

function utf16Blob(text: string) {
  const buf = Buffer.alloc(4 + text.length * 2)
  buf.writeUInt32LE(text.length * 2, 0)
  for (let i = 0; i < text.length; i++) buf.writeUInt16LE(text.charCodeAt(i), 4 + i * 2)
  return buf
}

function sampleDump() {
  const csd = utf16Blob("Service Pack 1")
  const name1 = utf16Blob("app.exe")
  const name2 = utf16Blob("ntdll.dll")
  const stack = Buffer.alloc(256, 0xab)
  const ctxLen = 716
  const ctx = Buffer.alloc(ctxLen)
  ctx.writeUInt32LE(0x00010007, 0) // CONTEXT_X86 | CONTROL | INTEGER | SEGMENTS
  ctx.writeUInt32LE(0x11223344, 176) // eax
  ctx.writeUInt32LE(0x00401234, 184) // eip
  ctx.writeUInt32LE(STACK_BASE + 0x80, 196) // esp
  const excCtx = Buffer.from(ctx)

  const sysinfoLen = 56
  const moduleLen = 4 + 2 * 108
  const threadLen = 4 + 48
  const exceptionLen = 168
  const memoryLen = 4 + 16
  const headerLen = 32
  const dirLen = 5 * 12
  let rva = headerLen + dirLen
  const sysinfoRva = rva
  rva += sysinfoLen
  const modulesRva = rva
  rva += moduleLen
  const threadsRva = rva
  rva += threadLen
  const exceptionRva = rva
  rva += exceptionLen
  const memoryRva = rva
  rva += memoryLen
  const csdRva = rva
  rva += csd.length
  const name1Rva = rva
  rva += name1.length
  const name2Rva = rva
  rva += name2.length
  const stackRva = rva
  rva += stack.length
  const ctxRva = rva
  rva += ctx.length
  const excCtxRva = rva

  const sysinfo = Buffer.alloc(sysinfoLen)
  sysinfo.writeUInt16LE(0, 0) // arch x86
  sysinfo.writeUInt16LE(6, 2) // level
  sysinfo.writeUInt16LE(0x1a01, 4) // revision
  sysinfo.writeUInt8(4, 6) // number_of_processors
  sysinfo.writeUInt8(1, 7) // product_type
  sysinfo.writeUInt32LE(10, 8) // major
  sysinfo.writeUInt32LE(0, 12) // minor
  sysinfo.writeUInt32LE(19045, 16) // build
  sysinfo.writeUInt32LE(2, 20) // platform WIN32_NT
  sysinfo.writeUInt32LE(csdRva, 24) // csd_version_rva
  sysinfo.writeUInt16LE(0x100, 28) // suite_mask

  const modList = Buffer.alloc(moduleLen)
  modList.writeUInt32LE(2, 0)
  const names = [name1Rva, name2Rva]
  for (let i = 0; i < 2; i++) {
    const off = 4 + i * 108
    modList.writeBigUInt64LE(BigInt(0x400000 + i * 0x100000), off)
    modList.writeUInt32LE(0x20000, off + 8) // size_of_image
    modList.writeUInt32LE(0, off + 12) // checksum
    modList.writeUInt32LE(0x5f00, off + 16) // time_date_stamp
    modList.writeUInt32LE(names[i], off + 20) // module_name_rva
  }

  const threads = Buffer.alloc(threadLen)
  threads.writeUInt32LE(1, 0)
  threads.writeUInt32LE(0x1234, 4) // thread_id
  threads.writeBigUInt64LE(BigInt(0x7ff00000), 20) // teb
  threads.writeBigUInt64LE(BigInt(STACK_BASE), 28) // stack start
  threads.writeUInt32LE(stack.length, 36)
  threads.writeUInt32LE(stackRva, 40)
  threads.writeUInt32LE(ctxLen, 44)
  threads.writeUInt32LE(ctxRva, 48)

  const exc = Buffer.alloc(exceptionLen)
  exc.writeUInt32LE(0x1234, 0) // thread_id
  exc.writeUInt32LE(0xc0000005, 8) // EXCEPTION_ACCESS_VIOLATION
  exc.writeBigUInt64LE(BigInt(0x00401234), 24) // exception_address
  exc.writeUInt32LE(2, 32) // number_parameters
  exc.writeBigUInt64LE(1n, 40) // info[0] = write
  exc.writeBigUInt64LE(BigInt(0xdeadbeef), 48) // info[1] = fault address
  exc.writeUInt32LE(ctxLen, 160)
  exc.writeUInt32LE(excCtxRva, 164)

  const mem = Buffer.alloc(memoryLen)
  mem.writeUInt32LE(1, 0)
  mem.writeBigUInt64LE(BigInt(STACK_BASE), 4)
  mem.writeUInt32LE(stack.length, 12)
  mem.writeUInt32LE(stackRva, 16)

  const streams: Array<readonly [number, Buffer, number]> = [
    [STREAM_SYSINFO, sysinfo, sysinfoRva],
    [STREAM_MODULES, modList, modulesRva],
    [STREAM_THREADS, threads, threadsRva],
    [STREAM_EXCEPTION, exc, exceptionRva],
    [STREAM_MEMORY, mem, memoryRva],
  ]

  const dump = Buffer.alloc(rva + excCtx.length)
  dump.write("MDMP", 0, "ascii")
  dump.writeUInt32LE(0xa793, 4) // version
  dump.writeUInt32LE(streams.length, 8) // stream_count
  dump.writeUInt32LE(headerLen, 12) // directory rva
  dump.writeUInt32LE(0, 16) // checksum
  dump.writeUInt32LE(1700000000, 20) // time_date_stamp
  for (const [index, [type, data, at]] of streams.entries()) {
    const dOff = headerLen + index * 12
    dump.writeUInt32LE(type, dOff)
    dump.writeUInt32LE(data.length, dOff + 4)
    dump.writeUInt32LE(at, dOff + 8)
    data.copy(dump, at)
  }
  csd.copy(dump, csdRva)
  name1.copy(dump, name1Rva)
  name2.copy(dump, name2Rva)
  stack.copy(dump, stackRva)
  ctx.copy(dump, ctxRva)
  excCtx.copy(dump, excCtxRva)
  return new Uint8Array(dump)
}

describe("MinidumpRuntime and MinidumpTools", () => {
  it.live("inspects, lists modules, decodes streams, and reads memory through a fresh minidump worker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${tmp.path}/sample.dmp`, sampleDump()))
          const garbage = new Uint8Array(64)
          garbage.set([0x4e, 0x4f, 0x50, 0x45], 0)
          yield* Effect.promise(() => Bun.write(`${tmp.path}/garbage.dmp`, garbage))

          const registry = yield* ToolRegistry.Service
          const names = (yield* toolDefinitions(registry)).map((tool) => tool.name)
          for (const name of ["minidump_inspect", "minidump_modules", "minidump_stream", "minidump_memory_read"])
            expect(names).toContain(name)

          const call = (id: string, name: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: SessionV2.ID.make("ses_minidump_test"),
              ...toolIdentity,
              call: { type: "tool-call", id, name, input },
            })

          const inspect = yield* call("call-minidump-inspect", "minidump_inspect", { path: "sample.dmp" })
          expect(inspect.type).toBe("text")
          if (inspect.type !== "text") return
          expect(inspect.value).toContain('"schema_version": 1')
          expect(inspect.value).toContain('"valid": true')
          expect(inspect.value).toContain('"os": "windows"')
          expect(inspect.value).toContain('"csd_version": "Service Pack 1"')
          expect(inspect.value).toContain('"exception_code": "0xc0000005"')
          expect(inspect.value).toContain('"crash_address": "0xdeadbeef"')

          const modules = yield* call("call-minidump-modules", "minidump_modules", { path: "sample.dmp" })
          expect(modules.type).toBe("text")
          if (modules.type !== "text") return
          expect(modules.value).toContain('"count": 2')
          expect(modules.value).toContain('"name": "app.exe"')
          expect(modules.value).toContain('"name": "ntdll.dll"')

          const stream = yield* call("call-minidump-stream", "minidump_stream", {
            path: "sample.dmp",
            stream: STREAM_SYSINFO,
          })
          expect(stream.type).toBe("text")
          if (stream.type !== "text") return
          expect(stream.value).toContain('"decoded": true')
          expect(stream.value).toContain('"os": "windows"')

          const memory = yield* call("call-minidump-memory-read", "minidump_memory_read", {
            path: "sample.dmp",
            address: STACK_BASE,
            length: 16,
          })
          expect(memory.type).toBe("text")
          if (memory.type !== "text") return
          expect(memory.value).toContain('"coverage": "full"')
          expect(memory.value).toContain('"bytes_read": 16')

          const failed = yield* call("call-minidump-inspect-garbage", "minidump_inspect", { path: "garbage.dmp" })
          expect(failed.type).toBe("error")
        }).pipe(provide(tmp)),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
