export interface InitOutput {
  readonly memory: WebAssembly.Memory
}

export default function init(input: {
  readonly module_or_path: BufferSource | WebAssembly.Module | Promise<BufferSource | WebAssembly.Module>
}): Promise<InitOutput>

export function binwalk_scan(bytes: Uint8Array, options_json: string): string
