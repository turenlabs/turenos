import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SecurityProxy } from "../src/security-proxy"

test("native proxy values encode absent optional fields without undefined keys", () => {
  const command: SecurityProxy.Command = {
    type: "replay",
    owner: { directory: "/project", workspaceID: undefined },
    caseID: "case",
    flowID: "flow",
    replayID: "replay",
    auth: "captured",
    edits: undefined,
  }
  expect(Schema.is(SecurityProxy.Command)(command)).toBe(true)
  const encoded = Schema.encodeSync(SecurityProxy.Command)(command)
  expect(encoded).not.toHaveProperty("edits")
  expect(encoded.owner).not.toHaveProperty("workspaceID")
})

test("browser control and private storage have distinct allowlists", () => {
  const open = { type: "open", owner: { directory: "/project" }, caseID: "case" }
  expect(Schema.is(SecurityProxy.Command)(open)).toBe(true)
  expect(Schema.is(SecurityProxy.StoreCommand)(open)).toBe(false)
  expect(Schema.is(SecurityProxy.Command)({ ...open, type: "evaluate", script: "process.exit()" })).toBe(false)
  expect(Schema.is(SecurityProxy.Command)({ ...open, caseID: "../escape" })).toBe(false)
})
