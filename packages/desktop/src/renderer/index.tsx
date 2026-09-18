// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
  useSshServers,
  useTabs,
  useWslServers,
} from "@turenlabs/app"
import type { UpdaterSnapshot } from "@turenlabs/app/updater"
import { mountLaunchScreen } from "@turenlabs/app/launch"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import forgeNotificationIcon from "@turenlabs/ui/favicon/favicon-96x96-v3.png"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { initializationData } from "./initialization"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import { readySshConnections } from "./ssh/connections"
import "./styles.css"
import { Splash } from "@turenlabs/ui/logo"
import { useTheme } from "@turenlabs/ui/theme/context"
import { installStartupDiagnostics } from "./startup-diagnostics"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

installStartupDiagnostics()

const launch = mountLaunchScreen()

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(import.meta.env.FORGE_CHANNEL === "prod" && (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")),
      )
    },
  })
}

void initI18n()

const [updaterSnapshot, setUpdaterSnapshot] = createSignal<UpdaterSnapshot>({ state: { status: "disabled" }, lag: 0 })
void window.api.updater.subscribe(setUpdaterSnapshot)

const deepLinkEvent = "forge:deep-link"

type DesktopWindowState = {
  id?: string
}

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__FORGE__ ??= {}
  const pending = window.__FORGE__.deepLinks ?? []
  window.__FORGE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

function DesktopMemoryRouter(props: BaseRouterProps & { initialUrl: string }) {
  const history = createMemoryHistory()
  if (props.initialUrl !== "/") history.set({ value: props.initialUrl, replace: true, scroll: false })
  onCleanup(history.listen((value) => void window.api.setWindowLastActiveUrl(value)))
  return <MemoryRouter {...props} history={history} />
}

const createPlatform = (windowState: DesktopWindowState): Platform => {
  const attachmentPaths = new WeakMap<File, string>()
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  const wslServersApi = os === "windows" ? window.api.wslServers : undefined
  const sshServersApi = window.api.sshServers

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    windowID: windowState.id,

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          const picked = await window.api.readPickedFile(result.token, file.path)
          const selected = new File([picked.bytes], file.name)
          // Over-preview-size picks arrive as a mime head; pin the real size so
          // the composer sees the actual attachment size, not the head's.
          if (picked.bytes.byteLength < picked.size)
            Object.defineProperty(selected, "size", { value: picked.size })
          attachmentPaths.set(selected, file.path)
          await onFile(selected)
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    async saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        return window.api.openPath(path, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },
    async revealPath(path: string) {
      return window.api.revealPath(path)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    updater: {
      state: () => updaterSnapshot().state,
      lag: () => updaterSnapshot().lag,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
      setLag: (lag: number) => window.api.updater.setLag(lag),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),
    securityProxy: window.api.securityProxy,

    // Absent unless this is a dev build; the preload bridge omits it otherwise.
    profiler: window.api.profiler,

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: forgeNotificationIcon,
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,
    sshServers: sshServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

function LoadingSplash() {
  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <Splash class="w-16 h-20 opacity-50 animate-pulse" />
    </div>
  )
}

function DesktopRoot(props: { windowState: DesktopWindowState }) {
  const platform = createPlatform(props.windowState)
  const loadLocale = async () => {
    const current = await platform.storage?.("forge.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())
  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)
  const router = (props: BaseRouterProps) => <DesktopMemoryRouter {...props} initialUrl="/" />

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const tabs = useTabs()
    onCleanup(
      window.api.securityProxy.onFocus((caseID) => {
        const sessionID = caseID.startsWith("browser_") ? caseID.slice("browser_".length) : undefined
        if (!sessionID) return
        const tab = tabs.store.find((item) => item.type === "session" && item.sessionId === sessionID)
        if (!tab || tab.type !== "session") return
        tabs.select(tab)
        tabs.setLiveView("browser")
      }),
    )
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)
    cmd.register("desktop-security-proxy", () => [
      {
        id: "security.proxy",
        title: "Open Security Browser and Proxy",
        description: "Open the shared Security Browser for the active session",
        category: "Security",
        onSelect: () => tabs.setLiveView("browser"),
      },
    ])

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const wslServers = useWslServers()
    const sshServers = useSshServers()
    const ready = createMemo(
      () =>
        !defaultServer.loading &&
        !sidecar.loading &&
        !windowCount.loading &&
        !locale.loading &&
        !wslServers.isLoading &&
        !sshServers.isLoading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      list.push(...readyWslConnections(wslServers.data))
      list.push(...readySshConnections(sshServers.data))
      return list
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data, sshServers.data)),
    )
    return (
      <Show when={ready()} fallback={<LoadingSplash />}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface
              defaultServer={key}
              servers={servers()}
              router={router}
              serverScoped={<DesktopFirstLaunchOnboarding initialUrl="/" />}
            >
              <Inner />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest} localeSource="external">
        <Show when={true}>{(_) => <App />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

render(() => {
  const [windowState] = createResource(async () => {
    const api = window.api as typeof window.api & {
      getWindowID?: () => Promise<string>
    }
    return { id: await api.getWindowID?.() }
  })

  return (
    <Show when={windowState.latest} fallback={<LoadingSplash />} keyed>
      {(state) => <DesktopRoot windowState={state} />}
    </Show>
  )
}, root!)

launch.release()
