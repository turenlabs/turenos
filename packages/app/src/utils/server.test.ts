import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to forge", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "forge", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("forge:secret"))
  })

  test("encodes non-ASCII credentials as UTF-8 like the server decodes them", () => {
    expect(authTokenFromCredentials({ password: "café" })).toBe(Buffer.from("forge:café").toString("base64"))
    expect(authTokenFromCredentials({ username: "kit", password: "pass€密码" })).toBe(
      Buffer.from("kit:pass€密码").toString("base64"),
    )
    expect(authFromToken(authTokenFromCredentials({ username: "kit", password: "pass€密码" }))).toEqual({
      username: "kit",
      password: "pass€密码",
    })
  })
})
