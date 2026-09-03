import { describe, expect, test } from "bun:test"
import { mcpRuntimeAction, mcpRuntimeBackendName } from "./mcp-runtime-model"

const backend = (input: Partial<Parameters<typeof mcpRuntimeAction>[0]>) => ({
  backend: "docker" as const,
  selected: false,
  selectable: true,
  status: "unqualified" as const,
  capabilities: [],
  networkPosture: "network denied",
  ...input,
})

describe("MCP runtime settings model", () => {
  test("renders the Docker test action, explicit Local selection, and unavailable QEMU preview", () => {
    expect(mcpRuntimeBackendName(backend({ backend: "docker" }))).toBe("Docker")
    expect(mcpRuntimeAction(backend({ backend: "docker" }))).toBe("test")
    expect(mcpRuntimeBackendName(backend({ backend: "local" }))).toBe("Local process")
    expect(mcpRuntimeAction(backend({ backend: "local" }))).toBe("select")
    expect(mcpRuntimeBackendName(backend({ backend: "qemu", selectable: false, status: "unavailable" }))).toBe(
      "QEMU VM",
    )
    expect(mcpRuntimeAction(backend({ backend: "qemu", selectable: false, status: "unavailable" }))).toBe("unavailable")
  })
})
