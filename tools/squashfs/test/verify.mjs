import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2])
const api = await import(`${pathToFileURL(path.join(directory, "turen_squashfs_wasm.js")).href}?${Date.now()}`)
await api.default({ module_or_path: await fs.readFile(path.join(directory, "turen_squashfs_wasm_bg.wasm")) })

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const fixture = await fs.readFile(path.join(fixtures, "fixture-gzip.sqfs")).catch(() => {
  throw new Error("missing test/fixtures/*.sqfs; generate them with `DUMP_FIXTURES=1 cargo test`")
})
const padded = await fs.readFile(path.join(fixtures, "fixture-padded.sqfs"))

const PASSWD = "root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/sbin/nologin\nnobody:x:99:99:nobody:/:/sbin/nologin\n"
const PASSWD_SHA256 = "84e1b53a03ceca5913fc4877e27e54a3aab808c418a3e93b1d5d7b9eefff9133"

let checks = 0
const ok = (...args) => { assert.ok(...args); checks += 1 }
const eq = (...args) => { assert.deepEqual(...args); checks += 1 }

function thrownCode(fn) {
  try {
    fn()
  } catch (error) {
    const parsed = JSON.parse(error.message)
    eq(parsed.schema_version, 1)
    ok(typeof parsed.error === "string" && parsed.error.length > 0)
    return parsed
  }
  throw new Error("expected an error")
}

// ---- list: superblock and full entry table --------------------------------
const report = JSON.parse(api.squashfs_list(fixture, "{}"))
eq(report.schema_version, 1)
eq(report.kind, "le_v4_0")
eq(report.magic, "hsqs")
eq(report.versionMajor, 4)
eq(report.versionMinor, 0)
eq(report.compression, "gzip")
eq(report.compressionSupported, true)
eq(report.modTime, 1704067200)
eq(report.blockSize > 0, true)
eq(report.inodeCount > 10, true)
eq(report.truncated, false)

const paths = report.entries.map((entry) => entry.path)
eq(paths.length, 24)
for (const wanted of ["/", "/etc", "/etc/passwd", "/etc/hosts", "/etc/init.d", "/etc/init.d/rcS", "/bin/big.bin", "/data/f00.txt", "/data/f07.txt", "/dev/null", "/dev/loop0", "/dev/fifo0", "/dev/log.sock", "/passwd-link"]) {
  ok(paths.includes(wanted), `missing ${wanted}`)
}
const byPath = Object.fromEntries(report.entries.map((entry) => [entry.path, entry]))
eq(byPath["/etc/passwd"].type, "file")
eq(byPath["/etc/passwd"].size, PASSWD.length)
eq(byPath["/etc/passwd"].mode, "0644")
eq(byPath["/etc"].type, "dir")
eq(byPath["/passwd-link"].type, "symlink")
eq(byPath["/passwd-link"].linkTarget, "/etc/passwd")
eq(byPath["/dev/null"].type, "chardev")
eq(byPath["/dev/null"].deviceNumber, 0x0103)
eq(byPath["/dev/loop0"].type, "blockdev")
eq(byPath["/dev/fifo0"].type, "fifo")
eq(byPath["/dev/log.sock"].type, "socket")

// ---- list: filters and bounds ---------------------------------------------
const filtered = JSON.parse(api.squashfs_list(fixture, JSON.stringify({ pathFilter: "/etc" })))
ok(filtered.entries.every((entry) => entry.path.startsWith("/etc")))
ok(filtered.entries.some((entry) => entry.path === "/etc/init.d/rcS"))
ok(!filtered.entries.some((entry) => entry.path === "/passwd-link"))

const capped = JSON.parse(api.squashfs_list(fixture, JSON.stringify({ maxResults: 2 })))
eq(capped.entries.length, 2)
eq(capped.truncated, true)
eq(capped.entryCount, 24)

