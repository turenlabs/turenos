export function sessionTranscriptVisible(newLayout: boolean, view: string) {
  return !newLayout || view === "history"
}
