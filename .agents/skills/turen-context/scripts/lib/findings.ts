export type Level = "error" | "warning" | "note"
// `file` is the AGENTS.md the finding belongs to, or "" for findings that span files.
export type Finding = { level: Level; file: string; message: string }

export function error(file: string, message: string): Finding {
  return { level: "error", file, message }
}

export function warning(file: string, message: string): Finding {
  return { level: "warning", file, message }
}

export function note(file: string, message: string): Finding {
  return { level: "note", file, message }
}
