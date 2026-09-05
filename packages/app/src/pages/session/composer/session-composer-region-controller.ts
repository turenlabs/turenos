import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useSpring } from "@turenlabs/ui/motion-spring"
import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PromptInputState } from "@/components/prompt-input"
import { useSync } from "@/context/sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import type { SessionComposerController } from "./session-composer-state"
import type { SessionGoalInfo } from "@/pages/session/goal/session-goal"

export type SessionComposerRevertDock = {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}

export type SessionComposerGoalDock = {
  goal: SessionGoalInfo
  pending?: boolean
  editRequest?: number
  onEdit: (input: { objective: string }) => void
  onPause: () => void
  onResume: () => void
  onClear: () => void
}

/**
 * Composer readiness must stay a plain signal — never a resource read.
 *
 * `prompt.ready()` only reads `.loading`/`.latest` off the persisted store's resource, so it
 * settles without ever registering with a Suspense boundary. Reading a *pending* resource here
 * instead (the shape this used to have) suspends into the nearest boundary, which on the new
 * layout is the long-lived one in `layout-new.tsx`. That boundary is already resolved, so Solid
 * takes the `Transition.promises.add(pr)` path: the router transition that mounted this session
 * never commits, the URL stays on `/new-session`, and the previous route's DOM keeps painting.
 * On desktop the persisted store is backed by async sidecar storage, so that promise is always
 * pending on first mount — which is exactly the "first submit never reaches the transcript" hang.
 * The composer already renders its own non-suspending placeholder while this is false.
 */
export function sessionPromptReady(ready: PromptInputState["ready"]) {
  return ready()
}

export function createSessionComposerRegionController(input: {
  state: SessionComposerController
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  prompt: PromptInputState
  ready: Accessor<boolean>
  centered: Accessor<boolean>
  todo: {
    collapsed: Accessor<boolean>
    onToggle: () => void
  }
  goal: Accessor<SessionComposerGoalDock | undefined>
  revert: Accessor<SessionComposerRevertDock | undefined>
  onResponseSubmit: () => void
  openParent: () => void
  setPromptRef: (el: HTMLDivElement) => void
  setDockRef: (el: HTMLDivElement) => void
}) {
  const sync = useSync()
  const [store, setStore] = createStore({
    ready: input.ready() || input.state.dock(),
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    timer = undefined
    frame = undefined
  }

  createEffect(() => {
    input.sessionKey()
    const ready = input.ready()
    const dock = input.state.dock()

    clear()
    if (store.ready || (!ready && !dock)) return
    if (dock) {
      setStore("ready", true)
      return
    }

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, 140)
    })
  })

  createEffect(() => {
    if (!input.prompt.ready()) return
    setSessionHandoff(input.sessionKey(), {
      prompt: input.prompt
        .current()
        .map((part) => {
          if (part.type === "file") return `[file:${part.path}]`
          if (part.type === "agent") return `@${part.name}`
          if (part.type === "image") return `[image:${part.filename}]`
          return part.content
        })
        .join("")
        .trim(),
    })
  })

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(el, update)
    update()
  })

  onCleanup(clear)

  const parentID = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.get(id)?.parentID : undefined
  })
  const open = createMemo(() => store.ready && input.state.dock() && !input.state.closing())
  const progress = useSpring(
    () => (open() ? 1 : 0),
    { visualDuration: 0.3, bounce: 0 },
    () => `${input.sessionKey()}\0${store.ready}`,
  )
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  return {
    state: input.state,
    centered: input.centered,
    todo: input.todo,
    goal: input.goal,
    revert: input.revert,
    onResponseSubmit: input.onResponseSubmit,
    openParent: input.openParent,
    setPromptRef: input.setPromptRef,
    setDockRef: input.setDockRef,
    parentID,
    child: () => !!parentID(),
    handoffPrompt: () => getSessionHandoff(input.sessionKey())?.prompt,
    promptReady: () => sessionPromptReady(input.prompt.ready),
    dock: () => (store.ready && input.state.dock()) || value() > 0.001,
    dockProgress: value,
    dockHeight: () => Math.max(78, store.height),
    lift: () => (input.revert()?.items.length ? 18 : 36 * value()),
    setDockBodyRef: (el: HTMLDivElement) => setStore("body", el),
  }
}

export type SessionComposerRegionController = ReturnType<typeof createSessionComposerRegionController>
