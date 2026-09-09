import "@/index.css"
import * as Sentry from "@sentry/solid"
import { I18nProvider } from "@turenlabs/ui/context"
import { DialogProvider, useDialog } from "@turenlabs/ui/context/dialog"
import { FileComponentProvider } from "@turenlabs/ui/context/file"
import { MarkedProvider } from "@turenlabs/ui/context/marked"
import { File } from "@turenlabs/session-ui/file"
import { Font } from "@turenlabs/ui/font"
import { Splash } from "@turenlabs/ui/logo"
import { ThemeProvider } from "@turenlabs/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import { base64Encode } from "@turenlabs/core/util/encode"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider, useCommand, useCommandPalette, type CommandOption } from "@/context/command"
import { DestinationLoading } from "@/components/destination-loading"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { TerminalProvider } from "@/context/terminal"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import LegacyLayout from "@/pages/layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { legacySessionHref, legacySessionServer, requireServerKey, sessionHref } from "./utils/session-route"
import { createSessionLineage } from "@/pages/session/session-lineage"
import { AnalysisShell, AppSecPage, useAnalysisLastTab } from "@/pages/analysis"
import { analysisDestinationHref, ANALYSIS_DEFAULT_DESTINATION } from "@/pages/analysis-state"

import { SessionPage, SessionRouteErrorBoundary, TargetSessionRouteContent } from "@/pages/session"
import { NewHome, LegacyHome } from "@/pages/home"
import { ProviderUsagePage } from "@/pages/provider-usage"

const NewSession = lazy(() => import("@/pages/new-session"))
const AutomationsPage = lazy(() => import("@/pages/loops"))
const ExtendPage = lazy(() => import("@/pages/extend"))
const SystemMapPage = lazy(() => import("@/pages/system-map"))
const SessionReplayPage = lazy(() => import("@/pages/session-replay"))
const LobbyPage = lazy(() => import("@/pages/lobby"))
const PentestPage = lazy(() => import("@/pages/pentest"))
const PentestRunPage = lazy(() => import("@/pages/pentest").then((module) => ({ default: module.PentestRunPage })))

const AnalysisPenTestingPage = () => (
  <AnalysisShell>
    <PentestPage />
  </AnalysisShell>
)

const LobbyBetaRoute = () => {
  const settings = useSettings()
  return (
    <Show when={settings.ready()}>
      <Show when={settings.general.lobbyBetaEnabled()} fallback={<Navigate href="/" />}>
        <LobbyPage />
      </Show>
    </Show>
  )
}

const AutomationsGate = (props: ParentProps) => {
  const settings = useSettings()
  return (
    <Show when={settings.ready()} fallback={<div class="size-full min-h-0 bg-v2-background-bg-deep" aria-busy="true" />}>
      <Show when={settings.general.automationsEnabled()} fallback={<Navigate href="/" />}>
        {props.children}
      </Show>
    </Show>
  )
}

const AnalysisPentestRunPage = () => (
  <AnalysisShell>
    <PentestRunPage />
  </AnalysisShell>
)

const AutomationsRoute = () => (
  <AutomationsGate>
    <Suspense fallback={<div class="size-full min-h-0 bg-v2-background-bg-deep" aria-busy="true" />}>
      <AutomationsPage />
    </Suspense>
  </AutomationsGate>
)

const AnalysisAppSecPage = () => (
  <AnalysisShell>
    <AppSecPage />
  </AnalysisShell>
)

// The Workbench entry point ("/analysis") restores whichever tab
// was last active (AnalysisShell records it on every visit); a visitor who
// has never picked one lands on AppSec, the first tab in the strip, not on
// whichever destination used to be hardcoded here.
const AnalysisIndexRedirect = () => {
  const lastTab = useAnalysisLastTab()
  const navigate = useNavigate()
  createEffect(() => {
    if (!lastTab.ready()) return
    navigate(analysisDestinationHref(lastTab.get() ?? ANALYSIS_DEFAULT_DESTINATION), { replace: true })
  })
  return null
}

