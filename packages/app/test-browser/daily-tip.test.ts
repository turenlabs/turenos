import { expect, test } from "bun:test"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { TranslationKey } from "@/context/language"
import { dict as en } from "@/i18n/en"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "daily-tip-ui-test",
  setup(build) {
    // Match either separator: on Windows args.path uses backslashes, and an unmatched file
    // falls back to Bun's default React JSX transform.
    build.onLoad({ filter: /pages[\\/]new-session[\\/]daily-tip\.tsx$/ }, async (args) => {
      const result = await compiler.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset.default, { generate: "dom" }]],
      })
      return { contents: result?.code ?? "", loader: "tsx" }
    })
  },
})
const { DailyTips, TipCatalog } = await import("@/pages/new-session/daily-tip")

function memory() {
  const values = new Map<string, string>()
  const writes: string[] = []
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key)
      values.set(key, value)
    },
    removeItem: (key: string) => {
      writes.push(key)
      values.delete(key)
    },
  }
}

const english = new Map(Object.entries(en))
const translate = (key: TranslationKey, params?: Record<string, string>) =>
  (english.get(key) ?? key).replace(/{{(\w+)}}/g, (_, name: string) => params?.[name] ?? "")
const bound = new Map([
  ["command.palette", "⌘K"],
  ["model.choose", "⌘'"],
])
const shortcut = (command: string) => bound.get(command) ?? ""
const commands = { keybind: shortcut, available: () => false, run: () => {} }
const next = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("browses all static tips without changing automatic preferences", () => {
  const storage = memory()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(TipCatalog, { translate, commands }), host)
  try {
    expect(host.textContent).toContain("More than files behind @")
    expect(host.textContent).toContain("Explore the extension catalog")
    expect(host.textContent).toContain("Explore providers")
    expect(host.querySelectorAll("li").length).toBe(16)
    expect(storage.writes).toEqual([])
  } finally {
    dispose()
    host.remove()
  }
})

test("shows each tip's live shortcut and omits unbound ones", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(TipCatalog, { translate, commands }), host)
  try {
    const shortcuts = Array.from(host.querySelectorAll('[data-slot="tip-shortcut"]')).map((node) => node.textContent)
    expect(shortcuts).toEqual(["Shortcut: ⌘K", "Shortcut: ⌘'"])
    const model = Array.from(host.querySelectorAll("li")).find((item) =>
      item.textContent?.includes("Choose the right model"),
    )
    expect(model?.textContent).toContain("Shortcut: ⌘'")
    expect(host.querySelector('[data-slot="tip-try"]')).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})

test("tries only commands available on this surface", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const ran: string[] = []
  const dispose = render(
    () =>
      createComponent(TipCatalog, {
        translate,
        commands: {
          keybind: shortcut,
          available: (command: string) => command === "prompt.mode.shell",
          run: (command: string) => ran.push(command),
        },
      }),
    host,
  )
  try {
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-slot="tip-try"]'))
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Try it: Run a shell command"])
    // An unbound but available command still offers the action without a shortcut line.
    expect(buttons[0]?.closest("li")?.querySelector('[data-slot="tip-shortcut"]')).toBeNull()
    buttons[0]?.click()
    expect(ran).toEqual(["prompt.mode.shell"])
  } finally {
    dispose()
    host.remove()
  }
})

test("shows a default daily tip on the new-session draft and hides it for today", async () => {
  const storage = memory()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage,
        translate,
        commands,
        date: new Date(2026, 8, 29, 10),
        openTips: () => {},
        onSaveFailed: () => {},
      }),
    host,
  )
  try {
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')?.textContent).toContain("Tip of the day")
    expect(storage.writes).toEqual([])
    const hide = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Hide for today")
    expect(hide).toBeDefined()
    hide?.click()
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    expect(storage.values.get("daily-tips.hiddenDay")).toBe("2026-09-29")
    expect(host.textContent).toContain("Browse tips")
  } finally {
    dispose()
    host.remove()
  }
})

test("disabled reminders stay off while browsing remains available", async () => {
  const storage = memory()
  storage.values.set("daily-tips.enabled", "false")
  const host = document.createElement("div")
  document.body.append(host)
  let browsed = 0
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage,
        translate,
        commands,
        date: new Date(2026, 8, 29),
        openTips: () => {
          browsed += 1
        },
        onSaveFailed: () => {},
      }),
    host,
  )
  try {
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Browse tips")
      ?.click()
    expect(browsed).toBe(1)
    expect(storage.writes).toEqual([])
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Show daily tips")
      ?.click()
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).not.toBeNull()
    expect(storage.values.get("daily-tips.enabled")).toBe("true")
  } finally {
    dispose()
    host.remove()
  }
})

