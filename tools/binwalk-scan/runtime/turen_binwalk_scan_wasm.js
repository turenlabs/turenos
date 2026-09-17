let wasm

export default async function init(input) {
  const source = await input?.module_or_path
  const result = await WebAssembly.instantiate(source, {})
  wasm = result instanceof WebAssembly.Instance ? result.exports : result.instance.exports
  return wasm
}

export function binwalk_scan(bytes, options_json) {
  if (!wasm) throw new Error("binwalk scan WASM is not initialized")
  if (!(bytes instanceof Uint8Array)) throw new TypeError("binwalk scan input must be a Uint8Array")
  if (bytes.byteLength > 32 * 1024 * 1024) return '{"schema_version":1,"error":"input_too_large"}'
  if (typeof options_json !== "string") throw new TypeError("binwalk scan options must be a JSON string")
  if (options_json.length > 1024) return '{"schema_version":1,"error":"options_too_large"}'
  const options = new TextEncoder().encode(options_json)
  const inputPointer = wasm.bw_alloc(bytes.length)
  const optionsPointer = wasm.bw_alloc(options.length)
  try {
    new Uint8Array(wasm.memory.buffer, inputPointer, bytes.length).set(bytes)
    new Uint8Array(wasm.memory.buffer, optionsPointer, options.length).set(options)
    const packed = wasm.bw_scan(inputPointer, bytes.length, optionsPointer, options.length)
    const pointer = Number(packed & 0xffff_ffffn)
    const length = Number(packed >> 32n)
    try {
      return new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, pointer, length))
    } finally {
      wasm.bw_free_result(pointer, length)
    }
  } finally {
    wasm.bw_free(inputPointer, bytes.length)
    wasm.bw_free(optionsPointer, options.length)
  }
}
