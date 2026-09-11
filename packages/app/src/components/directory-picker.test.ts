import { describe, expect, test } from "bun:test"
import { directoryPickerKind } from "./directory-picker-policy"

const builtin = {
  type: "sidecar",
  variant: "base",
  http: { url: "http://localhost:4096" },
} as const
const wsl = {
  type: "sidecar",
  variant: "wsl",
  distro: "Debian",
  http: { url: "http://localhost:4097" },
} as const
const localhost = {
  type: "http",
  http: { url: "http://localhost:4096" },
} as const
const remoteHttp = {
  type: "http",
  http: { url: "https://server.example.test" },
} as const
const remote = {
  type: "ssh",
  host: "example.test",
  http: { url: "http://localhost:4096" },
} as const

describe("directoryPickerKind", () => {
  test("uses the native picker only for the built-in desktop server", () => {
    expect(directoryPickerKind("desktop", builtin)).toBe("native")
    expect(directoryPickerKind("desktop", wsl)).toBe("server")
    expect(directoryPickerKind("desktop", localhost)).toBe("server")
    expect(directoryPickerKind("desktop", remoteHttp)).toBe("server")
    expect(directoryPickerKind("desktop", remote)).toBe("server")
    expect(directoryPickerKind("web", builtin)).toBe("server")
  })
})
