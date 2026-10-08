import { describe, expect, test } from "bun:test"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"
import { createStore } from "solid-js/store"
import { animationSpec } from "./animation-data"
import { animationDocument } from "./animation-document"
import { animationKeyframes } from "./animation-keyframes"
import { animationCommand, animationMessage } from "./animation-protocol"
import { disableNativeMotion } from "./animation-motion"

const purifier = createDOMPurify(new JSDOM("").window)
const spec = {
  version: 1 as const,
  title: "Example",
  html: '<svg><rect id="box" width="20" height="20" /></svg>',
  tracks: [{ target: "box", property: "x" as const, keyframes: [0, 20, 100], duration: 1000 }],
}
const token = "a".repeat(32)
const nonce = "b".repeat(32)

describe("animation data", () => {
  test("validates reactive store metadata without admitting excess JSON fields", () => {
    const [metadata, setMetadata] = createStore({
      structured: { ...spec, tracks: spec.tracks.map((track) => ({ ...track })) },
    })
    expect(animationSpec(metadata)).toEqual(spec)
    setMetadata("structured", "title", "Updated")
    expect(animationSpec(metadata)?.title).toBe("Updated")
    const [extra] = createStore({ structured: { ...spec, autoplay: true } })
    expect(animationSpec(extra)).toBeUndefined()
  })
  test("validates structured specs and rejects code, selectors, URLs, and excess options", () => {
    expect(animationSpec({ structured: spec })).toEqual(spec)
    for (const value of [
      { ...spec, autoplay: true },
      { ...spec, loops: 1 },
      { ...spec, tracks: [{ ...spec.tracks[0], target: "#box" }] },
      { ...spec, tracks: [{ ...spec.tracks[0], property: "onclick" }] },
      { ...spec, tracks: [{ ...spec.tracks[0], onUpdate: "alert(1)" }] },
      { ...spec, tracks: [{ ...spec.tracks[0], keyframes: [0, Infinity] }] },
      { ...spec, tracks: [{ ...spec.tracks[0], property: "fill", keyframes: ["#fff", "url(https://evil.invalid)"] }] },
      { ...spec, tracks: [{ ...spec.tracks[0], at: 59999 }] },
    ])
      expect(animationSpec({ structured: value })).toBeUndefined()
  })

  test("builds explicit linear numeric and color segments", () => {
    expect(animationKeyframes([0, 20, 100], 1000)).toEqual([
      { from: 0, to: 20, duration: 500, ease: "linear" },
      { from: 20, to: 100, duration: 500, ease: "linear" },
    ])
    expect(animationKeyframes(["#fff", "#000"], 100)).toEqual([
      { from: "#fff", to: "#000", duration: 100, ease: "linear" },
    ])
  })
})

