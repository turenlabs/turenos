import { expect, test } from "bun:test"
import { parseFactoryOutput } from "../src/team-output"

test("bare and fenced factory plans and checks have the same JSON value", () => {
  const values = [
    { assignments: [{ teammateID: "tm_worker", prompt: "Build" }] },
    { status: "accepted", summary: "Checks pass" },
  ]
  values.forEach((value) => {
    const json = JSON.stringify(value)
    expect(parseFactoryOutput(json)).toEqual(value)
    expect(parseFactoryOutput("```json\n" + json + "\n```")).toEqual(value)
    expect(parseFactoryOutput("  ```\r\n" + json + "\r\n```\n")).toEqual(value)
  })
})

test("factory output rejects prose, unsupported fences, multiple blocks, and invalid JSON", () => {
  const json = '{"status":"accepted","summary":"Checks pass"}'
  const block = "```json\n" + json + "\n```"
  ;[
    "Verdict: " + json,
    "Verdict:\n" + block,
    block + "\nThanks",
    block + "\n" + block,
    "```typescript\n" + json + "\n```",
    "```json\n{\n```",
    "{",
    "",
  ].forEach((text) => expect(parseFactoryOutput(text)).toBeUndefined())
})

test("factory output enforces the input limit before trimming or removing a fence", () => {
  const json = '{"status":"accepted","summary":"Checks pass"}'
  expect(parseFactoryOutput(json.padEnd(1_000_000))).toEqual(JSON.parse(json))
  expect(parseFactoryOutput(json.padEnd(1_000_001))).toBeUndefined()
  expect(parseFactoryOutput("```json\n" + json.padEnd(1_000_000) + "\n```")).toBeUndefined()
})