const SessionRoute = () => {
  const settings = useSettings()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  if (params.id && settings.general.newLayoutDesigns()) {
    const sessionID = params.id
    return (
      <Show when={tabs.ready()}>
        {(_) => {
          const persisted = tabs.store.filter((item) => item.type === "session")
          return <Navigate href={sessionHref(legacySessionServer(persisted, sessionID, server.key), sessionID)} />
        }}
      </Show>
    )
  }

  // When the new layout is enabled, the legacy new-session route (/:dir/session with no id)
  // is replaced by a draft at /new-session?draftId=…
  createEffect(() => {
    if (!settings.general.newLayoutDesigns()) return
    if (params.id || search.draftId) return
    if (!tabs.ready() || !sdk().directory) return
    tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
  })

  return (
    <SessionRouteErrorBoundary sessionID={params.id}>
      <SessionPage />
    </SessionRouteErrorBoundary>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  const conn = createMemo(() => {
    const key = requireServerKey(params.serverKey)
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    // Owns the server-identity remount. Session changes must NOT remount this
    // subtree (SessionRouteErrorBoundary resets and createSessionLineage
    // re-resolves reactively instead); both rely on this key for server changes.
    <Show when={requireServerKey(params.serverKey)} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

const TargetSessionRoute = () => (
  <TargetServerRoute>
    <TargetSessionRouteContent />
  </TargetServerRoute>
)

function LegacyTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  return (
    <TargetServerRoute>
      <SessionRouteErrorBoundary sessionID={params.id} serverKey={requireServerKey(params.serverKey)}>
        <LegacyTargetSessionRedirect />
      </SessionRouteErrorBoundary>
    </TargetServerRoute>
  )
}

function LegacyTargetSessionRedirect() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const sync = useServerSync()
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )

  createEffect(() => {
    const directory = current()?.session.directory
    if (!directory) return
    navigate(legacySessionHref(directory, params.id), { replace: true })
  })

  return null
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function ExtendRoute() {
  return (
    <SelectedServerProviders>
      <ExtendPage />
    </SelectedServerProviders>
  )
}

function LegacyServerLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <LegacyServerScopedShell serverScoped={props.serverScoped}>{props.children}</LegacyServerScopedShell>
    </SelectedServerProviders>
  )
}

function DraftRoute() {
  const [search] = useSearchParams<{ draftId?: string }>()
  const settings = useSettings()
  const tabs = useTabs()
  const current = createMemo(() =>
    tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId),
  )
  const draft = createMemo<DraftTab | undefined>((previous) => {
    if (current()) return current()
    // Promotion replaces the tab before the router commits its session destination.
    if (previous?.draftID === search.draftId) return previous
  })
  return (
    <Show when={tabs.ready()}>
      <Show when={draft()} keyed fallback={<Navigate href="/" />}>
        {(draft) => (
          <Show
            when={settings.general.newLayoutDesigns()}
            fallback={<Navigate href={`/${base64Encode(draft.directory)}/session`} />}
          >
            <ResolvedDraftRoute draft={draft} promoting={() => !current()} />
          </Show>
        )}
      </Show>
    </Show>
  )
}

