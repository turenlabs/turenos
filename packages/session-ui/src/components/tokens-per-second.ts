export function tokensPerSecond(outputTokens: number, time: { created: number; completed?: number }) {
  if (time.completed === undefined) return undefined
  const durationMs = time.completed - time.created
  if (!Number.isFinite(outputTokens) || outputTokens < 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined
  }
  return (outputTokens * 1000) / durationMs
}
