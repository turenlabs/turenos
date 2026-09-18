import type { DesktopMenuAction } from "@turenlabs/app/desktop-menu"
import type { WslServersPlatform } from "@turenlabs/app/wsl/types"
import type { SshServersPlatform } from "@turenlabs/app/ssh/types"
import type { UpdaterSnapshot, UpdaterState } from "@turenlabs/app/updater"
import type { ProfilerPlatform } from "@turenlabs/app/profiler"
import type { SecurityProxy } from "@turenlabs/schema/security-proxy"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslForgeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@turenlabs/app/wsl/types"
export type {
  SshForgeCheck,
  SshHostProbe,
  SshJob,
  SshPrompt,
  SshPromptKind,
  SshRuntimeCheck,
  SshServerConfig,
  SshServerItem,
  SshServerRuntime,
  SshServersEvent,
  SshServersState,
  SshTargetInput,
} from "@turenlabs/app/ssh/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type SshServersAPI = SshServersPlatform
/** Dev builds only; absent from the bridge in beta and prod builds. */
export type ProfilerAPI = ProfilerPlatform
export type UpdaterAPI = {
  subscribe: (cb: (snapshot: UpdaterSnapshot) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
  setLag: (lag: number) => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  sshServers: SshServersAPI
  /** Present only in dev builds - the bridge omits it entirely otherwise. */
  profiler?: ProfilerAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: () => Promise<void>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  getWindowID: () => Promise<string>
  getWindowLastActiveUrl: (legacy: { readable: boolean; value: string | null }) => Promise<string>
  setWindowLastActiveUrl: (value: string) => Promise<void>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<{ bytes: ArrayBuffer; size: number }>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  securityProxy: SecurityProxy.Platform & { onFocus(callback: (caseID: string) => void): () => void }
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
}
