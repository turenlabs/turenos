import {
  createLobbyClient,
  isLobbyNetworkError,
  loadLobbyDirectory,
  lobbyErrorMessage,
  normalizeLobbyAPIURL,
  type LobbyClient,
  type LobbyRoom,
} from "./lobby-client"

export type LobbyConnection = "not_configured" | "connecting" | "connected" | "offline" | "local_error"

export type LobbyDirectoryState = {
  connection: LobbyConnection
  rooms: LobbyRoom[]
  error?: string
}

export function createLobbyDirectoryController(input: {
  createClient?(baseURL: string): LobbyClient
  onState(state: LobbyDirectoryState): void
  retryDelayMs?: number
}) {
  const createClient = input.createClient ?? ((baseURL) => createLobbyClient({ baseURL }))
  const retryDelayMs = input.retryDelayMs ?? 3_000
  let client: LobbyClient | undefined
  let request: AbortController | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let baseURL = ""
  let generation = 0

  const stop = () => {
    request?.abort()
    request = undefined
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
  }

  const refresh = (configuredURL: string) => {
    generation += 1
    const current = generation
    stop()
    try {
      baseURL = normalizeLobbyAPIURL(configuredURL)
    } catch (error) {
      client = undefined
      input.onState({ connection: "local_error", rooms: [], error: lobbyErrorMessage(error, "Invalid lobby API URL.") })
      return
    }
    if (!baseURL) {
      client = undefined
      input.onState({ connection: "not_configured", rooms: [] })
      return
    }

    client = createClient(baseURL)
    const controller = new AbortController()
    request = controller
    input.onState({ connection: "connecting", rooms: [] })
    void loadLobbyDirectory(client, controller.signal).then(
      (rooms) => {
        if (controller.signal.aborted || current !== generation) return
        input.onState({ connection: "connected", rooms })
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== generation) return
        if (isLobbyNetworkError(error)) {
          input.onState({ connection: "offline", rooms: [], error: lobbyErrorMessage(error, "The lobby is offline.") })
          retry = setTimeout(() => refresh(baseURL), retryDelayMs)
          return
        }
        input.onState({
          connection: "local_error",
          rooms: [],
          error: lobbyErrorMessage(error, "The lobby returned an invalid response."),
        })
      },
    )
  }

  return {
    refresh,
    client: () => client,
    dispose: stop,
  }
}