// ---- extract: exact path, one entry, bytes only ---------------------------
const extracted = JSON.parse(api.squashfs_extract(fixture, JSON.stringify({ path: "/etc/passwd" })))
eq(extracted.schema_version, 1)
eq(extracted.path, "/etc/passwd")
eq(extracted.type, "file")
eq(extracted.size, PASSWD.length)
eq(extracted.sha256, PASSWD_SHA256)
eq(extracted.truncated, false)
eq(Buffer.from(extracted.contentBase64, "base64").toString(), PASSWD)

const big = JSON.parse(api.squashfs_extract(fixture, JSON.stringify({ path: "/bin/big.bin" })))
eq(big.size, 200000)
eq(big.truncated, false)

const preview = JSON.parse(api.squashfs_extract(fixture, JSON.stringify({ path: "/bin/big.bin", maxBytes: 64 })))
eq(preview.size, 64)
eq(preview.truncated, true)
eq(preview.declaredSize, 200000)
eq(Buffer.from(preview.contentBase64, "base64").length, 64)

// ---- extract: non-file and missing entries are explicit errors ------------
for (const [entryPath, kind] of [["/etc", "dir"], ["/passwd-link", "symlink"], ["/dev/null", "chardev"], ["/dev/loop0", "blockdev"], ["/dev/fifo0", "fifo"], ["/dev/log.sock", "socket"]]) {
  const error = thrownCode(() => api.squashfs_extract(fixture, JSON.stringify({ path: entryPath })))
  eq(error.error, "entry_not_file")
  eq(error.entryType, kind)
}
eq(thrownCode(() => api.squashfs_extract(fixture, JSON.stringify({ path: "/etc/shadow" }))).error, "not_found")
eq(thrownCode(() => api.squashfs_extract(fixture, JSON.stringify({ path: "/etc/../passwd" }))).error, "invalid_path")

// ---- embedded image at a nonzero offset ------------------------------------
eq(thrownCode(() => api.squashfs_list(padded, "{}")).error, "not_squashfs")
const embedded = JSON.parse(api.squashfs_list(padded, JSON.stringify({ offset: 4096 })))
eq(embedded.kind, "le_v4_0")
eq(embedded.entries.length, 24)
const embeddedFile = JSON.parse(api.squashfs_extract(padded, JSON.stringify({ offset: 4096, path: "/etc/passwd" })))
eq(embeddedFile.sha256, PASSWD_SHA256)

// ---- malformed, unsupported, and bounded inputs ----------------------------
eq(thrownCode(() => api.squashfs_list(new Uint8Array([1, 2, 3]), "{}")).error, "not_squashfs")
const truncated = fixture.subarray(0, 64)
ok(["truncated_image", "invalid_image"].includes(thrownCode(() => api.squashfs_list(truncated, "{}")).error))

const xzImage = new Uint8Array(fixture)
xzImage[20] = 4 // v4 superblock compressor id 4 = xz
const xzError = thrownCode(() => api.squashfs_list(xzImage, "{}"))
eq(xzError.error, "unsupported_compression")
eq(xzError.compressor, "xz")

const lzoImage = new Uint8Array(fixture)
lzoImage[20] = 3
eq(thrownCode(() => api.squashfs_list(lzoImage, "{}")).error, "unsupported_compression")

const wrongVersion = new Uint8Array(fixture)
wrongVersion[28] = 9
const versionError = thrownCode(() => api.squashfs_list(wrongVersion, "{}"))
eq(versionError.error, "unsupported_version")
eq(versionError.versionMajor, 9)

eq(thrownCode(() => api.squashfs_list(new Uint8Array(32 * 1024 * 1024 + 1), "{}")).error, "input_too_large")
eq(thrownCode(() => api.squashfs_list(fixture, "x".repeat(4097))).error, "options_too_large")
eq(thrownCode(() => api.squashfs_list(fixture, "not json")).error, "invalid_options")

// ---- determinism -----------------------------------------------------------
eq(api.squashfs_list(fixture, "{}"), api.squashfs_list(fixture, "{}"))
eq(api.squashfs_extract(fixture, JSON.stringify({ path: "/etc/passwd" })), api.squashfs_extract(fixture, JSON.stringify({ path: "/etc/passwd" })))

console.log(`squashfs WASM verified (${checks} checks)`)
