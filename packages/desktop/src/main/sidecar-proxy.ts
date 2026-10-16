import { randomUUID } from "node:crypto"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"
import type { ProxyCommand, ProxyReply } from "./security-proxy-bridge"

export function createSidecarProxy(send: (message: ProxyCommand) => void, timeoutMs = 15_000) {
  const pending = new Map<
    string,
    {
      resolve: (result: SecurityProxy.Result) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let stopped = false
  return {
    request(command: SecurityProxy.Command) {
      return new Promise<SecurityProxy.Result>((resolve, reject) => {
        if (stopped) return reject(new Error("Sidecar stopped"))
        // Match the count and payload limits on the main-to-sidecar bridge.
        if (pending.size >= 32 || JSON.stringify(command).length > 8 * 1024 * 1024)
          return reject(new Error("Proxy bridge capacity exceeded"))
        const id = randomUUID()
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Security Browser agent operation timed out"))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          send({ type: "security-proxy-command", id, command })
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    },
    reply(reply: ProxyReply) {
      const item = pending.get(reply.id)
      if (!item) return
      pending.delete(reply.id)
      clearTimeout(item.timer)
      if (reply.error || !reply.result) return item.reject(new Error(reply.error ?? "Invalid proxy reply"))
      item.resolve(reply.result)
    },
    stop() {
      stopped = true
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.reject(new Error("Sidecar stopped"))
      }
      pending.clear()
    },
  }
}
