import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@turenlabs/ui/icon"
import { whiteboardFontBase } from "./assets"
import type { Whiteboard } from "@turenlabs/schema/whiteboard"
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types"
import { createWhiteboardSync, orderElements, validElement, validFile } from "./sync"
import type { SyncStatus, WhiteboardTransport } from "./sync"
import { createIndexedDBOutbox } from "./outbox"
import { whiteboardClientID } from "./identity"
import "./whiteboard.css"

export type { WhiteboardTransport } from "./sync"
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}
export interface WhiteboardCanvasProps {
  sessionID: string
  storageKey: string
  transport: WhiteboardTransport
  theme: "light" | "dark"
  username?: string
  active?: boolean
}
export function participantColor(id: string) {
  return `hsl(${Array.from(id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 360} 65% 55%)`
}

export function WhiteboardCanvas(props: WhiteboardCanvasProps) {
  let container!: HTMLDivElement
  let api: ExcalidrawImperativeAPI | undefined
  let retry = () => {}
  const [view, setView] = createStore({
    status: "Saving" as SyncStatus,
    error: "",
    empty: true,
    participants: [] as Whiteboard.PresenceSnapshot["participants"],
  })
  createEffect(() => {
    const sessionID = props.sessionID
    const transport = props.transport
    const clientID = whiteboardClientID(props.storageKey)
    const username = (props.username?.trim() || `Guest ${clientID.slice(0, 4)}`).slice(0, 128)
    let disposed = false
    let applying = false
    let root: import("react-dom/client").Root | undefined
    let engine: typeof import("@excalidraw/excalidraw") | undefined
    let lastPointer = 0
    let pointer: Whiteboard.PresenceInput["pointer"]
    let latest: { elements: readonly Whiteboard.Element[]; files: Whiteboard.Snapshot["files"] } | undefined
    const sync = createWhiteboardSync({
      sessionID,
      transport,
      clientID,
      username,
      persistence: createIndexedDBOutbox(props.storageKey),
      status: (status) => setView("status", status),
      warning: (error) => setView("error", error),
      scene(elements, files) {
        latest = { elements, files }
        if (!api || !engine || disposed) return
        applying = true
        const restored = engine.restoreElements(
          orderElements(elements.filter(validElement)) as unknown as Parameters<typeof engine.restoreElements>[0],
          null,
        )
        const reconciled = engine.reconcileElements(
          api.getSceneElementsIncludingDeleted(),
          restored as unknown as Parameters<typeof engine.reconcileElements>[1],
          api.getAppState(),
        )
        api.addFiles(Object.values(files).filter(validFile) as unknown as Parameters<typeof api.addFiles>[0])
        api.updateScene({ elements: reconciled, captureUpdate: engine.CaptureUpdateAction.NEVER })
        setView("empty", !reconciled.some((element) => !element.isDeleted))
        applying = false
      },
      participants(value) {
        if (disposed) return
        const others = value.filter((person) => person.clientID !== clientID && person.updatedAt > Date.now() - 30000)
        setView("participants", others)
        if (!api || !engine) return
        api.updateScene({
          collaborators: new Map(
            others.map((person) => [
              person.clientID,
              {
                id: person.clientID,
                username: person.username,
                pointer: person.pointer ? { ...person.pointer, tool: "pointer" as const } : undefined,
                selectedElementIds: Object.fromEntries(
                  (person.selectedElementIds ?? []).slice(0, 5000).map((id) => [id, true]),
                ),
                color: { background: participantColor(person.clientID), stroke: participantColor(person.clientID) },
              },
            ]),
          ) as AppState["collaborators"],
          captureUpdate: engine.CaptureUpdateAction.NEVER,
        })
      },
    })
    retry = () => sync.retry()
    const presence = () => {
      if (props.active === false || disposed) return
      void sync.presence({
        pointer,
        selectedElementIds: Object.keys(api?.getAppState().selectedElementIds ?? {})
          .filter((id) => id.length <= 128)
          .slice(0, 5000),
      })
    }
    const heartbeat = setInterval(presence, 10000)
    const unload = (event: BeforeUnloadEvent) => {
      if (!sync.dirty()) return
      event.preventDefault()
      event.returnValue = "Whiteboard changes are not saved yet."
      void sync.flush()
    }
    window.addEventListener("beforeunload", unload)
    // Set before importing Excalidraw: font paths are resolved during lazy initialization.
    window.EXCALIDRAW_ASSET_PATH = whiteboardFontBase(import.meta.env.DEV, import.meta.env.BASE_URL, window.location.href, import.meta.url)
    void Promise.all([
      import("react"),
      import("react-dom/client"),
      import("@excalidraw/excalidraw"),
      import("@excalidraw/excalidraw/index.css"),
      sync.initialize(),
    ])
      .then(([react, dom, excalidraw]) => {
        if (disposed) return
        engine = excalidraw
        const createElement = react.createElement
        root = dom.createRoot(container)
        const canvasProps: ExcalidrawProps = {
          name: `Whiteboard ${sessionID}`,
          isCollaborating: true,
          aiEnabled: false,
          initialData: { appState: { theme: props.theme } },
          handleKeyboardGlobally: false,
          validateEmbeddable: () => false,
          renderEmbeddable: () => null,
          generateIdForFile(file) {
            if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 2_900_000) {
              throw new Error("Use a PNG, JPEG, GIF, or WebP image smaller than 2.9 MB.")
            }
            return crypto.randomUUID()
          },
          onLinkOpen: (_element, event) => event.preventDefault(),
          UIOptions: { canvasActions: { export: { saveFileToDisk: true }, toggleTheme: true } },
          excalidrawAPI(value) {
            if (disposed) return
            api = value
            if (latest) sync.reapply()
            presence()
          },
          onChange(elements, state, files) {
            if (disposed || applying) return
            const supported = elements.filter(
              (element) =>
                validElement(element as unknown as Whiteboard.Element) &&
                (element.type !== "image" ||
                  !element.fileId ||
                  (files[element.fileId] && validFile(files[element.fileId]))),
            )
            if (supported.length !== elements.length) {
              applying = true
              try {
                api?.updateScene({ elements: supported, captureUpdate: excalidraw.CaptureUpdateAction.NEVER })
              } finally {
                applying = false
              }
              setView("error", "Web embeds and unsupported images are disabled. Use PNG, JPEG, GIF, or WebP images.")
            }
            setView("empty", !supported.some((element) => !element.isDeleted))
            // Disable the upstream library browser/publisher, including its keyboard entrypoint.
            if (state.openSidebar || state.openDialog?.name === "ttd") {
              api?.updateScene({
                appState: { openSidebar: null, openDialog: null },
                captureUpdate: excalidraw.CaptureUpdateAction.NEVER,
              })
            }
            sync.change(
              supported.map((element) => ({ ...element, link: null })) as unknown as readonly Whiteboard.Element[],
              files as unknown as Whiteboard.Snapshot["files"],
            )
          },
          onPointerUpdate(value) {
            pointer = value.pointer
            if (Date.now() - lastPointer < 90) return
            lastPointer = Date.now()
            presence()
          },
          onPointerUp() {
            queueMicrotask(() => {
              if (!disposed) sync.reapply()
            })
          },
        }
        root.render(
          createElement(
            excalidraw.Excalidraw,
            canvasProps,
            createElement(
              excalidraw.MainMenu,
              null,
              createElement(excalidraw.MainMenu.DefaultItems.LoadScene),
              createElement(excalidraw.MainMenu.DefaultItems.SaveToActiveFile),
              createElement(excalidraw.MainMenu.DefaultItems.SaveAsImage),
              createElement(excalidraw.MainMenu.DefaultItems.ClearCanvas),
              createElement(excalidraw.MainMenu.Separator),
              createElement(excalidraw.MainMenu.DefaultItems.ToggleTheme),
              createElement(excalidraw.MainMenu.DefaultItems.ChangeCanvasBackground),
            ),
          ),
        )
        sync.start()
      })
      .catch((error) => {
        if (!disposed) {
          console.error("[whiteboard] editor initialization failed", error)
          setView({
            error: `The drawing editor could not load: ${error instanceof Error ? error.message : "unknown error"}`,
            status: "Offline",
          })
        }
      })
    onCleanup(() => {
      disposed = true
      clearInterval(heartbeat)
      window.removeEventListener("beforeunload", unload)
      void sync.dispose()
      api = undefined
      root?.unmount()
    })
  })
  createEffect(() => {
    api?.updateScene({ appState: { theme: props.theme } })
  })
  return (
    <section class="session-whiteboard" aria-label="Session whiteboard">
      <header class="whiteboard-header">
        <div class="whiteboard-title">
          <Icon name="edit" size="small" /> Whiteboard
        </div>
        <div class="whiteboard-people" aria-label={`${view.participants.length + 1} participants`}>
          <For each={view.participants.slice(0, 5)}>
            {(person) => (
              <span
                class="whiteboard-avatar"
                title={person.username}
                style={{ background: participantColor(person.clientID) }}
              >
                {person.username.slice(0, 1).toUpperCase()}
              </span>
            )}
          </For>
          <span>{view.participants.length + 1} online</span>
        </div>
        <span class="whiteboard-status" data-status={view.status} role="status">
          <i />
          {view.status}
        </span>
        <Show when={view.status === "Offline"}>
          <button type="button" onClick={() => retry()}>
            Retry
          </button>
        </Show>
        <button
          type="button"
          title="Fit drawing to canvas"
          onClick={() => api?.scrollToContent(undefined, { fitToViewport: true })}
        >
          Fit canvas
        </button>
      </header>
      <Show when={view.error || view.status === "Offline"}>
        <div class="whiteboard-warning" role="alert">
          {view.error ||
            "Connection interrupted. Changes are queued for recovery. Reconnect to sync, or export a local copy."}
        </div>
      </Show>
      <div class="whiteboard-stage">
        <div ref={container} class="whiteboard-editor" />
        <Show when={view.empty && !view.error}>
          <div class="whiteboard-tips">
            <strong>A little space for big ideas</strong>
            <span>Draw a shape, connect ideas with arrows, or double-click to add text.</span>
            <small>V select · R rectangle · A arrow · T text · Space drag to pan</small>
          </div>
        </Show>
      </div>
    </section>
  )
}
