const traceWindowMs = 15_000

type Interaction = {
  id: string
  sessionID?: string
  startedAt: number
}

let current: Interaction | undefined
let listening = false
let longTaskObserver: PerformanceObserver | undefined
let longTaskTimer: number | undefined

export function beginSessionInteractionTrace(input: { sessionID?: string; eventType: string }) {
  const interaction = {
    id: crypto.randomUUID(),
    sessionID: input.sessionID,
    startedAt: performance.now(),
  }
  current = interaction
  listenForInput()
  observeLongTasks(interaction)
  write(interaction, "submit.started", {
    eventType: input.eventType,
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  })

  const timerStarted = performance.now()
  window.setTimeout(() => {
    writeIfCurrent(interaction, "renderer.next-task", { delayMs: performance.now() - timerStarted })
  }, 0)
  requestAnimationFrame(() => {
    writeIfCurrent(interaction, "renderer.next-frame")
  })

  return interaction.id
}

export function sessionInteractionTrace(event: string, detail: Record<string, unknown> = {}) {
  const interaction = active()
  if (!interaction) return
  write(interaction, event, detail)
}

function active() {
  if (!current) return
  if (performance.now() - current.startedAt <= traceWindowMs) return current
  current = undefined
}

function writeIfCurrent(interaction: Interaction, event: string, detail: Record<string, unknown> = {}) {
  if (current?.id !== interaction.id) return
  write(interaction, event, detail)
}

function write(interaction: Interaction, event: string, detail: Record<string, unknown> = {}) {
  const now = performance.now()
  console.info(
    "[session.interaction]",
    JSON.stringify({
      event,
      traceID: interaction.id,
      sessionID: interaction.sessionID,
      atMs: Math.round(now),
      sinceSubmitMs: Math.round((now - interaction.startedAt) * 10) / 10,
      ...detail,
    }),
  )
}

function listenForInput() {
  if (listening) return
  if (typeof document === "undefined") return
  listening = true
  document.addEventListener(
    "pointerdown",
    (event) => {
      const interaction = active()
      if (!interaction) return
      const element = event.target instanceof Element ? event.target : undefined
      const tab = element?.closest<HTMLElement>("[data-tab-key]")
      write(interaction, "input.pointerdown", {
        inputDelayMs: inputDelay(event.timeStamp),
        pointerType: event.pointerType,
        target: tab ? "tab" : (element?.getAttribute("data-action") ?? element?.tagName.toLowerCase()),
        targetTab: tab?.dataset.tabKey,
      })
    },
    true,
  )
}

function inputDelay(timeStamp: number) {
  const relative = timeStamp > performance.timeOrigin ? timeStamp - performance.timeOrigin : timeStamp
  return Math.round(Math.max(0, performance.now() - relative) * 10) / 10
}

function observeLongTasks(interaction: Interaction) {
  longTaskObserver?.disconnect()
  if (longTaskTimer !== undefined) window.clearTimeout(longTaskTimer)
  if (typeof PerformanceObserver === "undefined") return
  if (!(PerformanceObserver.supportedEntryTypes ?? []).includes("longtask")) return

  longTaskObserver = new PerformanceObserver((list) => {
    list.getEntries().forEach((entry) => {
      writeIfCurrent(interaction, "renderer.long-task", {
        durationMs: Math.round(entry.duration * 10) / 10,
        startSinceSubmitMs: Math.round((entry.startTime - interaction.startedAt) * 10) / 10,
      })
    })
  })
  longTaskObserver.observe({ type: "longtask", buffered: true })
  longTaskTimer = window.setTimeout(() => {
    longTaskObserver?.disconnect()
    longTaskObserver = undefined
    longTaskTimer = undefined
  }, traceWindowMs)
}
