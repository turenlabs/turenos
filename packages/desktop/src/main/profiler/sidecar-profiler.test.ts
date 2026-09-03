import { describe, expect, test } from "bun:test"

import { parseProfileCommand } from "./sidecar-profiler"
import { DEFAULT_SAMPLE_INTERVAL_US } from "./run"

// The sidecar validates every field it is handed on the parent port, including
// these. The commands only ever come from our own main process, but the channel
// keeps that property uniformly rather than trusting one message shape.
describe("parseProfileCommand", () => {
  test("accepts a start command and keeps a sane interval", () => {
    expect(parseProfileCommand({ type: "profile-start", sampleIntervalUs: 250 })).toEqual({
      type: "profile-start",
      sampleIntervalUs: 250,
    })
  })

  test.each([
    ["missing", undefined],
    ["not a number", "1000"],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["absurdly small", 1],
    ["absurdly large", 10_000_000],
  ])("falls back to the default interval when it is %s", (_label, sampleIntervalUs) => {
    expect(parseProfileCommand({ type: "profile-start", sampleIntervalUs })).toEqual({
      type: "profile-start",
      sampleIntervalUs: DEFAULT_SAMPLE_INTERVAL_US,
    })
  })

  test("accepts a stop command with an absolute .cpuprofile path", () => {
    expect(parseProfileCommand({ type: "profile-stop", path: "/tmp/run/sidecar.cpuprofile" })).toEqual({
      type: "profile-stop",
      path: "/tmp/run/sidecar.cpuprofile",
    })
  })

  test.each([
    ["a relative path", "run/sidecar.cpuprofile"],
    ["a traversal segment", "/tmp/../etc/sidecar.cpuprofile"],
    ["the wrong extension", "/tmp/run/sidecar.json"],
    ["a missing path", undefined],
  ])("rejects a stop command with %s", (_label, path) => {
    expect(parseProfileCommand({ type: "profile-stop", path })).toBeUndefined()
  })

  test("accepts an abort command", () => {
    expect(parseProfileCommand({ type: "profile-abort" })).toEqual({ type: "profile-abort" })
  })

  test.each([
    ["an unknown profile command", { type: "profile-explode" }],
    ["a non-profile command", { type: "start" }],
    ["a null payload", null],
    ["a string payload", "profile-start"],
    ["a payload with no type", { path: "/tmp/x.cpuprofile" }],
  ])("rejects %s", (_label, value) => {
    expect(parseProfileCommand(value)).toBeUndefined()
  })
})
