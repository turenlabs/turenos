import { Component, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { SelectV2 } from "@turenlabs/ui/v2/select-v2"
import { Switch } from "@turenlabs/ui/v2/switch-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { useTheme, type ColorScheme } from "@turenlabs/ui/theme/context"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useUpdaterAction } from "../updater-action"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "../link"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { LayoutRetirementNotice, LayoutTransitionToggle } from "./interface-transition"
import { shouldShowDebugBar } from "../debug-bar-visibility"
import { SettingsProfilerSection } from "./profiler"
import { SettingsCatalogSection } from "./catalog"
import { yolkExtension, YOLK_EXTENSION_ID } from "@/utils/extension-surface"
import { LobbyConfigurationError, normalizeLobbyAPIURL } from "@/pages/lobby-client"
import { SettingsServerPicker, SettingsServerScope } from "../settings-server-picker"
import { SettingsMcpRuntimeV2 } from "./mcp-runtime"
import { SettingsPageHeaderV2 } from "./page-header"
import { toggleLabelKey } from "./toggle-label"

/**
 * `VITE_FORGE_CHANNEL` is a build-time define (see `packages/app/vite.js`), so
 * this folds to a literal and the dev-only profiler section is eliminated from
 * beta and prod bundles rather than shipped and hidden.
 */
const PROFILER_SECTION_ENABLED = import.meta.env.VITE_FORGE_CHANNEL === "dev"
const CATALOG_SECTION_ENABLED = import.meta.env.VITE_FORGE_CHANNEL !== "prod"
import { createPermissionChecksUpdater } from "../permission-checks"
import "./settings-v2.css"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

/**
 * Server-side defaults for the retention windows (see `ConfigRetention`). They are mirrored here
 * only as input placeholders: an unset field must show what will actually happen without writing a
 * number the user never chose, because writing it would pin the value against future default
 * changes. `0` means never, and the server clamps anything above 3650 days.
 */
const RETENTION_DEFAULT = {
  toolOutputDays: 14,
  archivedSessionDays: 30,
} as const

type RetentionField = keyof typeof RETENTION_DEFAULT

type RetentionDraft = { kind: "empty" } | { kind: "invalid" } | { kind: "value"; value: number }

/**
 * `type="number"` blanks the DOM value for most junk, but "1.5" and "-3" still arrive intact, so
 * whole non-negative days are enforced here rather than trusted from the field.
 */
const parseRetentionDays = (text: string): RetentionDraft => {
  const trimmed = text.trim()
  if (trimmed === "") return { kind: "empty" }
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) return { kind: "invalid" }
  return { kind: "value", value }
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

type SettingsGeneralPage = "app" | "notifications" | "capabilities" | "experimental" | "server" | "developer"

export const SettingsGeneralV2: Component<{
  sessionID?: string
  page?: SettingsGeneralPage
}> = (props) => {
  const page = props.page ?? "app"
  if (page === "capabilities" || page === "experimental" || page === "server") {
    return (
      <SettingsServerScope>
        <SettingsGeneralContent {...props} page={page} />
      </SettingsServerScope>
    )
  }
  return <SettingsGeneralContent {...props} page={page} />
}

const SettingsGeneralContent: Component<{
  sessionID?: string
  page: SettingsGeneralPage
}> = (props) => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const settings = useSettings()
  const serverSync = useServerSync()
  const serverSdk = useServerSDK()
  const mobile = createMediaQuery("(max-width: 767px)")

  const updater = useUpdaterAction()

  const desktop = createMemo(() => platform.platform === "desktop")

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const [shells] = createResource(
    () => (props.page === "server" ? serverSdk() : undefined),
    (sdk) =>
      sdk.client.pty
        .shells()
        .then((res) => res.data ?? [])
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  const [permissionChecks, { mutate: setPermissionChecks }] = createResource(
    () => (props.page === "server" ? serverSdk() : undefined),
    (sdk) =>
      sdk.client.global.permissionChecks
        .get({ throwOnError: true })
        .then((result) => result.data.enforced)
        .catch(() => undefined),
  )

  const [yolkState, { mutate: setYolkState, refetch: refetchYolk }] = createResource(
    () => (props.page === "experimental" ? serverSdk() : undefined),
    async (sdk) => ({
      sdk,
      item: yolkExtension((await sdk.client.extension.list(undefined, { throwOnError: true })).data ?? []),
    }),
  )
  const yolk = createMemo(() => {
    const current = yolkState.latest
    return current?.sdk === serverSdk() ? current.item : undefined
  })
  const [yolkPending, setYolkPending] = createSignal(false)
  let yolkRequest: AbortController | undefined
  createEffect(() => {
    if (props.page !== "experimental") return
    serverSdk()
    yolkRequest?.abort()
    yolkRequest = undefined
    setYolkPending(false)
  })
  onCleanup(() => yolkRequest?.abort())

  const updateYolk = (enabled: boolean) => {
    if (!yolk() || yolkPending()) return
    const sdk = serverSdk()
    const request = new AbortController()
    yolkRequest?.abort()
    yolkRequest = request
    setYolkPending(true)
    void sdk.client.extension
      .update({ id: YOLK_EXTENSION_ID, extensionUpdate: { enabled } }, { signal: request.signal, throwOnError: true })
      .then((result) => {
        if (sdk === serverSdk() && !request.signal.aborted) {
          setYolkState({ sdk, item: yolkExtension(result.data ?? []) })
        }
      })
      .catch(() => {
        if (sdk === serverSdk() && !request.signal.aborted) void refetchYolk()
      })
      .finally(() => {
        if (yolkRequest !== request) return
        yolkRequest = undefined
        setYolkPending(false)
      })
  }

  const updatePermissionChecks = createPermissionChecksUpdater({
    current: permissionChecks,
    mutate: setPermissionChecks,
    read: () =>
      serverSdk()
        .client.global.permissionChecks.get({ throwOnError: true })
        .then((result) => result.data.enforced),
    update: (enforced) =>
      serverSdk()
        .client.global.permissionChecks.update({ globalPermissionChecks: { enforced } }, { throwOnError: true })
        .then((result) => result.data.enforced),
  })

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => (props.page === "app" && desktop() && platform.getPinchZoomEnabled ? true : false),
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  onMount(() => {
    if (props.page !== "app") return
    void theme.loadThemes()
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => serverSync().data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = serverSync().data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })

  /**
   * Drafts are keyed by field and only exist while a row is being edited. Binding the input
   * straight to the config would let the `PATCH /global/config` round-trip overwrite whatever the
   * user is halfway through typing.
   */
  const [retentionDrafts, setRetentionDrafts] = createSignal<Partial<Record<RetentionField, string>>>({})
  const [lobbyAPIDraft, setLobbyAPIDraft] = createSignal(settings.general.lobbyAPIURL())
  const [lobbyAPIError, setLobbyAPIError] = createSignal<string>()

  createEffect(() => {
    setLobbyAPIDraft(settings.general.lobbyAPIURL())
  })

  const saveLobbyAPIURL = (event: SubmitEvent) => {
    event.preventDefault()
    try {
      settings.general.setLobbyAPIURL(normalizeLobbyAPIURL(lobbyAPIDraft()))
      setLobbyAPIError(undefined)
    } catch (error) {
      setLobbyAPIError(error instanceof LobbyConfigurationError ? error.message : "Enter a valid lobby API URL.")
    }
  }

  const retentionConfig = () => serverSync().data.config.retention
  const retentionConfigured = (field: RetentionField) => retentionConfig()?.[field]
  const retentionEffective = (field: RetentionField) => retentionConfigured(field) ?? RETENTION_DEFAULT[field]

  const retentionText = (field: RetentionField) => {
    const draft = retentionDrafts()[field]
    if (draft !== undefined) return draft
    const configured = retentionConfigured(field)
    // Unset stays empty so the placeholder — the real default — is what the row shows.
    return configured === undefined ? "" : String(configured)
  }

  const retentionInvalid = (field: RetentionField) => {
    const draft = retentionDrafts()[field]
    return draft !== undefined && parseRetentionDays(draft).kind === "invalid"
  }

  const setRetentionDraft = (field: RetentionField, text: string) =>
    setRetentionDrafts((current) => ({ ...current, [field]: text }))

  const clearRetentionDraft = (field: RetentionField) =>
    setRetentionDrafts((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })

  const commitRetention = (field: RetentionField, text: string) => {
    const parsed = parseRetentionDays(text)
    // A malformed draft stays on screen, flagged invalid, instead of being written or silently reverted.
    if (parsed.kind === "invalid") return
    // Clearing the field is not a request to store 0; nothing is written and the default applies.
    if (parsed.kind === "empty" || retentionConfigured(field) === parsed.value) {
      clearRetentionDraft(field)
      return
    }
    // Spread the current policy: `updateConfig` is a partial patch, so writing one window bare
    // would drop the other. The draft is held until the write settles so the field does not flash
    // the previous number mid-flight, and dropping it on failure is what shows the write missed.
    void serverSync()
      .updateConfig({ retention: { ...retentionConfig(), [field]: parsed.value } })
      .then(
        () => clearRetentionDraft(field),
        () => clearRetentionDraft(field),
      )
  }

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
  })

  const InterfaceSection = () => (
    <LayoutTransitionToggle
      title={language.t("settings.general.row.newInterface.title")}
      badge={language.t("settings.general.row.newInterface.badge")}
      description={language.t("settings.general.row.newInterface.description")}
      checked={settings.general.newLayoutDesigns()}
      onChange={(checked) => {
        settings.general.setNewLayoutDesigns(checked)
        if (checked) return
        void import("@/components/dialog-settings").then((module) => {
          void dialog.show(() => <module.DialogSettings />)
        })
      }}
    />
  )

  const InterfaceNoticeSection = () => (
    <LayoutRetirementNotice
      title={language.t("settings.general.row.newInterfaceNotice.title")}
      description={language.t("settings.general.row.newInterfaceNotice.description")}
      dismiss={language.t("settings.general.row.newInterfaceNotice.dismiss")}
      onDismiss={settings.general.dismissNewInterfaceNotice}
    />
  )

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <Show when={props.page === "server"}>
        <h3 class="settings-v2-section-title">{language.t("settings.general.section.runtime")}</h3>
      </Show>
      <SettingsListV2>
        <Show when={props.page === "app"}>
          <SettingsRowV2
            title={language.t("settings.general.row.language.title")}
            description={language.t("settings.general.row.language.description")}
          >
            <SelectV2
              appearance="inline"
              data-action="settings-language"
              options={languageOptions()}
              placement="bottom-end"
              gutter={6}
              current={languageOptions().find((o) => o.value === language.locale())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && language.setLocale(option.value)}
            />
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "capabilities"}>
          <SettingsRowV2
            title={language.t("settings.general.row.memory.title")}
            description={language.t("settings.general.row.memory.description")}
          >
            <ButtonV2
              size="normal"
              variant="neutral"
              onClick={() => {
                const server = serverSdk().server
                void import("./dialog-memory-v2").then((module) =>
                  dialog.push(() => <module.DialogMemoryV2 server={server} />),
                )
              }}
            >
              {language.t("settings.general.row.memory.manage")}
            </ButtonV2>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "developer"}>
          <SettingsRowV2
            title="Turen Lobby (Beta)"
            description="Enable the experimental shared room and multiplayer agent surface. This feature is not ready for general availability."
          >
            <Switch
              data-action="settings-turen-lobby-beta"
              checked={settings.general.lobbyBetaEnabled()}
              onChange={settings.general.setLobbyBetaEnabled}
            />
          </SettingsRowV2>
          <Show when={settings.general.lobbyBetaEnabled()}>
            <SettingsRowV2
              title="Lobby URL"
              description="Specify the Turen Lobby server. Local development commonly uses http://127.0.0.1:8787. Authentication is not available yet."
            >
              <form class="settings-v2-lobby-api-url-form" onSubmit={saveLobbyAPIURL}>
                <div class="settings-v2-lobby-api-url-controls">
                  <TextInputV2
                    data-action="settings-turen-lobby-api-url"
                    class="settings-v2-lobby-api-url-input"
                    type="url"
                    appearance="base"
                    value={lobbyAPIDraft()}
                    invalid={!!lobbyAPIError()}
                    placeholder="http://127.0.0.1:8787"
                    onInput={(event) => {
                      setLobbyAPIDraft(event.currentTarget.value)
                      setLobbyAPIError(undefined)
                    }}
                    spellcheck={false}
                    autocomplete="url"
                    aria-label="Turen Lobby URL"
                  />
                  <ButtonV2 class="settings-v2-lobby-api-url-save" size="normal" variant="neutral" type="submit">
                    Save
                  </ButtonV2>
                </div>
                <Show when={lobbyAPIError()}>
                  {(error) => <p class="text-[11px] text-v2-state-fg-critical">{error()}</p>}
                </Show>
              </form>
            </SettingsRowV2>
          </Show>
        </Show>

        <Show when={props.page === "capabilities"}>
          <SettingsRowV2
            title={language.t("settings.general.row.semanticMemory.title")}
            description={language.t("settings.general.row.semanticMemory.description")}
          >
            <div data-action="settings-semantic-memory">
              <Switch
                checked={serverSync().data.config.semantic_memory?.enabled ?? false}
                disabled={serverSync().data.reload === "pending"}
                onChange={(checked) =>
                  void serverSync().updateConfig({
                    semantic_memory: {
                      ...(serverSync().data.config.semantic_memory ?? {}),
                      enabled: checked,
                      model: serverSync().data.config.semantic_memory?.model ?? "potion-base-8M",
                    },
                  })
                }
              >
                {language.t(toggleLabelKey(serverSync().data.config.semantic_memory?.enabled))}
              </Switch>
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "experimental"}>
          <SettingsRowV2
            title={yolk()?.manifest.name ?? "Yolk Change Intelligence"}
            description={
              yolk()?.manifest.description ??
              "Inspect semantic impact before edits and compare behavior after code changes"
            }
          >
            <div data-action="settings-yolk-change-intelligence" class="flex items-center gap-2">
              <Switch
                checked={yolk()?.enabled ?? false}
                disabled={!yolk() || yolkState.loading || yolkPending()}
                onChange={updateYolk}
              >
                {language.t(toggleLabelKey(yolk()?.enabled))}
              </Switch>
              <Show when={yolkState.error && !yolk()}>
                <ButtonV2 size="normal" variant="neutral" onClick={() => void refetchYolk()}>
                  Retry
                </ButtonV2>
              </Show>
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "experimental"}>
          <SettingsRowV2
            title={language.t("settings.general.row.harnessSelfModification.title")}
            description={language.t("settings.general.row.harnessSelfModification.description")}
          >
            <div data-action="settings-harness-self-modification">
              <Switch
                checked={serverSync().data.config.experimental?.harness_self_modification ?? false}
                disabled={serverSync().data.reload === "pending"}
                onChange={(checked) =>
                  void serverSync().updateConfig({
                    experimental: {
                      ...(serverSync().data.config.experimental ?? {}),
                      harness_self_modification: checked,
                    },
                  })
                }
              >
                {language.t(toggleLabelKey(serverSync().data.config.experimental?.harness_self_modification))}
              </Switch>
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "experimental"}>
          <SettingsRowV2
            title={language.t("settings.general.row.automations.title")}
            description={language.t("settings.general.row.automations.description")}
          >
            <div data-action="settings-automations">
              <Switch
                checked={settings.general.automationsEnabled()}
                onChange={settings.general.setAutomationsEnabled}
              >
                {language.t(toggleLabelKey(settings.general.automationsEnabled()))}
              </Switch>
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "server"}>
          <SettingsRowV2
            title={language.t("settings.permissions.enforce.title")}
            description={language.t("settings.permissions.enforce.description")}
          >
            <div data-action="settings-enforce-permission-checks" class="flex items-center gap-2">
              <Switch
                checked={permissionChecks() ?? false}
                disabled={permissionChecks() === undefined}
                onChange={updatePermissionChecks}
              />
              <Show when={permissionChecks() === undefined}>
                <span class="text-[12px] text-v2-text-text-muted">Unavailable</span>
              </Show>
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "server"}>
          <SettingsRowV2
            title={language.t("settings.general.row.shell.title")}
            description={language.t("settings.general.row.shell.description")}
          >
            <SelectV2
              appearance="inline"
              data-action="settings-shell"
              options={shellOptions()}
              current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
              placement="bottom-end"
              gutter={6}
              value={(o) => o.id}
              label={(o) => o.label}
              onSelect={(option) => {
                if (!option) return
                if (option.value === currentShell()) return
                serverSync().updateConfig({ shell: option.value })
              }}
            />
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "app"}>
          <SettingsRowV2
            title={language.t("settings.general.row.reasoningSummaries.title")}
            description={language.t("settings.general.row.reasoningSummaries.description")}
          >
            <div data-action="settings-feed-reasoning-summaries">
              <Switch
                checked={settings.general.showReasoningSummaries()}
                onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "app"}>
          <SettingsRowV2
            title={language.t("settings.general.row.shellToolPartsExpanded.title")}
            description={language.t("settings.general.row.shellToolPartsExpanded.description")}
          >
            <div data-action="settings-feed-shell-tool-parts-expanded">
              <Switch
                checked={settings.general.shellToolPartsExpanded()}
                onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "app"}>
          <SettingsRowV2
            title={language.t("settings.general.row.editToolPartsExpanded.title")}
            description={language.t("settings.general.row.editToolPartsExpanded.description")}
          >
            <div data-action="settings-feed-edit-tool-parts-expanded">
              <Switch
                checked={settings.general.editToolPartsExpanded()}
                onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <Show when={props.page === "app" && mobile()}>
          <SettingsRowV2
            title={language.t("settings.general.row.mobileTitlebarBottom.title")}
            description={language.t("settings.general.row.mobileTitlebarBottom.description")}
          >
            <div data-action="settings-mobile-titlebar-bottom">
              <Switch
                checked={settings.general.mobileTitlebarPosition() === "bottom"}
                onChange={(checked) => settings.general.setMobileTitlebarPosition(checked ? "bottom" : "top")}
              />
            </div>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </div>
  )

  const RetentionRow = (props: {
    field: RetentionField
    action: string
    title: string
    description: string
    label: string
  }) => (
    <SettingsRowV2 title={props.title} description={props.description}>
      <div class="w-full sm:w-[220px]">
        <TextInputV2
          data-action={props.action}
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          numeric
          appearance="base"
          invalid={retentionInvalid(props.field)}
          value={retentionText(props.field)}
          placeholder={String(RETENTION_DEFAULT[props.field])}
          onInput={(event) => setRetentionDraft(props.field, event.currentTarget.value)}
          onChange={(event) => commitRetention(props.field, event.currentTarget.value)}
          spellcheck={false}
          autocomplete="off"
          aria-label={props.label}
        />
      </div>
    </SettingsRowV2>
  )

  const RetentionSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.retention")}</h3>

      <p class="settings-v2-section-note" data-rule="notch">
        {language.t("settings.general.retention.scope")}
      </p>

      <SettingsListV2>
        <RetentionRow
          field="toolOutputDays"
          action="settings-retention-tool-output"
          title={language.t("settings.general.row.retentionToolOutput.title")}
          description={
            retentionEffective("toolOutputDays") === 0
              ? language.t("settings.general.retention.never")
              : language.t("settings.general.row.retentionToolOutput.description", {
                  days: retentionEffective("toolOutputDays"),
                })
          }
          label={language.t("settings.general.row.retentionToolOutput.label")}
        />

        <RetentionRow
          field="archivedSessionDays"
          action="settings-retention-archived-sessions"
          title={language.t("settings.general.row.retentionArchivedSessions.title")}
          description={
            retentionEffective("archivedSessionDays") === 0
              ? language.t("settings.general.retention.never")
              : language.t("settings.general.row.retentionArchivedSessions.description", {
                  days: retentionEffective("archivedSessionDays"),
                })
          }
          label={language.t("settings.general.row.retentionArchivedSessions.label")}
        />
      </SettingsListV2>
    </div>
  )

  const InterfacePreferencesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.interface")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.showFileTree.title")}
          description={language.t("settings.general.row.showFileTree.description")}
        >
          <div data-action="settings-show-file-tree">
            <Switch
              checked={settings.general.showFileTree()}
              onChange={(checked) => settings.general.setShowFileTree(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showSearch.title")}
          description={language.t("settings.general.row.showSearch.description")}
        >
          <div data-action="settings-show-search">
            <Switch
              checked={settings.general.showSearch()}
              onChange={(checked) => settings.general.setShowSearch(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showStatus.title")}
          description={language.t("settings.general.row.showStatus.description")}
        >
          <div data-action="settings-show-status">
            <Switch
              checked={settings.general.showStatus()}
              onChange={(checked) => settings.general.setShowStatus(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showCustomAgents.title")}
          description={language.t("settings.general.row.showCustomAgents.description")}
        >
          <div data-action="settings-show-custom-agents">
            <Switch
              checked={settings.general.showCustomAgents()}
              onChange={(checked) => settings.general.setShowCustomAgents(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const DiagnosticsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.diagnostics")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.performanceDiagnostics.title")}
          description={language.t("settings.general.row.performanceDiagnostics.description")}
        >
          <div data-action="settings-show-performance-diagnostics">
            <Switch
              checked={settings.general.showPerformanceDiagnostics()}
              onChange={(checked) => settings.general.setShowPerformanceDiagnostics(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const AppearanceSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.appearance")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link class="settings-v2-link" href="https://github.com/turenlabs/forge/docs/themes/">
                {language.t("common.learnMore")}
              </Link>
            </>
          }
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-ui-font"
              type="text"
              appearance="base"
              value={sans()}
              onInput={(event) => settings.appearance.setUIFont(event.currentTarget.value)}
              placeholder={sansDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.uiFont.title")}
              style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-code-font"
              type="text"
              appearance="base"
              value={mono()}
              onInput={(event) => settings.appearance.setFont(event.currentTarget.value)}
              placeholder={monoDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.font.title")}
              style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.terminalFont.title")}
          description={language.t("settings.general.row.terminalFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-terminal-font"
              type="text"
              appearance="base"
              value={terminal()}
              onInput={(event) => settings.appearance.setTerminalFont(event.currentTarget.value)}
              placeholder={terminalDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.terminalFont.title")}
              style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const NotificationsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const SoundsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <ButtonV2 size="normal" variant="neutral" disabled={!updater.action().run} onClick={updater.run}>
            {language.t(updater.action().label)}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  // We can probably remove this, right?
  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.general.section.display")}</h3>

        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRowV2>
        </SettingsListV2>
      </div>
    </Show>
  )

  const pageCopy = createMemo(() => {
    language.locale()
    return {
      app: {
        title: language.t("settings.tab.appInterface"),
        description: language.t("settings.appInterface.description"),
        scope: language.t("settings.scope.device"),
      },
      notifications: {
        title: language.t("settings.notifications.title"),
        description: language.t("settings.notifications.description"),
        scope: language.t("settings.scope.device"),
      },
      capabilities: {
        title: language.t("settings.capabilities.title"),
        description: language.t("settings.capabilities.description"),
        scope: language.t("settings.scope.selectedServer"),
      },
      experimental: {
        title: language.t("settings.experimental.title"),
        description: language.t("settings.experimental.description"),
        scope: language.t("settings.scope.selectedServer"),
      },
      server: {
        title: language.t("settings.serverSettings.title"),
        description: language.t("settings.serverSettings.description"),
        scope: language.t("settings.scope.selectedServer"),
      },
      developer: {
        title: language.t("settings.developer.title"),
        description: language.t("settings.developer.description"),
        scope: language.t("settings.scope.mixed"),
      },
    }[props.page]
  })
  const serverScoped = props.page === "capabilities" || props.page === "experimental" || props.page === "server"

  return (
    <>
      <SettingsPageHeaderV2
        title={pageCopy().title}
        description={pageCopy().description}
        scope={pageCopy().scope}
        actions={serverScoped ? <SettingsServerPicker /> : undefined}
      />

      <div class="settings-v2-tab-body">
        <Show when={props.page === "app"}>
          <GeneralSection />
          <AppearanceSection />
          <InterfacePreferencesSection />
          <Show when={desktop()}>
            <UpdatesSection />
          </Show>
          <DisplaySection />
        </Show>

        <Show when={props.page === "notifications"}>
          <NotificationsSection />
          <SoundsSection />
        </Show>

        <Show when={props.page === "capabilities"}>
          <GeneralSection />
        </Show>

        <Show when={props.page === "experimental"}>
          <GeneralSection />
        </Show>

        <Show when={props.page === "server"}>
          <GeneralSection />
          <RetentionSection />
          <SettingsMcpRuntimeV2 embedded />
        </Show>

        <Show when={props.page === "developer"}>
          <Show when={settings.general.layoutTransitionAvailable()}>
            <InterfaceSection />
          </Show>
          <Show when={settings.general.newInterfaceNoticeVisible()}>
            <InterfaceNoticeSection />
          </Show>
          <GeneralSection />
          <Show when={shouldShowDebugBar(true)}>
            <DiagnosticsSection />
          </Show>
          {PROFILER_SECTION_ENABLED && (
            <Show when={!!platform.profiler}>
              <SettingsProfilerSection />
            </Show>
          )}
          {CATALOG_SECTION_ENABLED && <SettingsCatalogSection />}
        </Show>
      </div>
    </>
  )
}
