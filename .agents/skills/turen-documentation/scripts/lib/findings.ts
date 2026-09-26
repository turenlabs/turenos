export type Finding = { level: "error" | "warning"; message: string }

export function error(message: string): Finding {
  return { level: "error", message }
}

export function warning(message: string): Finding {
  return { level: "warning", message }
}
