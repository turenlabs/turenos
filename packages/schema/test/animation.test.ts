import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Animation } from "../src/animation"

const track = { target: "dot-1", property: "x", keyframes: [0, 100], duration: 1000 }
const spec = { version: 1, title: "Motion", html: '<svg><circle id="dot-1" r="4"/></svg>', tracks: [track] }
const valid = Schema.is(Animation.Spec)

describe("Animation.Spec", () => {
  test("accepts numeric and color tracks with absent at", () => {
    expect(valid(spec)).toBe(true)
    expect(valid({ ...spec, tracks: [{ ...track, property: "fill", keyframes: ["#abc", "#123456"] }] })).toBe(true)
    expect(valid({ ...spec, tracks: [{ ...track, duration: 60000, at: 0 }] })).toBe(true)
    expect(valid({ ...spec, tracks: Array(128).fill(track) })).toBe(true)
    expect(Schema.decodeUnknownSync(Animation.Spec)(spec).tracks[0]?.at).toBeUndefined()
  })

  test("bounds document fields and total encoded UTF-8 bytes", () => {
    ;[
      { ...spec, version: 2 },
      { ...spec, title: "" },
      { ...spec, title: "x".repeat(161) },
      { ...spec, description: "x".repeat(1001) },
      { ...spec, html: "" },
      { ...spec, html: "x".repeat(Animation.MAX_BYTES) },
      { ...spec, html: "é".repeat(Animation.MAX_BYTES / 2) },
      { ...spec, html: '"'.repeat(Animation.MAX_BYTES / 2) },
      { ...spec, tracks: [] },
      { ...spec, tracks: Array(129).fill(track) },
    ].forEach((input) => expect(valid(input)).toBe(false))
  })

  test("rejects selectors, unsupported properties, and invalid timing", () => {
    ;[
      { target: "#dot" },
      { target: ".dot" },
      { target: "1dot" },
      { target: "a".repeat(121) },
      { property: "onclick" },
      { property: "backgroundImage" },
      { duration: 99 },
      { duration: 60001 },
      { duration: Infinity },
      { at: -1 },
      { at: 60001 },
      { at: NaN },
      { at: 59001 },
      { keyframes: [1] },
      { keyframes: Array(33).fill(1) },
    ].forEach((input) => expect(valid({ ...spec, tracks: [{ ...track, ...input }] })).toBe(false))
    expect(valid({ ...spec, tracks: [{ target: "dot", property: "x", keyframes: [0, 1] }] })).toBe(false)
  })

  test("bounds numeric keyframes for each property", () => {
    ;[NaN, Infinity, -Infinity, 1000001, -1000001].forEach((value) =>
      expect(valid({ ...spec, tracks: [{ ...track, keyframes: [0, value] }] })).toBe(false),
    )
    ;[
      ["opacity", -0.1],
      ["opacity", 1.1],
      ["scale", -1],
      ["scale", 101],
      ["r", -1],
      ["r", 10001],
      ["width", -1],
      ["width", 10001],
      ["height", -1],
      ["height", 10001],
    ].forEach(([property, value]) =>
      expect(valid({ ...spec, tracks: [{ ...track, property, keyframes: [0, value] }] })).toBe(false),
    )
    expect(valid({ ...spec, tracks: [{ ...track, keyframes: [-1e6, 1e6] }] })).toBe(true)
  })

  test("accepts only hexadecimal color keyframes", () => {
    ;["red", "#1234", "#12345678", "url(https://example.com)", "rgb(0,0,0)", 1].forEach((value) =>
      expect(valid({ ...spec, tracks: [{ ...track, property: "stroke", keyframes: ["#abc", value] }] })).toBe(false),
    )
    expect(valid({ ...spec, tracks: [{ ...track, keyframes: ["#abc", "#def"] }] })).toBe(false)
  })

  test("accepts every numeric property and its upper range boundary", () => {
    ;["x", "y", "translateX", "translateY", "rotate", "cx", "cy", "strokeDashoffset", "textContent"].forEach(
      (property) => expect(valid({ ...spec, tracks: [{ ...track, property, keyframes: [-1e6, 1e6] }] })).toBe(true),
    )
    ;[
      ["opacity", 1],
      ["scale", 100],
      ["r", 10000],
      ["width", 10000],
      ["height", 10000],
    ].forEach(([property, value]) =>
      expect(valid({ ...spec, tracks: [{ ...track, property, keyframes: [0, value] }] })).toBe(true),
    )
    expect(valid({ ...spec, tracks: [{ ...track, at: 59000 }] })).toBe(true)
  })

  test("rejects extra animation controls when strict decoding is requested", () => {
    ;["autoplay", "loop", "callbacks"].forEach((key) => {
      expect(() =>
        Schema.decodeUnknownSync(Animation.Spec)({ ...spec, [key]: true }, { onExcessProperty: "error" }),
      ).toThrow()
    })
  })
})
