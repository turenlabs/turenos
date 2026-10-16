import { expect, test } from "bun:test"
import type { ProxyCommand } from "./security-proxy-bridge"
import { createSidecarProxy } from "./sidecar-proxy"

const command = { type: "list", owner: { directory: "/synthetic" } } as const

test("stalled batches admit at most 32 requests and stop releases them", async () => {
  const sent: ProxyCommand[] = []
  const proxy = createSidecarProxy((message) => {
    sent.push(message)
  })
  const requests = Array.from({ length: 128 }, () => proxy.request(command).catch((error: Error) => error.message))
  expect(sent).toHaveLength(32)
  proxy.stop()
  const results = await Promise.all(requests)
  expect(results.filter((result) => result === "Proxy bridge capacity exceeded")).toHaveLength(96)
  expect(results.filter((result) => result === "Sidecar stopped")).toHaveLength(32)
  await expect(proxy.request(command)).rejects.toThrow("Sidecar stopped")
})

test("replies release capacity without accepting duplicate or unknown replies", async () => {
  const sent: ProxyCommand[] = []
  const proxy = createSidecarProxy((message) => {
    sent.push(message)
  })
  const first = proxy.request(command)
  proxy.reply({ type: "security-proxy-result", id: sent[0].id, result: { cases: [] } })
  proxy.reply({ type: "security-proxy-result", id: sent[0].id, error: "late" })
  proxy.reply({ type: "security-proxy-result", id: "unknown", error: "unknown" })
  await expect(first).resolves.toEqual({ cases: [] })
  const next = Array.from({ length: 32 }, () => proxy.request(command).catch(() => {}))
  expect(sent).toHaveLength(33)
  proxy.stop()
  await Promise.all(next)
})

test("error replies and timeouts release request ownership", async () => {
  const sent: ProxyCommand[] = []
  const proxy = createSidecarProxy((message) => {
    sent.push(message)
  }, 5)
  const first = proxy.request(command)
  proxy.reply({ type: "security-proxy-result", id: sent[0].id, error: "denied" })
  await expect(first).rejects.toThrow("denied")
  const timed = proxy.request(command)
  await expect(timed).rejects.toThrow("timed out")
  const next = Array.from({ length: 32 }, () => proxy.request(command).catch(() => {}))
  expect(sent).toHaveLength(34)
  proxy.stop()
  await Promise.all(next)
})

test("oversized commands fail before IPC and do not consume capacity", async () => {
  let sent = 0
  const proxy = createSidecarProxy(() => {
    sent++
  })
  await expect(proxy.request({ type: "list", owner: { directory: "x".repeat(8 * 1024 * 1024) } })).rejects.toThrow(
    "capacity exceeded",
  )
  expect(sent).toBe(0)
  proxy.stop()
})

test("synchronous send failures release capacity", async () => {
  const proxy = createSidecarProxy(() => {
    throw new Error("disconnected")
  })
  const results = await Promise.all(
    Array.from({ length: 64 }, () => proxy.request(command).catch((error: Error) => error.message)),
  )
  expect(results.every((result) => result === "disconnected")).toBe(true)
  proxy.stop()
})
