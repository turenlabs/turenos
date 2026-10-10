import assert from "node:assert/strict"
import { mock } from "bun:test"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { dict } from "@/i18n/en"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "release-notes-fixture",
  setup(build) {
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
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

const [preferences, setPreferences] = createStore({ enabled: true, ready: true, desktopReady: false })
const links: string[] = []
const calls: string[] = []
let claimed: ((value: { previous: string } | null) => void) | undefined
const english = new Map(Object.entries(dict))
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (english.get(key) ?? key).replace(/{{(\w+)}}/g, (_, name: string) => params?.[name] ?? ""),
  }),
}))
mock.module("@/context/settings", () => ({
  useSettings: () => ({
    ready: () => preferences.ready,
    general: {
      releaseNotes: () => preferences.enabled,
      setReleaseNotes: (enabled: boolean) => setPreferences("enabled", enabled),
    },
  }),
}))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    version: "1.0.44",
    platform: "desktop",
    openLink: (url: string) => links.push(url),
    releaseNotes: {
      ready: () => preferences.desktopReady,
      claim: (enabled: boolean) => {
        calls.push(`claim:${enabled}`)
        return new Promise<{ previous: string } | null>((resolve) => {
          claimed = resolve
        })
      },
      shown: async () => {
        assert.ok(document.querySelector("[data-component=release-notes]"), "must render before acknowledging")
        calls.push("shown")
      },
      release: async () => {
        calls.push("release")
      },
    },
  }),
}))

const { DialogProvider, useDialog } = await import("@turenlabs/ui/context/dialog")
const { DialogReleaseNotes } = await import("@/components/dialog-release-notes")
const host = document.createElement("div")
document.body.append(host)
let dialog: ReturnType<typeof useDialog> | undefined
let shown = 0
const dispose = render(
  () =>
    createComponent(DialogProvider, {
      get children() {
        dialog = useDialog()
        return null
      },
    }),
  host,
)
assert.ok(dialog)
await dialog.show(() =>
  createComponent(DialogReleaseNotes, {
    releases: [
      {
        version: "1.0.44",
        summary: "A concise release summary.",
        changes: { new: ["<img src=x onerror=alert(1)>"], improved: [], fixed: ["A real fix."] },
      },
    ],
    onShown: () => {
      shown += 1
    },
  }),
)
assert.ok(document.body.textContent?.includes("What’s changed in TurenOS 1.0.44"))
assert.ok(document.body.textContent?.includes("A concise release summary."))
assert.ok(document.body.textContent?.includes("<img src=x onerror=alert(1)>"))
assert.equal(document.querySelector("[data-component=release-notes] img"), null)
assert.equal(document.querySelector("[data-component=release-notes] video"), null)
assert.equal(shown, 1)
const button = (text: string) => {
  const found = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text)
  assert.ok(found, `Missing button: ${text}`)
  return found
}
button("Full release notes").click()
assert.deepEqual(links, ["https://github.com/turenlabs/turenos/releases/tag/v1.0.44"])
button("Don't show these in the future").click()
assert.equal(preferences.enabled, false)
assert.equal(dialog.active, undefined)
await new Promise((resolve) => setTimeout(resolve, 120))
dispose()
host.remove()

const { HighlightsProvider, useHighlights } = await import("@/context/highlights")
const { SettingsReleaseNotes } = await import("@/components/settings-release-notes")
const next = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
let highlights: ReturnType<typeof useHighlights> | undefined
function mountStartup() {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          dialog = useDialog()
          return createComponent(HighlightsProvider, {
            get children() {
              highlights = useHighlights()
              return createComponent(SettingsReleaseNotes, {
                children: (title, description, open) => {
                  const control = document.createElement("button")
                  control.dataset.action = "browse-release-notes"
                  control.textContent = title
                  control.title = description
                  control.onclick = open
                  return control
                },
              })
            },
          })
        },
      }),
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}
setPreferences({ enabled: true, ready: false })
const stop = mountStartup()
await next()
assert.deepEqual(calls, [])
setPreferences("ready", true)
await next()
assert.deepEqual(calls, [], "onboarding must settle before claiming")
setPreferences("desktopReady", true)
await next()
assert.deepEqual(calls, ["claim:true"])
claimed?.({ previous: "1.0.43" })
await dialog.show(() => document.createTextNode("An important existing dialog"))
await next()
assert.ok(document.body.textContent?.includes("An important existing dialog"))
assert.equal(document.querySelector("[data-component=release-notes]"), null)
assert.ok(!calls.includes("shown"))
dialog.close()
await next()
await next()
assert.ok(document.querySelector("[data-component=release-notes]"))
assert.equal(calls.filter((call) => call === "shown").length, 1)
button("Got it").click()
await next()
assert.equal(dialog.active, undefined)
assert.ok(highlights)
setPreferences("enabled", false)
const browse = document.querySelector<HTMLButtonElement>("[data-action=browse-release-notes]")
assert.ok(browse)
assert.equal(browse.textContent, dict["settings.general.releaseNotes.open"])
assert.equal(browse.title, dict["settings.general.releaseNotes.open.description"])
browse.click()
await next()
assert.ok(document.querySelector("[data-component=release-notes]"), "manual browsing works with popups off")
assert.equal(calls.filter((call) => call.startsWith("claim")).length, 1)
button("Got it").click()
await new Promise((resolve) => setTimeout(resolve, 120))
stop()
await next()

// A server-scoped onboarding remount can revoke readiness during a claim.
calls.length = 0
setPreferences({ enabled: true, ready: true, desktopReady: true })
const remount = mountStartup()
await next()
setPreferences("desktopReady", false)
claimed?.({ previous: "1.0.43" })
await next()
assert.equal(!!document.querySelector("[data-component=release-notes]"), false, "wait for renewed readiness")
setPreferences("desktopReady", true)
await next()
assert.ok(document.querySelector("[data-component=release-notes]"))
button("Got it").click()
await new Promise((resolve) => setTimeout(resolve, 120))
remount()
await next()

// A renderer unmount releases an in-flight claim and ignores its late result.
calls.length = 0
setPreferences({ enabled: true, ready: true, desktopReady: true })
const cancel = mountStartup()
await next()
assert.deepEqual(calls, ["claim:true"])
cancel()
claimed?.({ previous: "1.0.43" })
await next()
assert.deepEqual(calls, ["claim:true", "release"])
assert.equal(document.querySelector("[data-component=release-notes]"), null)

// Opting out while another dialog owns focus must not resurrect the popup.
calls.length = 0
const optOut = mountStartup()
await next()
await dialog.show(() => document.createTextNode("Keep this dialog"))
claimed?.({ previous: "1.0.43" })
await next()
setPreferences("enabled", false)
await next()
assert.deepEqual(calls, ["claim:true", "release", "claim:false"])
claimed?.(null)
dialog.close()
await new Promise((resolve) => setTimeout(resolve, 120))
assert.equal(document.querySelector("[data-component=release-notes]"), null)
optOut()
await next()

// Popups disabled at launch still tell the desktop to advance its baseline.
calls.length = 0
const disabled = mountStartup()
await next()
assert.deepEqual(calls, ["claim:false"])
claimed?.(null)
await next()
assert.equal(document.querySelector("[data-component=release-notes]"), null)
disabled()
console.log("release notes checks passed")