function ResolvedDraftRoute(props: { draft: DraftTab; promoting: () => boolean }) {
  const global = useGlobal()
  const conn = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server))
  const directory = () => props.draft.directory
  const serverKey = () => props.draft.server

  return (
    <Show when={`${props.draft.server}\0${props.draft.directory}`} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>
          <ModelsProvider directory={directory}>
            <SDKProvider directory={directory}>
              <DirectoryDataProvider directory={directory} server={serverKey}>
                <DraftProviders>
                  <div class="relative size-full" inert={props.promoting()} aria-busy={props.promoting()}>
                    <NewSession />
                    <Show when={props.promoting()}>
                      <div class="pointer-events-none fixed right-4 top-12 z-40 rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-2.5 py-1 shadow-sm">
                        <DestinationLoading appearance="chrome" label="Starting session" />
                      </div>
                    </Show>
                  </div>
                </DraftProviders>
              </DirectoryDataProvider>
            </SDKProvider>
          </ModelsProvider>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __FORGE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  const settings = useSettings()

  createRenderEffect(() => {
    if (typeof document === "undefined") return

    const enabled = settings.general.newLayoutDesigns()
    document.body.toggleAttribute("data-new-layout", enabled)
    document.body.classList.toggle("text-12-regular", !enabled)
    document.body.classList.toggle("font-(family-name:--font-family-text)", enabled)
    document.body.classList.toggle("text-[13px]", enabled)
    document.body.classList.toggle("font-[440]", enabled)
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <CommandProvider>
        <DesktopCommands />
        <HighlightsProvider>{props.children}</HighlightsProvider>
      </CommandProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  return null
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  serverScoped?: JSX.Element
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <LayoutProvider>
      {props.serverScoped}
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </LayoutProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders directory={props.directory} serverScoped={props.serverScoped}>
      <LegacyLayout>{props.children}</LegacyLayout>
    </ServerScopedProviders>
  )
}

function NewAppLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders serverScoped={props.serverScoped}>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

// Drafts share the workspace terminal runtime with promoted sessions so PTYs survive
// opening the composer, switching tabs, and navigating into the resulting session.
function DraftProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale; localeSource?: "browser" | "external" }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode, scheme) => {
          void window.api?.setTitlebar?.({ mode, scheme })
        }}
      >
        <LanguageProvider locale={props.locale} source={props.localeSource}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void> }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() =>
              type === "http" ? checkServerHealth(http) : checkServerHealth(http, { timeoutMs: 750, retryCount: 0 }),
            )
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
            yield* Effect.sleep("100 millis")
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )
  const [startup] = createResource(async () => {
    if (!props.startup) return true
    await props.startup.catch((error) => {
      console.error("[startup] startup gate failed", error)
    })
    return true
  })
  const startupChecking = createMemo(
    () => startupHealthCheck.latest === true && ["unresolved", "pending"].includes(startup.state),
  )
  const loading = createMemo(() => checking() || startupChecking())

  return (
    <>
      <Show when={!checking()}>
        <Show
          when={startupHealthCheck.latest}
          fallback={
            <ConnectionError
              onRetry={() => {
                if (checkMode() === "background") void healthCheckActions.refetch()
              }}
              onServerSelected={(key) => {
                setCheckMode("blocking")
                server.setActive(key)
                void healthCheckActions.refetch()
              }}
            />
          }
        >
          {props.children}
        </Show>
      </Show>
      <Show when={loading()}>
        <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-20 opacity-50 animate-pulse" />
        </div>
      </Show>
    </>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-16 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  startup?: Promise<void>
  serverScoped?: JSX.Element
}) {
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <GlobalProvider>
        <SettingsProvider>
          <ConnectionGate disableHealthCheck={props.disableHealthCheck} startup={props.startup}>
            <Show when={useSettings().general.newLayoutDesigns().toString()} keyed>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <TabsProvider>
                    <PermissionProvider>
                      <NotificationProvider>
                        <ServerShell>
                          <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>
                            <NewAppLayout serverScoped={props.serverScoped}>{routerProps.children}</NewAppLayout>
                          </Show>
                        </ServerShell>
                      </NotificationProvider>
                    </PermissionProvider>
                  </TabsProvider>
                )}
              >
                <Routes serverScoped={props.serverScoped} />
              </Dynamic>
            </Show>
          </ConnectionGate>
        </SettingsProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes(props: { serverScoped?: JSX.Element }) {
  const settings = useSettings()

  return (
    <>
      <Route
        component={(routeProps) => (
          <LegacyServerLayout serverScoped={props.serverScoped}>{routeProps.children}</LegacyServerLayout>
        )}
      >
        <Show when={!settings.general.newLayoutDesigns()}>
          {
            <>
              <Route path="/" component={LegacyHome} />
              <Route path="/server/:serverKey/session/:id" component={LegacyTargetSessionRoute} />
            </>
          }
        </Show>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Route path="/extend/:view?" component={ExtendRoute} />
      <Show when={settings.general.newLayoutDesigns()}>
        <Route path="/" component={NewHome} />
        <Route path="/home" component={ProviderUsagePage} />
        <Route path="/home/system-map" component={SystemMapPage} />
        <Route path="/replay" component={SessionReplayPage} />
        <Route path="/lobby/:roomID?" component={LobbyBetaRoute} />
        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />
        <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
        {/* Automations resolves the currently selected configured server itself, so the
            route stays server-agnostic while its page owns the SDK connection. */}
        <Route path="/automations/:id?" component={AutomationsRoute} />
        <Route path="/loops/:id?" component={LoopsLegacyRedirect} />
        <Route path="/analysis" component={AnalysisIndexRedirect} />
        <Route path="/analysis/appsec" component={AnalysisAppSecPage} />
        <Route path="/analysis/pen-testing" component={AnalysisPenTestingPage} />
        <Route path="/analysis/*" component={() => <Navigate href="/analysis/appsec" />} />
        <Route path="/pentest" component={AnalysisPenTestingPage} />
        <Route path="/pentest/:runID" component={AnalysisPentestRunPage} />
      </Show>
      <Route path="/new-session" component={DraftRoute} />
    </>
  )
}

function PlannedSurface(props: { name: string }) {
  const dialog = useDialog()
  useCommandPalette(() => {
    void import("@/components/dialog-command-palette-v2").then(({ DialogCommandOnlyPaletteV2 }) => {
      void dialog.show(() => <DialogCommandOnlyPaletteV2 />)
    })
  })

  return (
    <div class="flex h-full w-full items-center justify-center bg-v2-background-bg-base text-v2-text-text-muted">
      <div class="flex flex-col items-center gap-2">
        <h1 class="text-[15px] text-v2-text-text-base [font-weight:620]">{props.name}</h1>
        <p class="text-[13px]">Coming soon</p>
      </div>
    </div>
  )
}

function LoopsLegacyRedirect() {
  const params = useParams<{ id?: string }>()
  return (
    <AutomationsGate>
      <Navigate href={params.id ? `/automations/${params.id}` : "/automations"} />
    </AutomationsGate>
  )
}

function NewLayoutLegacySessionRedirect() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Show when={tabs.ready()}>
      <Navigate
        href={sessionHref(
          legacySessionServer(
            tabs.store.filter((item) => item.type === "session"),
            params.id,
            server.key,
          ),
          params.id,
        )}
      />
    </Show>
  )
}
