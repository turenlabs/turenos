export function createSessionV2DeltaGate() {
  const sessions = new Set<string>()
  return {
    observe: (sessionID: string) => sessions.add(sessionID),
    observeSnapshot: (sessionID: string) => sessions.add(sessionID),
    accepts: (sessionID: string) => sessions.has(sessionID),
  }
}

export const sessionV2DeltaGate = createSessionV2DeltaGate()

export function markSessionV2(sessionID: string) {
  sessionV2DeltaGate.observe(sessionID)
}
