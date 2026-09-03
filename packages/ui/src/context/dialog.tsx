import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  canClose?: () => boolean
  setClosing: (closing: boolean) => void
  closing: () => boolean
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value || current.canClose?.() === false) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    const closed = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== closed))
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (stack().length === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const mount = (
    element: DialogElement,
    owner: Owner,
    onClose: (() => void) | undefined,
    canClose: (() => boolean) | undefined,
    layer: number,
  ) => {
    const id = Math.random().toString(36).slice(2)
    const zIndex = 50 + layer * 10
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined
    let closing: (() => boolean) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closingSignal, setClosingSignal] = createSignal(false)
        closing = closingSignal
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closingSignal()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay
                data-component="dialog-overlay"
                style={{ "z-index": String(zIndex) }}
                onClick={() => close(id)}
              />
              <div
                data-dialog-layer={layer}
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": String(zIndex),
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "pointer-events": "none",
                }}
              >
                {element()}
              </div>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing || !closing) return

    const active: Active = { id, node, dispose, owner, onClose, canClose, setClosing, closing }
    setStack((items) => [...items, active])
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void, canClose?: () => boolean) => {
    const items = stack()
    const active = items.filter((item) => !item.closing())
    if (active.length !== items.length) {
      items.filter((item) => item.closing()).forEach((item) => item.dispose())
      setStack(active)
    }
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, canClose, active.length)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void, canClose?: () => boolean) => {
    for (const item of stack()) item.dispose()
    setStack([])
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, canClose, 0)
  }

  return {
    stack,
    close,
    show,
    push,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      // `close()` marks the top entry as closing and starts its exit animation
      // immediately, but only drops it from `stack` ~100ms later once `dispose()`
      // runs (see `close` above) - that delay lets the animation finish. Keybind
      // gates read `active` synchronously on every keydown, so if this returned the
      // closing entry it would keep swallowing input for that whole 100ms window
      // after the dialog is already visually gone. Skip closing entries instead of
      // waiting on the teardown timer.
      const top = ctx.stack().at(-1)
      return top && !top.closing() ? top : undefined
    },
    show(element: DialogElement, onClose?: () => void, canClose?: () => boolean) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.show(element, base, onClose, canClose))
    },
    push(element: DialogElement, onClose?: () => void, canClose?: () => boolean) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.push(element, base, onClose, canClose))
    },
    close() {
      ctx.close()
    },
  }
}
