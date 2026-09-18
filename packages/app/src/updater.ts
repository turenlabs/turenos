import type { Accessor } from "solid-js"

export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterSnapshot = {
  state: UpdaterState
  /** Releases behind latest the updater tracks: 0 = latest, 1 = n-1, 2 = n-2 */
  lag: number
}

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  lag: Accessor<number>
  check(): Promise<UpdaterState>
  install(): Promise<void>
  setLag(lag: number): Promise<void>
}
