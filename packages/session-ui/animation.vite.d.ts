export function animationRuntimePlugin(): {
  name: string
  resolveId(source: string): string | undefined
  load(this: { addWatchFile(file: string): void }, id: string): Promise<string | undefined>
  watchChange(): void
  generateBundle(this: { emitFile(asset: { type: "asset"; fileName: string; source: string }): void }): void
}

export function visualizationNotices(): string
