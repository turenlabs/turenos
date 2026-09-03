export type SessionNavStatus = "attention" | "working" | "loading" | "unread" | "settled"

export function sessionNavStatus(input: {
  hasPermission: boolean
  hasQuestion: boolean
  hasError: boolean
  working: boolean
  loading: boolean
  unreadCount: number
}): SessionNavStatus {
  if (input.hasPermission || input.hasQuestion || input.hasError) return "attention"
  if (input.working) return "working"
  if (input.loading) return "loading"
  if (input.unreadCount > 0) return "unread"
  return "settled"
}