describe("animation document", () => {
  test("disables native motion in inline, nested, and pseudo-element styles", () => {
    const document = new JSDOM(
      '<style>@keyframes spin{to{transform:rotate(360deg)}}@media(min-width:0px){#box::before{content:"x";animation:spin 1s linear infinite!important;transition:all 1s!important}}</style><div id="scene"><svg><rect id="box" style="animation:spin 1s infinite!important;transition:all 1s!important"><animate attributeName="x" from="0" to="10" dur="1s" repeatCount="indefinite"/></rect></svg></div>',
    ).window.document
    disableNativeMotion(document.querySelector("#scene")!)
    const box = document.querySelector("#box") as unknown as SVGElement
    expect(box.style.getPropertyValue("animation")).toBe("none")
    expect(box.style.getPropertyPriority("animation")).toBe("important")
    expect(box.style.getPropertyValue("transition")).toBe("none")
    expect(document.querySelector("animate")).toBeNull()
    const media = document.styleSheets[0]!.cssRules[1] as CSSMediaRule
    const pseudo = media.cssRules[0] as CSSStyleRule
    expect(pseudo.style.getPropertyValue("animation")).toBe("none")
    expect(pseudo.style.getPropertyPriority("animation")).toBe("important")
    expect(pseudo.style.getPropertyValue("transition")).toBe("none")
  })

  test("strips agent scripts and keeps only nonce-owned code and head data", () => {
    const value = {
      ...spec,
      title: "</script><script>alert(1)</script>",
      html: '<div id="box" onclick="alert(1)"><script>alert(1)</script></div></div><script id="turen-animation-data">bad</script><img src="https://evil.invalid">',
    }
    const output = animationDocument(value, token, nonce, 'console.log("</ScRiPt>")', purifier)!
    const document = new JSDOM(output).window.document
    const scripts = document.querySelectorAll("script")
    expect(scripts).toHaveLength(2)
    expect(Array.from(scripts).every((script) => script.nonce === nonce)).toBe(true)
    expect(document.body.querySelector("[onclick],[src]")).toBeNull()
    expect(document.body.firstElementChild?.id).toBe("turen-animation-root")
    expect(document.body.firstElementChild?.querySelector("#box")).not.toBeNull()
    expect(document.body.querySelectorAll("script")).toHaveLength(1)
    const json = document.head.querySelector("script")!.textContent!
    expect(json).not.toContain("<")
    expect(JSON.parse(json).token).toBe(token)
    expect(JSON.parse(json).title).toBe(value.title)
    expect(scripts[1]!.textContent).toContain("<\\/script>")
    const csp = document.head.querySelector("meta")!.getAttribute("content")!
    expect(csp).toContain(`script-src 'nonce-${nonce}'`)
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    for (const directive of [
      "default-src",
      "img-src",
      "connect-src",
      "frame-src",
      "font-src",
      "worker-src",
      "object-src",
      "base-uri",
      "form-action",
    ])
      expect(csp).toContain(`${directive} 'none'`)
    expect(output.indexOf("Content-Security-Policy")).toBeLessThan(output.indexOf("turen-animation-root"))
  })

  test("requires safe nonces and rejects excessive sanitized work", () => {
    expect(animationDocument(spec, token, '" onload="evil', "", purifier)).toBeUndefined()
    expect(animationDocument(spec, "old-token", nonce, "", purifier)).toBeUndefined()
    expect(animationDocument({ ...spec, html: "<i></i>".repeat(5001) }, token, nonce, "", purifier)).toBeUndefined()
  })
})

describe("animation messages", () => {
  test("requires the current iframe source and token", () => {
    const source = new JSDOM("").window as unknown as Window
    const other = new JSDOM("").window as unknown as Window
    const data = { token, type: "ready", paused: true, time: 0, duration: 1000 }
    expect(animationMessage({ source, data }, source, token)?.type).toBe("ready")
    expect(animationMessage({ source: other, data }, source, token)).toBeUndefined()
    expect(animationMessage({ source, data }, null, token)).toBeUndefined()
    expect(animationMessage({ source, data }, source, "c".repeat(32))).toBeUndefined()
    expect(animationMessage({ source, data: { ...data, time: NaN } }, source, token)).toBeUndefined()
    expect(
      animationMessage({ source, data: { token, type: "error", message: "<script>bad</script>" } }, source, token),
    ).toEqual({ type: "error", message: "<script>bad</script>" })
  })

  test("accepts only bounded playback actions", () => {
    expect(animationCommand({ token, action: "play" }, token)).toEqual({ action: "play" })
    expect(animationCommand({ token, action: "seek", value: 500 }, token)).toEqual({ action: "seek", value: 500 })
    expect(animationCommand({ token, action: "speed", value: 2 }, token)).toEqual({ action: "speed", value: 2 })
    for (const command of [
      { token: "old", action: "play" },
      { token, action: "eval", value: "alert(1)" },
      ...[-1, 60001, Infinity, NaN, "100"].map((value) => ({ token, action: "seek", value })),
      ...[0, 100, "1"].map((value) => ({ token, action: "speed", value })),
    ])
      expect(animationCommand(command, token)).toBeUndefined()
  })
})
