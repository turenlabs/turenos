const fallback = new Map<string, string>()

export function whiteboardClientID(
  storageKey: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
) {
  const key = `forge.whiteboard.client:${storageKey}`
  try {
    const store = storage ?? globalThis.sessionStorage
    const existing = store.getItem(key)
    if (existing && existing.length <= 128) return existing
    const clientID = fallback.get(key) ?? crypto.randomUUID()
    fallback.set(key, clientID)
    store.setItem(key, clientID)
    return clientID
  } catch {
    const existing = fallback.get(key)
    if (existing) return existing
    const clientID = crypto.randomUUID()
    fallback.set(key, clientID)
    return clientID
  }
}
