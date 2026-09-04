import { describe, expect, test } from "bun:test"
import {
  isRendererUrl,
  isTrustedRendererIpcEvent,
  mainWindowNavigation,
  rendererCorsOrigins,
  rendererOrigin,
  rendererResponseHeaders,
} from "./window-security"

const devURL = "http://127.0.0.1:5173/app"

describe("main window security", () => {
  test("allows only the internal renderer and configured development origin", () => {
    expect(isRendererUrl(`${rendererOrigin}/index.html`, { devURL })).toBe(true)
    expect(isRendererUrl("http://127.0.0.1:5173/session/1", { devURL })).toBe(true)
    expect(isRendererUrl("https://attacker.example/index.html", { devURL })).toBe(false)
    expect(isRendererUrl("http://127.0.0.1:5174/index.html", { devURL })).toBe(false)
    expect(isRendererUrl("http://user:secret@127.0.0.1:5173/index.html", { devURL })).toBe(false)
  })

  test("opens HTTP links externally and blocks active or local schemes", () => {
    expect(mainWindowNavigation(`${rendererOrigin}/session/1`, devURL)).toEqual({ action: "allow" })
    expect(mainWindowNavigation("https://example.com/report", devURL)).toEqual({
      action: "external",
      url: "https://example.com/report",
    })
    expect(mainWindowNavigation("javascript:alert(1)", devURL)).toEqual({ action: "deny" })
    expect(mainWindowNavigation("file:///etc/passwd", devURL)).toEqual({ action: "deny" })
  })

  test("returns explicit CORS origins for production and development servers", () => {
    expect(rendererCorsOrigins("")).toEqual([rendererOrigin])
    expect(rendererCorsOrigins(devURL)).toEqual([rendererOrigin, "http://127.0.0.1:5173"])
    expect(rendererCorsOrigins("file:///tmp/index.html")).toEqual([rendererOrigin])
  })

  test("prevents packaged renderer assets from surviving an app update in cache", () => {
    expect(rendererResponseHeaders(new Headers(), "/renderer/assets/extend-old.js").get("Cache-Control")).toBe(
      "no-store",
    )
    expect(rendererResponseHeaders(new Headers(), "/renderer/index.html").get("Document-Policy")).toBe(
      "include-js-call-stacks-in-crash-reports",
    )
  })

  test("trusts only owned main frames at the renderer origin", () => {
    const mainFrame = {}
    const sender = {
      getURL: () => `${rendererOrigin}/index.html`,
      isDestroyed: () => false,
      mainFrame,
    }
    const event = { sender, senderFrame: mainFrame }

    expect(isTrustedRendererIpcEvent(event, () => true, devURL)).toBe(true)
    expect(isTrustedRendererIpcEvent({ ...event, senderFrame: {} }, () => true, devURL)).toBe(false)
    expect(isTrustedRendererIpcEvent(event, () => false, devURL)).toBe(false)
    expect(
      isTrustedRendererIpcEvent(
        { ...event, sender: { ...sender, getURL: () => "https://attacker.example/" } },
        () => true,
        devURL,
      ),
    ).toBe(false)
    expect(
      isTrustedRendererIpcEvent({ ...event, sender: { ...sender, isDestroyed: () => true } }, () => true, devURL),
    ).toBe(false)
  })
})
