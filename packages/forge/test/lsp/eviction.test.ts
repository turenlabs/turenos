import { describe, expect, test } from "bun:test"
import { selectIdleClients } from "@/lsp/lsp"

const client = (root: string, serverID: string) => ({ root, serverID })
const IDLE = 10 * 60 * 1000

describe("LSP idle eviction policy", () => {
  const gopls = client("/proj", "gopls")
  const tsserver = client("/proj", "typescript")

  test("evicts a server that has not been used for the idle window", () => {
    const now = 1_000_000
    const lastUsed = new Map([["/projgopls", now - IDLE - 1]])
    expect(selectIdleClients([gopls], lastUsed, now)).toEqual([gopls])
  })

  test("keeps a server used within the window", () => {
    const now = 1_000_000
    const lastUsed = new Map([["/projgopls", now - IDLE + 1]])
    expect(selectIdleClients([gopls], lastUsed, now)).toEqual([])
  })

  test("never evicts a freshly spawned server that has no recorded use", () => {
    // The gap between spawning a server and its first request must not look
    // like infinite idleness, or the sweep would kill it mid-handshake.
    expect(selectIdleClients([gopls], new Map(), 1_000_000)).toEqual([])
  })

  test("evicts per client, not per project", () => {
    const now = 1_000_000
    const lastUsed = new Map([
      ["/projgopls", now - IDLE - 1],
      ["/projtypescript", now],
    ])
    expect(selectIdleClients([gopls, tsserver], lastUsed, now)).toEqual([gopls])
  })

  test("boundary is inclusive", () => {
    const now = 1_000_000
    expect(selectIdleClients([gopls], new Map([["/projgopls", now - IDLE]]), now)).toEqual([gopls])
  })
})
