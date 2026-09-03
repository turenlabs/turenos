export interface UnpackMetadata {
  packer: "upx" | "mpress"
  version?: string
  method?: string
  outputSize: number
  importsRebuilt: boolean
  runnable: boolean
  entryPoint?: string
}

export interface StaticUnpack {
  probe(bytes: Uint8Array): {
    detected: boolean
    packer?: "upx" | "mpress"
    version?: string
    method?: string
    supported: boolean
    error?: string
  }
  unpackUpx(bytes: Uint8Array): Promise<{ bytes: Uint8Array; metadata: UnpackMetadata }>
  unpackMpress(bytes: Uint8Array): { bytes: Uint8Array; metadata: UnpackMetadata }
}

export function createStaticUnpack(options?: {
  locateFile?: (file: string) => string
  mpressWasm?: BufferSource | WebAssembly.Module
}): Promise<StaticUnpack>
