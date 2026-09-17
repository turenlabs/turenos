import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const directory = path.resolve(process.argv[2])
const api = await import(`${pathToFileURL(path.join(directory, "turen_installer_inspect_wasm.js")).href}?${Date.now()}`)
await api.default({ module_or_path: await fs.readFile(path.join(directory, "turen_installer_inspect_wasm_bg.wasm")) })

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const readFixture = (name) =>
  fs.readFile(path.join(fixtures, name)).catch(() => {
    throw new Error(`missing test/fixtures/${name}; generate with \`DUMP_FIXTURES=1 cargo test\``)
  })
const msi = await readFixture("minimal.msi")
const cabStored = await readFixture("stored.cab")
const cabMszip = await readFixture("mszip.cab")
const cabQuantum = await readFixture("quantum.cab")
const cabBadFolder = await readFixture("bad-folder.cab")
const cfbCycle = await readFixture("dir-cycle.cfb")

const EVIL_DLL = Buffer.from("4d5a9000666978747572652d646c6c2d7061796c6f6164", "hex")
const EVIL_DLL_SHA256 = createHash("sha256").update(EVIL_DLL).digest("hex")
const README_TXT = "Hello cabinet, this is a stored file.\n"
const LOADER_JS = "var x = new ActiveXObject('WScript.Shell'); x.Run('calc');\n"

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

// ---- msi_inspect -----------------------------------------------------------
const report = JSON.parse(api.msi_inspect(msi, "{}"))
eq(report.schema_version, 1)
eq(report.format, "msi")
eq(report.isMsi, true)
eq(report.package.type, "installer")
eq(report.properties.ProductCode, "{12345678-1234-1234-1234-1234567890AB}")
eq(report.properties.UpgradeCode, "{ABCDEF00-0000-0000-0000-0000000000FF}")
eq(report.cfb.rootClsid, "000C1084-0000-0000-C000-000000000046")
ok(report.cfb.entryCount >= 3)

const tableNames = report.tables.map((table) => table.name)
for (const wanted of ["Property", "CustomAction", "InstallExecuteSequence", "File", "ServiceInstall", "Registry"]) {
  ok(tableNames.includes(wanted), `missing table ${wanted}`)
}
const propTable = report.tables.find((table) => table.name === "Property")
eq(propTable.rowCount, 3)
eq(propTable.rows.length, 3)

const evilStream = report.streams.find((stream) => stream.name === "evil.dll")
ok(evilStream, "missing evil.dll stream")
eq(evilStream.size, EVIL_DLL.length)
eq(evilStream.sha256, EVIL_DLL_SHA256)

const cas = report.customActions
eq(cas.length, 3)
const dllAction = cas.find((action) => action.action === "RunEmbeddedDll")
eq(dllAction.decoded.kind, "dll")
eq(dllAction.decoded.location, "binary")
ok(dllAction.decoded.flags.includes("inScript"))
const scriptAction = cas.find((action) => action.action === "RunScript")
eq(scriptAction.decoded.kind, "vbscript")
eq(scriptAction.decoded.location, "inlineText")
ok(scriptAction.decoded.flags.includes("noImpersonate"))

const sequence = report.sequences.InstallExecuteSequence
eq(sequence.map((item) => item.sequence), [4000, 6200, 6600])

const findingKinds = report.findings.map((finding) => finding.kind)
ok(findingKinds.includes("customActionPayload"))
ok(findingKinds.includes("suspiciousCustomActionTarget"))
ok(findingKinds.includes("serviceInstall"))
ok(findingKinds.includes("registryPersistenceKey"))

// ---- msi_stream_read -------------------------------------------------------
const stream = JSON.parse(api.msi_stream_read(msi, JSON.stringify({ stream: "evil.dll" })))
eq(stream.schema_version, 1)
eq(stream.size, EVIL_DLL.length)
eq(stream.declaredSize, EVIL_DLL.length)
eq(stream.sha256, EVIL_DLL_SHA256)
eq(stream.truncated, false)
eq(Buffer.from(stream.contentBase64, "base64").compare(EVIL_DLL), 0)

const preview = JSON.parse(api.msi_stream_read(msi, JSON.stringify({ stream: "evil.dll", maxBytes: 4 })))
eq(preview.size, 4)
eq(preview.truncated, true)
eq(Buffer.from(preview.contentBase64, "base64").compare(EVIL_DLL.subarray(0, 4)), 0)

const rawPath = JSON.parse(api.msi_stream_read(msi, JSON.stringify({ stream: "\u0005SummaryInformation" })))
ok(rawPath.size > 16)

eq(thrownCode(() => api.msi_stream_read(msi, JSON.stringify({ stream: "nope.bin" }))).error, "stream_not_found")
eq(thrownCode(() => api.msi_stream_read(msi, "{}")).error, "invalid_options")

