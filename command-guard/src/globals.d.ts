declare const process: {
  readonly argv: string[]
  readonly platform: string
  readonly env: Record<string, string | undefined>
  readonly stdin: {
    readonly isTTY?: boolean
  }
  readonly stdout: {
    write(text: string): boolean
  }
  readonly stderr: {
    write(text: string): boolean
  }
  exitCode?: number
}

declare const Bun: {
  readonly stdin: {
    text(): Promise<string>
  }
}

interface ImportMeta {
  readonly main?: boolean
}