test("another window's disable is seen on focus without writing", async () => {
  const storage = memory()
  const hosts = [document.createElement("div"), document.createElement("div")]
  hosts.forEach((host) => document.body.append(host))
  const mounted = hosts.map((host) =>
    render(
      () =>
        createComponent(DailyTips, {
          storage,
          translate,
          commands,
          date: new Date(2026, 8, 29),
          openTips: () => {},
          onSaveFailed: () => {},
        }),
      host,
    ),
  )
  try {
    await next()
    Array.from(hosts[0].querySelectorAll("button"))
      .find((button) => button.textContent === "Turn off daily tips")
      ?.click()
    await next()
    expect(hosts[0].querySelector('[data-component="daily-tip"]')).toBeNull()
    const writes = storage.writes.length
    window.dispatchEvent(new Event("focus"))
    await next()
    expect(hosts[1].querySelector('[data-component="daily-tip"]')).toBeNull()
    expect(storage.writes.length).toBe(writes)
  } finally {
    mounted.forEach((dispose) => dispose())
    hosts.forEach((host) => host.remove())
  }
})

test("unreadable preferences suppress automatic tips without blocking browsing", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  let browsed = false
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage: {
          getItem: () => {
            throw new Error("denied")
          },
          setItem: () => {},
          removeItem: () => {},
        },
        translate,
        commands,
        date: new Date(2026, 8, 29),
        openTips: () => {
          browsed = true
        },
        onSaveFailed: () => {},
      }),
    host,
  )
  try {
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Browse tips")
      ?.click()
    expect(browsed).toBe(true)
  } finally {
    dispose()
    host.remove()
  }
})

test("an explicit enable repairs malformed preferences without an automatic rewrite", async () => {
  const storage = memory()
  storage.values.set("daily-tips.hiddenDay", "not-a-day")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage,
        translate,
        commands,
        date: new Date(2026, 8, 29),
        openTips: () => {},
        onSaveFailed: () => {},
      }),
    host,
  )
  try {
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    expect(storage.writes).toEqual([])
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Show daily tips")
      ?.click()
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).not.toBeNull()
    expect(storage.values.get("daily-tips.enabled")).toBe("true")
    expect(storage.values.has("daily-tips.hiddenDay")).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})

test("a late focus refresh cannot undo a local opt-out", async () => {
  const storage = memory()
  let complete: ((value: string | null) => void) | undefined
  let delay = false
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage: {
          ...storage,
          getItem: (key: string) =>
            delay && key === "daily-tips.enabled"
              ? new Promise<string | null>((resolve) => {
                  complete = resolve
                })
              : storage.getItem(key),
        },
        translate,
        commands,
        date: new Date(2026, 8, 29),
        openTips: () => {},
        onSaveFailed: () => {},
      }),
    host,
  )
  try {
    await next()
    delay = true
    window.dispatchEvent(new Event("focus"))
    await next()
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Turn off daily tips")
      ?.click()
    await next()
    complete?.("true")
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    expect(storage.values.get("daily-tips.enabled")).toBe("false")
  } finally {
    dispose()
    host.remove()
  }
})

test("an older focus read cannot undo a newer window preference", async () => {
  const storage = memory()
  const reads: Array<(value: string | null) => void> = []
  let delayed = false
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage: {
          ...storage,
          getItem: (key: string) =>
            delayed && key === "daily-tips.enabled"
              ? new Promise<string | null>((resolve) => reads.push(resolve))
              : storage.getItem(key),
        },
        translate,
        commands,
        date: new Date(2026, 8, 29),
        openTips: () => {},
        onSaveFailed: () => {},
      }),
    host,
  )
  try {
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).not.toBeNull()
    delayed = true
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
    expect(reads).toHaveLength(2)
    reads[1]?.("false")
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    reads[0]?.("true")
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
  } finally {
    dispose()
    host.remove()
  }
})

test("a failed save warns and keeps the choice for this draft only", async () => {
  const storage = memory()
  const host = document.createElement("div")
  document.body.append(host)
  let warnings = 0
  const dispose = render(
    () =>
      createComponent(DailyTips, {
        storage: {
          ...storage,
          setItem: () => {
            throw new Error("quota")
          },
        },
        translate,
        commands,
        date: new Date(2026, 8, 29),
        openTips: () => {},
        onSaveFailed: () => {
          warnings += 1
        },
      }),
    host,
  )
  try {
    await next()
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "Turn off daily tips")
      ?.click()
    await next()
    expect(warnings).toBe(1)
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    window.dispatchEvent(new Event("focus"))
    await next()
    expect(host.querySelector('[data-component="daily-tip"]')).toBeNull()
    expect(storage.writes).toEqual([])
  } finally {
    dispose()
    host.remove()
  }
})
