import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/forge-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates legacy oc-1 to oc-2 before mount", () => {
    localStorage.setItem("forge-theme-id", "oc-1")
    localStorage.setItem("forge-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("forge-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("forge-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("forge-theme-css-light")).toBeNull()
    expect(localStorage.getItem("forge-theme-css-dark")).toBeNull()
    expect(document.getElementById("forge-theme-preload")).toBeNull()
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("forge-theme-id", "nightowl")
    localStorage.setItem("forge-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("forge-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
