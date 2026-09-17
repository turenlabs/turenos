import initMpress, { probe, unpack_mpress, unpack_mpress_metadata } from "./mpress/turen_mpress_wasm.js"

export async function createStaticUnpack(options = {}) {
  await initMpress({ module_or_path: options.mpressWasm })
  return {
    probe: (bytes) => JSON.parse(probe(bytes)),
    unpackMpress: (bytes) => ({
      bytes: unpack_mpress(bytes),
      metadata: JSON.parse(unpack_mpress_metadata(bytes)),
    }),
    unpackUpx: async (bytes) => {
      const createUpx = (await import("./upx.mjs")).default
      const listing = []
      const probeRuntime = await createUpx({
        noInitialRun: true,
        locateFile: options.locateFile,
        print: (line) => listing.push(line),
        printErr: (line) => listing.push(line),
      })
      probeRuntime.FS.writeFile("/input", bytes)
      const probeStatus = callUpx(probeRuntime, ["-l", "/input"])
      if (probeStatus !== 0) throw new Error(listing.join("\n") || `UPX listing failed with status ${probeStatus}`)
      const size = listing.join("\n").match(/^\s*(\d+)\s+->\s+\d+/m)?.[1]
      if (!size) throw new Error("UPX did not report the unpacked size")
      if (Number(size) > 128 * 1024 * 1024) throw new Error("UPX declared output exceeds 128 MiB limit")

      const errors = []
      const runtime = await createUpx({
        noInitialRun: true,
        locateFile: options.locateFile,
        print: () => {},
        printErr: (line) => errors.push(line),
      })
      runtime.FS.writeFile("/input", bytes)
      const status = callUpx(runtime, ["-d", "-q", "-o", "/output", "/input"])
      if (status !== 0) throw new Error(errors.join("\n") || `UPX failed with status ${status}`)
      const output = runtime.FS.readFile("/output")
      if (output.length > 128 * 1024 * 1024) throw new Error("UPX output exceeds 128 MiB limit")
      return {
        bytes: new Uint8Array(output),
        metadata: {
          packer: "upx",
          outputSize: output.length,
          importsRebuilt: true,
          runnable: true,
        },
      }
    },
  }
}

function callUpx(runtime, args) {
  try {
    return runtime.callMain(args)
  } catch (error) {
    return error?.status ?? 1
  }
}