// ---- cab_list --------------------------------------------------------------
const listing = JSON.parse(api.cab_list(cabStored, "{}"))
eq(listing.schema_version, 1)
eq(listing.format, "cabinet")
eq(listing.version, "1.3")
eq(listing.folderCount, 1)
eq(listing.fileCount, 2)
eq(listing.setId, 0x4242)
eq(listing.folders[0].compression.scheme, "none")
eq(listing.folders[0].compressionSupported, true)
const readme = listing.files.find((file) => file.name === "readme.txt")
eq(readme.size, README_TXT.length)
eq(readme.compression, "none")
eq(readme.folderOffset, 0)
eq(listing.files.find((file) => file.name === "loader.js").folderOffset, README_TXT.length)

const mszipListing = JSON.parse(api.cab_list(cabMszip, "{}"))
eq(mszipListing.folders[0].compression.scheme, "mszip")
const quantumListing = JSON.parse(api.cab_list(cabQuantum, "{}"))
eq(quantumListing.folders[0].compression.scheme, "quantum")
eq(quantumListing.folders[0].compressionSupported, false)

// ---- cab_extract -----------------------------------------------------------
const extracted = JSON.parse(api.cab_extract(cabStored, JSON.stringify({ file: "readme.txt" })))
eq(extracted.schema_version, 1)
eq(extracted.compression, "none")
eq(extracted.size, README_TXT.length)
eq(extracted.truncated, false)
eq(Buffer.from(extracted.contentBase64, "base64").toString(), README_TXT)
eq(extracted.sha256, createHash("sha256").update(README_TXT).digest("hex"))

const mszipOut = JSON.parse(api.cab_extract(cabMszip, JSON.stringify({ file: "loader.js" })))
eq(mszipOut.compression, "mszip")
eq(Buffer.from(mszipOut.contentBase64, "base64").toString(), LOADER_JS)

const cappedExtract = JSON.parse(api.cab_extract(cabStored, JSON.stringify({ file: "readme.txt", maxBytes: 4 })))
eq(cappedExtract.size, 4)
eq(cappedExtract.truncated, true)
eq(cappedExtract.declaredSize, README_TXT.length)

eq(thrownCode(() => api.cab_extract(cabQuantum, JSON.stringify({ file: "readme.txt" }))).error, "unsupported_compression")
eq(thrownCode(() => api.cab_extract(cabBadFolder, JSON.stringify({ file: "readme.txt" }))).error, "invalid_cabinet")
eq(thrownCode(() => api.cab_extract(cabStored, JSON.stringify({ file: "missing.txt" }))).error, "file_not_found")

// ---- malformed inputs ------------------------------------------------------
eq(thrownCode(() => api.msi_inspect(new Uint8Array([1, 2, 3, 4]), "{}")).error, "not_cfb")
eq(thrownCode(() => api.msi_inspect(msi.subarray(0, 700), "{}")).error, "invalid_cfb")
eq(thrownCode(() => api.msi_inspect(cfbCycle, "{}")).error, "invalid_cfb")

const badMagic = new Uint8Array(cabStored)
badMagic.set([78, 79, 80, 69], 0)
eq(thrownCode(() => api.cab_list(badMagic, "{}")).error, "not_cabinet")
eq(thrownCode(() => api.cab_list(cabStored.subarray(0, 20), "{}")).error, "truncated_cabinet")
eq(thrownCode(() => api.cab_list(cabStored.subarray(0, 44 + 5), "{}")).error, "truncated_cabinet")

// ---- oversized input / options ---------------------------------------------
eq(thrownCode(() => api.msi_inspect(new Uint8Array(32 * 1024 * 1024 + 1), "{}")).error, "input_too_large")
eq(thrownCode(() => api.cab_list(new Uint8Array(32 * 1024 * 1024 + 1), "{}")).error, "input_too_large")
eq(thrownCode(() => api.cab_extract(new Uint8Array(32 * 1024 * 1024 + 1), "{}")).error, "input_too_large")
eq(thrownCode(() => api.msi_stream_read(new Uint8Array(32 * 1024 * 1024 + 1), "{}")).error, "input_too_large")
eq(thrownCode(() => api.cab_list(cabStored, "x".repeat(4097))).error, "options_too_large")
eq(thrownCode(() => api.msi_inspect(msi, "x".repeat(4097))).error, "options_too_large")
eq(thrownCode(() => api.cab_list(cabStored, "not json")).error, "invalid_options")
eq(thrownCode(() => api.cab_list(cabStored, "[1,2]")).error, "invalid_options")

// ---- determinism ------------------------------------------------------------
eq(api.msi_inspect(msi, "{}"), api.msi_inspect(msi, "{}"))
eq(api.cab_list(cabMszip, "{}"), api.cab_list(cabMszip, "{}"))
eq(api.cab_extract(cabMszip, JSON.stringify({ file: "readme.txt" })), api.cab_extract(cabMszip, JSON.stringify({ file: "readme.txt" })))
eq(api.msi_stream_read(msi, JSON.stringify({ stream: "evil.dll" })), api.msi_stream_read(msi, JSON.stringify({ stream: "evil.dll" })))

console.log(`installer-inspect WASM verified (${checks} checks)`)
