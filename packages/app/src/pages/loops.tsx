import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { FieldV2 } from "@turenlabs/ui/v2/field-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { IconButtonV2 } from "@turenlabs/ui/v2/icon-button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@turenlabs/ui/v2/segmented-control-v2"
import { SelectV2 } from "@turenlabs/ui/v2/select-v2"
import { TextareaV2 } from "@turenlabs/ui/v2/textarea-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useNavRail } from "@/components/nav-rail"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { PageHeader } from "@/components/page-header"
import { modelEffortDisplay } from "@/components/model-selection-display"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { isRemovedProvider } from "@/hooks/provider-visibility"
import { loopApi, loopCatalog, responseData, type LoopInfo, type LoopModel, type LoopRun } from "./loops/api"
import {
  buildTriggerInput,
  formatInterval,
  parseEventPaths,
  parseInterval,
  triggerFromAutomation,
  validateCronExpression,
  validateDebounceMs,
  validateGlobPattern,
  validateTimezone,
  type SessionOutcomeFilter,
  type TriggerDraft,
  type TriggerKind,
} from "./loops/trigger"
import {
  currentStepIndex,
  failedCallout,
  isActiveRun,
  latestRunTone,
  orderedStepOutputs,
  runProgressLabel,
  runTotal,
  STEP_STATE_LABEL,
  STEP_STATE_TONE,
  stepChipFor,
  stepDisplay,
  stepState,
  triggerSummary,
  type StepState,
} from "./loops/run-view"
import { localLoopServer } from "./loops/local-server"
import { nextRunLabel } from "./loops/latest-runs-data"
import { RunChatDialog } from "./loops/run-chat"
import { automationSortOptions, sortAutomations, type AutomationSort } from "./loops/sort"
import {
  agentDraft,
  renameStep,
  skillDraft,
  stepSummary,
  toDrafts,
  toWorkflowSteps,
  type StepDraft,
} from "./loops/workflow"
import "./loops.css"

const SURFACE = "flex h-full min-h-0 w-full min-w-0 flex-col bg-v2-background-bg-base"
const PANEL = "rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01"
const MAX_STEPS = 12
const STATUS_TONE: Record<LoopInfo["status"], string> = {
  active: "bg-v2-state-bg-success text-v2-state-fg-success",
  paused: "bg-v2-background-bg-layer-03 text-v2-text-text-muted",
  expired: "bg-v2-state-bg-warning text-v2-state-fg-warning",
}
const RUN_TONE: Record<LoopRun["status"], string> = {
  succeeded: "bg-v2-state-fg-success",
  failed: "bg-v2-state-fg-danger",
  cancelled: "bg-v2-text-text-muted",
  skipped: "bg-v2-text-text-muted",
  stale: "bg-v2-state-fg-warning",
  claimed: "bg-v2-state-fg-warning",
  running: "bg-v2-state-fg-warning",
}

type Workflow = NonNullable<LoopInfo["workflow"]>
type StepType = StepDraft["type"]
type NodeSelection = "trigger" | "delivery" | string

const TRIGGER_KIND_OPTIONS: Array<{ value: TriggerKind; label: string }> = [
  { value: "interval", label: "Interval" },
  { value: "cron", label: "Cron" },
  { value: "file-change", label: "File change" },
  { value: "session-end", label: "Session end" },
]

const SESSION_OUTCOME_OPTIONS: Array<{ value: SessionOutcomeFilter; label: string }> = [
  { value: "both", label: "Both outcomes" },
  { value: "success", label: "Success only" },
  { value: "failure", label: "Failure only" },
]

const invalidStepBinding = (steps: readonly StepDraft[]) =>
  steps.find((step, index) => {
    const available = new Set(steps.slice(0, index).map((item) => item.id))
    const template = step.type === "agent" ? step.prompt : step.instructions
    return [...template.matchAll(/{{\s*steps\.([A-Za-z][A-Za-z0-9_-]*)\./g)].some((match) => !available.has(match[1]))
  })

/**
 * Model selections are carried as `providerID/id` and the effort tier separately, rather
 * than encoded into one string: provider model IDs may themselves contain separators.
 */
const modelKey = (model?: { providerID: string; id: string }) => (model ? `${model.providerID}/${model.id}` : "")

const modelRef = (value: string, variant?: string) => {
  if (!value) return null
  const split = value.indexOf("/")
  if (split === -1) return null
  return { providerID: value.slice(0, split), id: value.slice(split + 1), ...(variant ? { variant } : {}) }
}

const automationPath = (id: string) => `/automations/${id}`

const runDuration = (run: LoopRun) => {
  const started = Number(run.time.started)
  const completed = Number(run.time.completed)
  if (run.time.started === undefined || run.time.completed === undefined) return
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return
  return `${((completed - started) / 1000).toFixed(1)}s`
}

const runStatusLabel = (status: LoopRun["status"]) => {
  if (status === "succeeded") return "Healthy"
  if (status === "running" || status === "claimed") return "Running"
  if (status === "stale") return "Stale"
  if (status === "failed") return "Failed"
  if (status === "skipped") return "Skipped"
  return "Cancelled"
}

function RunStepCard(props: {
  stepID: string
  name: string
  index: number
  total: number
  state: StepState
  output: LoopRun["outputs"][string]
}) {
  const [expanded, setExpanded] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [mode, setMode] = createSignal<"text" | "json">(props.output.text ? "text" : "json")
  let timer: number | undefined
  onCleanup(() => window.clearTimeout(timer))
  const hasJson = () => props.output.json !== undefined
  const body = () =>
    mode() === "json" && hasJson()
      ? JSON.stringify(props.output.json, null, 2)
      : props.output.text || JSON.stringify(props.output.json ?? null, null, 2)
  const copy = () => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    window.clearTimeout(timer)
    void clipboard.writeText(body()).then(
      () => {
        setCopied(true)
        timer = window.setTimeout(() => setCopied(false), 1_500)
      },
      () => setCopied(false),
    )
  }

  return (
    <div
      data-component="automation-run-step"
      data-step-id={props.stepID}
      class="rounded-[7px] border border-v2-border-border-subtle bg-v2-background-bg-layer-02 px-3 py-2"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class={`shrink-0 rounded-full px-2 py-0.5 text-[10px] [font-weight:550] ${STEP_STATE_TONE[props.state]}`}>
            {STEP_STATE_LABEL[props.state]}
          </span>
          <code class="truncate text-[10px] text-v2-text-text-base">
            {props.index + 1}/{props.total} · {props.name}
          </code>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span class="text-[10px] tabular-nums text-v2-text-text-muted">
            {props.output.artifacts.length} artifact{props.output.artifacts.length === 1 ? "" : "s"}
          </span>
          <Show when={hasJson()}>
            <span class="inline-flex overflow-hidden rounded-[5px] border border-v2-border-border-base font-mono text-[10px]">
              <button
                type="button"
                data-action="automation-run-view-text"
                aria-pressed={mode() === "text"}
                class={`px-2 py-0.5 outline-none ${mode() === "text" ? "bg-v2-background-bg-layer-03 text-v2-text-text-strong" : "text-v2-text-text-muted hover:text-v2-text-text-base"}`}
                onClick={() => setMode("text")}
              >
                text
              </button>
              <button
                type="button"
                data-action="automation-run-view-json"
                aria-pressed={mode() === "json"}
                class={`px-2 py-0.5 outline-none ${mode() === "json" ? "bg-v2-background-bg-layer-03 text-v2-text-text-strong" : "text-v2-text-text-muted hover:text-v2-text-text-base"}`}
                onClick={() => setMode("json")}
              >
                json
              </button>
            </span>
          </Show>
          <button
            type="button"
            data-action="automation-run-copy"
            class="font-mono text-[10px] text-v2-text-text-info hover:text-v2-text-text-strong"
            onClick={copy}
          >
            {copied() ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            data-action="automation-run-toggle"
            aria-expanded={expanded()}
            class="font-mono text-[10px] text-v2-text-text-info hover:text-v2-text-text-strong"
            onClick={() => setExpanded(!expanded())}
          >
            {expanded() ? "Less" : "More"}
          </button>
        </div>
      </div>
      <pre
        class={`mt-1 whitespace-pre-wrap text-[11px] leading-4 text-v2-text-text-muted ${expanded() ? "" : "max-h-24 overflow-auto"}`}
      >
        {body()}
      </pre>
      <Show when={props.output.artifacts.length}>
        <ul class="mt-1 grid gap-1">
          <For each={props.output.artifacts}>
            {(artifact) => (
              <li class="truncate font-mono text-[10px] text-v2-text-text-muted">
                {artifact.type === "file" ? (
                  <span>
                    file · {artifact.name ?? artifact.uri} · {artifact.mime}
                  </span>
                ) : (
                  <span>
                    {artifact.type} · {artifact.path}
                  </span>
                )}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/**
 * Automations is a canonical local-only surface, like Workbench: it always talks to the
 * local sidecar rather than to whichever server the rest of the app happens to have
 * selected. Resolving that connection here — instead of behind a ServerSDKProvider in the
 * router — keeps the route a plain page render and keeps every path this page produces
 * free of server scope.
 */
export default function LoopsPage() {
  const server = useServer()
  const connection = createMemo(() => localLoopServer(server.list, server.scope))

  return (
    <Show when={connection()} keyed fallback={<LoopsUnavailable />}>
      {(current) => <LoopsWorkspace connection={current} />}
    </Show>
  )
}

function LoopsUnavailable() {
  return (
    <section data-component="loops-page" class={SURFACE}>
      <PageHeader title="Automations" description="Visual workflows running on your local server" />
      <div class="flex min-h-0 flex-1 items-center justify-center px-5 py-10 text-center">
        <div class="max-w-sm">
          <p class="text-[13px] text-v2-text-text-base [font-weight:600]">Local server unavailable</p>
          <p class="mt-2 text-[13px] leading-5 text-v2-text-text-muted">
            Automations run on your local TurenOS server. Start it to create and manage automations.
          </p>
        </div>
      </div>
    </section>
  )
}

function LoopsWorkspace(props: { connection: ServerConnection.Any }) {
  const global = useGlobal()
  // `connection` is keyed by the caller, so the context and key resolve once per connection.
  const context = global.ensureServerCtx(props.connection)
  const serverKey = ServerConnection.key(props.connection)
  const navigate = useNavigate()
  const navRail = useNavRail()
  const dialog = useDialog()
  const params = useParams<{ id?: string }>()
  const [search] = useSearchParams<{ directory?: string; view?: string }>()
  const [loops, setLoops] = createSignal<LoopInfo[]>([])
  const [sort, setSort] = createSignal<AutomationSort>("created-desc")
  const [runHistory, setRunHistory] = createSignal<Record<string, LoopRun[]>>({})
  const [selected, setSelected] = createSignal<LoopInfo>()
  const [runs, setRuns] = createSignal<LoopRun[]>([])
  const [tab, setTab] = createSignal<"editor" | "runs">("editor")
  const [selectedNode, setSelectedNode] = createSignal<NodeSelection>("trigger")
  const [insertAt, setInsertAt] = createSignal<number>()
  const [name, setName] = createSignal("")
  const [steps, setSteps] = createSignal<StepDraft[]>([])
  const [interval, setInterval] = createSignal("1h")
  const [triggerKind, setTriggerKind] = createSignal<TriggerKind>("interval")
  const [cronExpression, setCronExpression] = createSignal("")
  const [timezone, setTimezone] = createSignal("UTC")
  const [eventPaths, setEventPaths] = createSignal("")
  const [debounceMs, setDebounceMs] = createSignal("")
  const [sessionOutcomes, setSessionOutcomes] = createSignal<SessionOutcomeFilter>("both")
  const [sessionID, setSessionID] = createSignal("")
  const [eventAgent, setEventAgent] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [agent, setAgent] = createSignal("")
  const [model, setModel] = createSignal("")
  const [variant, setVariant] = createSignal("")
  const [initialStatus, setInitialStatus] = createSignal<"active" | "paused">("active")
  const [catalog, setCatalog] = createSignal<Awaited<ReturnType<typeof loopCatalog>>>({
    agents: [],
    models: [],
    skills: [],
  })
  const [catalogLoading, setCatalogLoading] = createSignal(false)
  const [catalogError, setCatalogError] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  let loadVersion = 0
  let runtimeVersion = 0

  const api = () => loopApi(context.sdk.client)
  const providerCatalog = createMemo(() => {
    const target = directory()
    return target ? context.sync.child(target)[0].provider : context.sync.data.provider
  })
  const availableModels = createMemo<LoopModel[]>(() =>
    providerCatalog().connected.flatMap((providerID) => {
      if (isRemovedProvider(providerID)) return []
      const provider = providerCatalog().all.get(providerID)
      if (!provider) return []
      return Object.values(provider.models).map((item) => ({
        id: item.id,
        providerID: item.providerID,
        name: item.name,
        enabled: true,
        variants: Object.keys(item.variants ?? {}).map((id) => ({ id })),
      }))
    }),
  )
  const sortedLoops = createMemo(() => sortAutomations(loops(), sort()))
  const selectedStep = createMemo(() => steps().find((step) => step.key === selectedNode()))
  const directoryOptions = createMemo(() => {
    const values = new Set(context.projects.list().map((project) => project.worktree))
    if (directory()) values.add(directory())
    return [...values].toSorted().map((value) => ({ value, label: value }))
  })
  const statusOptions = [
    { value: "active" as const, label: "Active - run immediately" },
    { value: "paused" as const, label: "Paused - save without running" },
  ]
  const catalogAgents = createMemo(() =>
    catalog()
      .agents.filter((item) => item.mode !== "subagent" && !item.hidden)
      .map((item) => ({ value: item.id, label: item.description ? `${item.id} - ${item.description}` : item.id })),
  )
  const catalogModels = createMemo(() =>
    catalog()
      .models.filter((item) => item.enabled)
      .map((item) => ({ value: modelKey(item), label: `${item.name} - ${item.providerID}` })),
  )
  /** Keeps a saved selection choosable even when the current catalog no longer lists it. */
  const withSelected = (options: Array<{ value: string; label: string }>, selected: string) =>
    selected && !options.some((option) => option.value === selected)
      ? [...options, { value: selected, label: `${selected} (selected)` }]
      : options
  const agentOptions = createMemo(() =>
    withSelected([{ value: "", label: "Default agent" }, ...catalogAgents()], agent()),
  )
  const modelOptions = createMemo(() =>
    withSelected([{ value: "", label: "Default model" }, ...catalogModels()], model()),
  )
  const inheritOptions = (options: Array<{ value: string; label: string }>, selected: string) =>
    withSelected([{ value: "", label: "Inherit from automation" }, ...options], selected)
  /** Effort tiers the selected model advertises; only the default when it exposes one. */
  const variantOptions = (key: string, selected: string) =>
    withSelected(
      [
        { value: "", label: "Recommended effort" },
        ...(catalog().models.find((item) => modelKey(item) === key)?.variants ?? []).map((item) => ({
          value: item.id,
          label: modelEffortDisplay(item.id).label,
        })),
      ],
      selected,
    )
  /**
   * Every option list a select receives has to be one memoized array, because the select is
   * controlled: it matches `current` against `options` by identity. Building the list twice —
   * once to pass and once to `find` the current entry — hands it a value it cannot find, and
   * it corrects the selection on every pass, which loops forever.
   */
  const triggerVariantOptions = createMemo(() => variantOptions(model(), variant()))
  const stepAgentOptions = createMemo(() => inheritOptions(catalogAgents(), selectedStep()?.agent ?? ""))
  const stepModelOptions = createMemo(() => inheritOptions(catalogModels(), modelKey(selectedStep()?.model)))
  const stepVariantOptions = createMemo(() =>
    variantOptions(modelKey(selectedStep()?.model), selectedStep()?.model?.variant ?? ""),
  )
  const skillOptions = createMemo(() =>
    catalog().skills.map((item) => ({
      value: item.name,
      label: item.description ? `${item.name} - ${item.description}` : item.name,
    })),
  )

  const resetTrigger = (trigger: TriggerDraft) => {
    setTriggerKind(trigger.kind)
    setInterval(trigger.interval)
    setCronExpression(trigger.cronExpression)
    setTimezone(trigger.timezone)
    setEventPaths(trigger.eventPaths)
    setDebounceMs(trigger.debounceMs)
    setSessionOutcomes(trigger.sessionOutcomes)
    setSessionID(trigger.sessionID)
    setEventAgent(trigger.eventAgent)
  }

  const resetForm = () => {
    setSelected()
    setRuns([])
    setName("")
    setSteps([agentDraft([])])
    resetTrigger({
      kind: "interval",
      interval: "1h",
      cronExpression: "",
      timezone: "UTC",
      eventPaths: "",
      debounceMs: "",
      sessionOutcomes: "both",
      sessionID: "",
      eventAgent: "",
    })
    setDirectory(search.directory ?? "")
    setAgent("")
    setModel("")
    setVariant("")
    setInitialStatus("active")
    setTab("editor")
    setSelectedNode("trigger")
    setInsertAt()
  }

  const loadList = async (version?: number) => {
    const items = responseData(await api().list())
    if (version !== undefined && version !== loadVersion) return
    setLoops(items)
    void Promise.all(
      items.map((item) =>
        api()
          .runList({ loopID: item.id })
          .then(responseData)
          .then((history) => [item.id, history] as const)
          .catch(() => [item.id, []] as const),
      ),
    ).then((entries) => {
      if (version === undefined || version === loadVersion) {
        setRunHistory(Object.fromEntries(entries))
      }
    })
  }

  const loadSelected = async (id: string, version?: number) => {
    const item = responseData(await api().get({ loopID: id }))
    const nextRuns = responseData(await api().runList({ loopID: id }))
    if (version !== undefined && version !== loadVersion) return
    setSelected(item)
    setName(item.name)
    setSteps(
      item.workflow
        ? toDrafts(item.workflow.steps)
        : item.skill
          ? [{ ...skillDraft([], item.skill), skill: item.skill, instructions: item.prompt }]
          : [agentDraft([], "Agent task", item.prompt)],
    )
    resetTrigger(triggerFromAutomation(item))
    setDirectory(item.location.directory)
    setAgent(item.agent ?? "")
    setModel(modelKey(item.model))
    setVariant(item.model?.variant ?? "")
    setRuns(nextRuns)
    setSelectedNode("trigger")
    setInsertAt()
  }

  const loadRuntime = async (id: string) => {
    const version = ++runtimeVersion
    const [item, nextRuns] = await Promise.all([
      api().get({ loopID: id }).then(responseData),
      api().runList({ loopID: id }).then(responseData),
    ])
    if (params.id !== id || version !== runtimeVersion) return
    setSelected(item)
    setRuns(nextRuns)
    setRunHistory((current) => ({ ...current, [id]: nextRuns }))
  }

  createEffect(() => {
    const target = directory()
    const models = availableModels()
    setCatalogError(false)
    let active = true
    setCatalogLoading(true)
    setCatalog({ agents: [], models, skills: [] })
    void loopCatalog(context.sdk.client, target, models)
      .then((items) => {
        if (active) {
          setCatalog(items)
          setCatalogLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setCatalogError(true)
          setCatalogLoading(false)
        }
      })
    onCleanup(() => {
      active = false
    })
  })

  createEffect(() => {
    const id = params.id
    const version = ++loadVersion
    setLoading(true)
    setError()
    if (id && id !== "new") {
      setSelected()
      setRuns([])
      setTab(search.view === "runs" ? "runs" : "editor")
    }
    void Promise.all([loadList(version), id && id !== "new" ? loadSelected(id, version) : Promise.resolve(resetForm())])
      .catch((cause) => {
        if (version === loadVersion) setError(cause instanceof Error ? cause.message : "Could not load automations")
      })
      .finally(() => {
        if (version === loadVersion) setLoading(false)
      })
  })

  createEffect(() => {
    const id = selected()?.id
    if (!id) return
    const timer = window.setInterval(() => void loadRuntime(id).catch(() => undefined), 2_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const updateStep = (key: string, update: Partial<StepDraft>) => {
    setSteps((items) => items.map((item) => (item.key === key ? ({ ...item, ...update } as StepDraft) : item)))
  }

  const addStep = (type: StepType, index: number) => {
    if (steps().length >= MAX_STEPS) return
    const taken = steps().map((item) => item.id)
    const draft = type === "agent" ? agentDraft(taken) : skillDraft(taken)
    setSteps((items) => items.toSpliced(index, 0, draft))
    setSelectedNode(draft.key)
    setInsertAt()
  }

  const moveStep = (key: string, offset: -1 | 1) => {
    const from = steps().findIndex((item) => item.key === key)
    const to = from + offset
    if (from < 0 || to < 0 || to >= steps().length) return
    const next = steps().toSpliced(from, 1).toSpliced(to, 0, steps()[from])
    const invalid = invalidStepBinding(next)
    if (invalid) {
      setError(`Move blocked because ${invalid.name || "a later step"} depends on a step above it.`)
      return
    }
    setError()
    setSteps(next)
  }

  const removeStep = (key: string) => {
    const next = steps().filter((item) => item.key !== key)
    const invalid = invalidStepBinding(next)
    if (invalid) {
      setError(`Remove blocked because ${invalid.name || "a later step"} still references this step.`)
      return
    }
    setError()
    setSteps(next)
    if (selectedNode() === key) setSelectedNode("trigger")
  }

  const insertBinding = (step: StepDraft, binding: string) => {
    if (step.type === "agent") {
      updateStep(step.key, { prompt: `${step.prompt}${step.prompt ? "\n\n" : ""}${binding}` })
      return
    }
    updateStep(step.key, { instructions: `${step.instructions}${step.instructions ? "\n\n" : ""}${binding}` })
  }

  /** Raw builder trigger state, validated and mapped to protocol fields on save. */
  const triggerDraft = (): TriggerDraft => ({
    kind: triggerKind(),
    interval: interval(),
    cronExpression: cronExpression(),
    timezone: timezone(),
    eventPaths: eventPaths(),
    debounceMs: debounceMs(),
    sessionOutcomes: sessionOutcomes(),
    sessionID: sessionID(),
    eventAgent: eventAgent(),
  })

  /** One-line canvas summary of the configured trigger. */
  const triggerLabel = () => triggerSummary(triggerDraft())

  /** Latest-run state for a canvas step node, inferred from outputs + currentStep. */
  const stepChip = (stepID: string, index: number) => {
    const run = runs()[0]
    if (!run) return
    return stepChipFor(run, stepID, index)
  }

  /** Top-level keys of the referenced step's most recent JSON output, for property-binding chips. */
  const outputKeys = (sourceID: string) => {
    const json = runs().find((run) => run.outputs[sourceID]?.json !== undefined)?.outputs[sourceID]?.json
    return json && typeof json === "object" && !Array.isArray(json)
      ? Object.keys(json)
          .filter((key) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(key))
          .slice(0, 6)
      : []
  }

  const applyBlueprint = (blueprint: "blank" | "briefing" | "ci" | "docs") => {
    const drafts = (items: Array<[string, string]>) =>
      items.reduce<StepDraft[]>(
        (acc, [title, prompt]) => [
          ...acc,
          agentDraft(
            acc.map((item) => item.id),
            title,
            prompt,
          ),
        ],
        [],
      )
    setSelectedNode("trigger")
    setTriggerKind("interval")
    if (blueprint === "blank") {
      setName("")
      setInterval("1h")
      setSteps([agentDraft([])])
      return
    }
    if (blueprint === "briefing") {
      setName("Daily briefing")
      setInterval("1d")
      setSteps(
        drafts([
          ["Gather updates", "Review this project's recent changes, open work, and notable risks."],
          ["Write briefing", "Turn the findings into a concise daily briefing with priorities and next actions."],
        ]),
      )
      return
    }
    if (blueprint === "ci") {
      setName("CI failure triage")
      setInterval("15m")
      setSteps(
        drafts([
          ["Inspect CI", "Find the latest failing CI runs and identify the first actionable failure."],
          ["Recommend a fix", "Explain the likely root cause and propose the smallest safe fix."],
        ]),
      )
      return
    }
    setName("Docs drift")
    setInterval("1d")
    setSteps(
      drafts([
        [
          "Compare docs and code",
          "Review recent implementation changes for documentation that is now missing or inaccurate.",
        ],
        ["Prepare updates", "Draft focused documentation updates for confirmed drift."],
      ]),
    )
  }

  const save = async () => {
    if (loading() || (params.id !== undefined && params.id !== "new" && !selected())) return
    const trigger = buildTriggerInput(triggerDraft())
    if (!name().trim() || trigger.error) {
      setError(trigger.error ?? "Enter a name and an interval of at least 60 seconds.")
      return
    }
    const triggerInput = trigger.input
    if (!steps().length) {
      setError("Add at least one Agent or Skill step.")
      return
    }
    const invalid = steps().some(
      (step) => !step.name.trim() || (step.type === "agent" ? !step.prompt.trim() : !step.skill),
    )
    if (invalid) {
      setError("Give every step a name and complete its required prompt or skill.")
      return
    }
    const invalidBinding = invalidStepBinding(steps())
    if (invalidBinding) {
      setError(`${invalidBinding.name || "A step"} references an unavailable or later step.`)
      return
    }
    setBusy(true)
    setError()
    const current = selected()
    const workflow: Workflow = { version: 1, steps: toWorkflowSteps(steps()), delivery: { type: "turen" } }
    const legacyPrompt = steps()
      .map((step) => (step.type === "agent" ? step.prompt : step.instructions))
      .filter(Boolean)
      .join("\n\n")
    const editInput = {
      loopID: current?.id ?? "",
      name: name().trim(),
      prompt: legacyPrompt,
      ...triggerInput,
      agent: agent() || null,
      model: modelRef(model(), variant()),
      skill: null,
      workflow,
    }
    const createInput = {
      name: name().trim(),
      prompt: legacyPrompt,
      ...triggerInput,
      ...(directory() ? { location: { directory: directory() } } : {}),
      ...(agent() ? { agent: agent() } : {}),
      ...(modelRef(model(), variant()) ? { model: modelRef(model(), variant()) ?? undefined } : {}),
      paused: initialStatus() === "paused",
      workflow,
    }
    await (current ? api().edit(editInput) : api().create(createInput))
      .then((result) => navigate(automationPath(responseData(result).id)))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not save automation"))
      .finally(() => setBusy(false))
  }

  const refresh = async () => {
    const item = selected()
    if (item) await Promise.all([loadList(), loadRuntime(item.id)])
  }

  const selectedAction = (action: (input: { loopID: string }) => Promise<unknown>) => {
    const item = selected()
    if (!item || busy()) return
    setBusy(true)
    setError()
    void action({ loopID: item.id })
      .then(refresh)
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Automation action failed"))
      .finally(() => setBusy(false))
  }

  /** Read-only run conversation in place; the full session stays one click away. */
  const viewChat = (automation: LoopInfo, run: LoopRun) => {
    const sessionID = run.sessionID
    if (!sessionID) return
    dialog.show(() => (
      <RunChatDialog
        sessionID={sessionID}
        title={`${automation.name} · run chat`}
        subtitle={`${runStatusLabel(run.status)} · ${run.trigger} · ${new Date(Number(run.scheduledAt)).toLocaleString()}`}
        client={context.sdk.client}
        onOpenInChat={() => navigate(sessionHref(serverKey, sessionID))}
      />
    ))
  }

  const nodeClass = (active: boolean) => `automation-node${active ? " automation-node-selected" : ""}`

  const connector = (index: number) => (
    <div class="automation-connector">
      <div class="automation-connector-line" />
      <Show
        when={insertAt() === index}
        fallback={
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            aria-label="Add step"
            disabled={busy() || steps().length >= MAX_STEPS}
            icon={<IconV2 name="plus" size="small" />}
            onClick={() => setInsertAt(index)}
          />
        }
      >
        <div class="automation-insert-menu">
          <ButtonV2 size="small" variant="neutral" onClick={() => addStep("agent", index)}>
            Agent step
          </ButtonV2>
          <ButtonV2 size="small" variant="neutral" onClick={() => addStep("skill", index)}>
            Skill step
          </ButtonV2>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            aria-label="Cancel add step"
            icon={<IconV2 name="close" size="small" />}
            onClick={() => setInsertAt()}
          />
        </div>
      </Show>
    </div>
  )

  return (
    <section data-component="loops-page" class={SURFACE}>
      <Show when={params.id !== "new"}>
        <PageHeader
          title="Automations"
          description="Visual workflows running on your local server"
          actions={
            <ButtonV2
              class="shrink-0 whitespace-nowrap"
              data-action="automation-new"
              size="small"
              variant="neutral"
              icon="plus"
              onClick={() => navigate("/automations/new")}
            >
              New automation
            </ButtonV2>
          }
        />
      </Show>

      <div
        class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:overflow-hidden"
        classList={{ "md:grid-cols-[280px_minmax(0,1fr)]": !navRail.collapsed("automations") && !params.id }}
      >
        <Show when={!navRail.collapsed("automations") && !params.id}>
          <aside
            data-component="automations-left-nav"
            class="flex flex-col border-b border-v2-border-border-subtle bg-v2-background-bg-layer-01 md:min-h-0 md:border-b-0 md:border-r"
          >
            <div class="flex items-center justify-between px-4 pb-2 pt-4">
              <span class="text-[11px] uppercase tracking-[0.12em] text-v2-text-text-muted">All Automations</span>
              <span class="text-[11px] tabular-nums text-v2-text-text-muted">{loops().length}</span>
            </div>
            <div class="flex items-center justify-between gap-2 px-3 pb-2">
              <span class="text-[11px] text-v2-text-text-muted">Sort</span>
              <SelectV2
                data-action="automation-sort"
                aria-label="Sort automations"
                appearance="inline"
                options={automationSortOptions}
                current={automationSortOptions.find((option) => option.value === sort())}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && setSort(option.value)}
              />
            </div>
            <div data-component="loops-list" class="min-h-0 max-h-56 flex-1 overflow-y-auto p-2 pt-0 md:max-h-none">
              <Show
                when={!loading()}
                fallback={
                  <p class="px-3 py-6 text-center text-[12px] text-v2-text-text-muted">Loading automations...</p>
                }
              >
                <For
                  each={sortedLoops()}
                  fallback={
                    <div class="m-2 rounded-[9px] border border-dashed border-v2-border-border-base px-4 py-8 text-center text-[12px] text-v2-text-text-muted">
                      No automations yet. Pick a blueprint to start.
                    </div>
                  }
                >
                  {(item) => (
                    <button
                      data-action={`automation-open-${item.id}`}
                      class="mb-1 flex w-full items-start gap-3 rounded-[8px] px-3 py-3 text-left outline-none transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
                      classList={{ "bg-v2-background-bg-layer-03": params.id === item.id }}
                      onClick={() => navigate(automationPath(item.id))}
                    >
                      <span
                        class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${item.status === "active" ? "bg-v2-state-fg-success" : "bg-v2-text-text-muted"}`}
                      />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[13px] text-v2-text-text-base [font-weight:550]">
                          {item.name}
                        </span>
                        <span class="mt-0.5 block truncate text-[11px] text-v2-text-text-muted">
                          Every {formatInterval(item.schedule.seconds)} · {item.workflow?.steps.length ?? 1} step
                          {(item.workflow?.steps.length ?? 1) === 1 ? "" : "s"}
                        </span>
                        <Show
                          when={runHistory()[item.id]?.length}
                          fallback={
                            <span class="mt-1 block font-mono text-[10px] text-v2-text-text-faint">never run</span>
                          }
                        >
                          <div class="mt-2 flex h-4 items-end gap-1">
                            <For each={runHistory()[item.id].slice(0, 8).toReversed()}>
                              {(run) => (
                                <span
                                  class={`min-w-0 flex-1 ${run.status === "succeeded" ? "h-3 bg-v2-state-fg-success" : run.status === "failed" ? "h-2 bg-v2-state-fg-danger" : "h-2 bg-v2-state-fg-warning"}`}
                                />
                              )}
                            </For>
                          </div>
                          <Show when={runHistory()[item.id]?.[0]}>
                            {(run) => (
                              <span
                                class={`mt-1 block truncate font-mono text-[10px] ${latestRunTone(run().status)}`}
                              >
                                {runStatusLabel(run().status).toLowerCase()} ·{" "}
                                {new Date(run().scheduledAt).toLocaleDateString()}
                                <Show when={isActiveRun(run())}>
                                  {` · step ${currentStepIndex(run()) + 1} of ${item.workflow?.steps.length ?? Math.max(Object.keys(run().outputs).length, 1)}`}
                                </Show>
                              </span>
                            )}
                          </Show>
                          <Show when={nextRunLabel(item)}>
                            {(label) => (
                              <span class="mt-1 block truncate font-mono text-[10px] text-v2-text-text-faint">
                                {label()}
                              </span>
                            )}
                          </Show>
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </aside>
        </Show>

        <main class="automation-workspace flex min-h-0 min-w-0 flex-col overflow-y-auto bg-v2-background-bg-layer-01 lg:overflow-hidden">
          <div class="flex min-h-0 flex-1 flex-col gap-5 p-4 sm:p-5">
            <header class="flex flex-col items-stretch gap-4 rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div class="min-w-0 max-w-2xl">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-v2-state-bg-info text-v2-state-fg-info">
                    <IconV2 name="branch" size="small" />
                  </span>
                  <h2 class="truncate text-[16px] leading-tight text-v2-text-text-base [font-weight:620]">
                    {selected() ? selected()!.name : name().trim() || "New automation"}
                  </h2>
                  <Show when={selected()}>
                    {(item) => (
                      <span
                        class={`shrink-0 rounded-full px-2.5 py-1 text-[11px] [font-weight:550] ${STATUS_TONE[item().status]}`}
                      >
                        {item().status}
                      </span>
                    )}
                  </Show>
                </div>
                <p class="mt-1 pl-9 text-[11px] leading-4 text-v2-text-text-muted">
                  <Show when={selected()} fallback="Build a scheduled workflow that runs on your local server.">
                    {(item) => {
                      const next = nextRunLabel(item())
                      return `${item().workflow?.steps.length ?? 1} steps · Every ${formatInterval(item().schedule.seconds)} · Local server${next ? ` · ${next}` : ""}`
                    }}
                  </Show>
                </p>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                <ButtonV2
                  data-action="automation-save"
                  variant="contrast"
                  disabled={busy() || loading() || (params.id !== undefined && params.id !== "new" && !selected())}
                  onClick={() => void save()}
                >
                  {selected() ? "Save changes" : "Create automation"}
                </ButtonV2>
                <Show when={selected()}>
                  {(item) => (
                    <>
                      <ButtonV2
                        variant="neutral"
                        disabled={busy()}
                        onClick={() => selectedAction((value) => api().runNow(value))}
                      >
                        Run now
                      </ButtonV2>
                      <Show when={item().status === "active"}>
                        <ButtonV2
                          variant="neutral"
                          disabled={busy()}
                          onClick={() => selectedAction((value) => api().pause(value))}
                        >
                          Pause
                        </ButtonV2>
                      </Show>
                      <Show when={item().status === "paused"}>
                        <ButtonV2
                          variant="neutral"
                          disabled={busy()}
                          onClick={() => selectedAction((value) => api().resume(value))}
                        >
                          Resume
                        </ButtonV2>
                      </Show>
                      <ButtonV2
                        variant="danger"
                        disabled={busy()}
                        onClick={() => {
                          if (busy() || !window.confirm(`Delete "${item().name}" and all of its run history?`)) return
                          setBusy(true)
                          void api()
                            .delete({ loopID: item().id })
                            .then(() => {
                              navigate("/automations")
                              void loadList()
                            })
                            .catch((cause) =>
                              setError(cause instanceof Error ? cause.message : "Could not delete automation"),
                            )
                            .finally(() => setBusy(false))
                        }}
                      >
                        Delete
                      </ButtonV2>
                    </>
                  )}
                </Show>
              </div>
            </header>

            <Show when={selected()}>
              <div class="flex justify-center">
                <SegmentedControlV2
                  aria-label="Automation view"
                  value={tab()}
                  onChange={(value) => setTab(value === "runs" ? "runs" : "editor")}
                >
                  <SegmentedControlItemV2 value="editor" data-action="automation-tab-editor">
                    Workflow
                  </SegmentedControlItemV2>
                  <SegmentedControlItemV2 value="runs" data-action="automation-tab-runs">
                    Runs ({runs().length})
                  </SegmentedControlItemV2>
                </SegmentedControlV2>
              </div>
            </Show>

            <Show when={error()}>
              {(message) => (
                <div
                  role="alert"
                  class="rounded-[9px] border border-v2-state-border-danger bg-v2-state-bg-danger px-4 py-3 text-[12px] text-v2-state-fg-danger"
                >
                  {message()}
                </div>
              )}
            </Show>

            <Show when={tab() === "editor" || !selected()}>
              <Show when={!selected()}>
                <section aria-label="Starter blueprints">
                  <div class="flex flex-wrap items-center gap-2 border-b border-v2-border-border-base pb-3">
                    <span class="mr-2 font-mono text-[11px] uppercase tracking-[0.14em] text-v2-text-text-muted">
                      Start from
                    </span>
                    <For
                      each={[
                        { id: "blank" as const, name: "Blank" },
                        { id: "briefing" as const, name: "Daily briefing" },
                        { id: "ci" as const, name: "CI failure triage" },
                        { id: "docs" as const, name: "Docs drift" },
                      ]}
                    >
                      {(blueprint) => (
                        <button
                          type="button"
                          class="rounded-control px-3 py-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                          onClick={() => applyBlueprint(blueprint.id)}
                        >
                          {blueprint.name}
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              <section
                data-component="loop-editor"
                class="grid min-h-0 min-w-0 flex-1 items-stretch overflow-hidden rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-base min-[1100px]:grid-cols-[minmax(0,1fr)_340px]"
              >
                <div
                  data-component="loop-canvas"
                  class="automation-canvas relative min-h-[470px] min-w-0 overflow-auto border-b border-v2-border-border-base lg:border-b-0"
                >
                  <div class="pointer-events-none sticky left-0 top-0 z-10 flex h-10 items-center justify-between border-b border-v2-border-border-subtle bg-v2-background-bg-base/90 px-3 backdrop-blur-sm">
                    <span class="text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">Workflow map</span>
                    <span class="rounded-full bg-v2-background-bg-layer-02 px-2 py-1 text-[10px] text-v2-text-text-muted">
                      {steps().length + 2} nodes
                    </span>
                  </div>
                  <div class="automation-flow">
                    <div
                      role="button"
                      tabIndex={0}
                      data-node="trigger"
                      class={`${nodeClass(selectedNode() === "trigger")} automation-node-trigger`}
                      onClick={() => setSelectedNode("trigger")}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        setSelectedNode("trigger")
                      }}
                    >
                      <div class="flex min-h-[74px] items-center">
                        <span class="automation-node-icon">
                          <IconV2 name="status" size="large" />
                        </span>
                        <div class="min-w-0 px-4 py-3">
                          <p class="automation-node-kicker text-[10px] [font-weight:650]">Trigger</p>
                          <p class="mt-1 truncate text-[13px] text-v2-text-text-base [font-weight:600]">
                            {triggerLabel()}
                          </p>
                          <p class="mt-0.5 truncate text-[10px] text-v2-text-text-muted">
                            {directory() || "Default local workspace"}
                          </p>
                        </div>
                      </div>
                    </div>

                    <For each={steps()}>
                      {(step, index) => (
                        <>
                          {connector(index())}
                          <div
                            role="button"
                            tabIndex={0}
                            data-node={step.id}
                            class={`${nodeClass(selectedNode() === step.key)} automation-node-${step.type}`}
                            onClick={() => setSelectedNode(step.key)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return
                              event.preventDefault()
                              setSelectedNode(step.key)
                            }}
                          >
                            <div class="flex min-h-[74px] min-w-0 items-center">
                              <span class="automation-node-icon">
                                <IconV2 name={step.type === "agent" ? "terminal" : "skills"} size="large" />
                              </span>
                              <div class="min-w-0 flex-1 px-4 py-3">
                                <div class="flex items-center gap-2">
                                  <p class="automation-node-kicker truncate text-[10px] [font-weight:650]">
                                    {step.type === "agent" ? "Agent" : "Skill"} · Step {index() + 1}
                                  </p>
                                </div>
                                <p class="mt-1 truncate text-[13px] text-v2-text-text-base [font-weight:600]">
                                  {step.name || "Untitled step"}
                                </p>
                                <p class="mt-0.5 truncate text-[10px] text-v2-text-text-muted">{stepSummary(step)}</p>
                              </div>
                              <Show when={stepChip(step.id, index())}>
                                {(chip) => (
                                  <span
                                    class={`shrink-0 rounded-full px-2 py-1 text-[10px] [font-weight:550] ${chip().tone}`}
                                  >
                                    {chip().label}
                                  </span>
                                )}
                              </Show>
                              <span class="mr-4 rounded-full bg-v2-background-bg-layer-03 px-2 py-1 text-[10px] tabular-nums text-v2-text-text-muted">
                                {index() + 1}
                              </span>
                            </div>
                          </div>
                        </>
                      )}
                    </For>

                    {connector(steps().length)}
                    <div
                      role="button"
                      tabIndex={0}
                      data-node="delivery"
                      class={`${nodeClass(selectedNode() === "delivery")} automation-node-delivery`}
                      onClick={() => setSelectedNode("delivery")}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        setSelectedNode("delivery")
                      }}
                    >
                      <div class="flex min-h-[74px] items-center">
                        <span class="automation-node-icon">
                          <IconV2 name="check" size="large" />
                        </span>
                        <div class="min-w-0 px-4 py-3">
                          <p class="automation-node-kicker text-[10px] [font-weight:650]">Delivery</p>
                          <p class="mt-1 text-[13px] text-v2-text-text-base [font-weight:600]">
                            Send results to TurenOS
                          </p>
                          <p class="mt-0.5 text-[10px] text-v2-text-text-muted">
                            Outputs and artifacts are saved with the run
                          </p>
                        </div>
                      </div>
                    </div>
                    <div class="flex gap-2 pt-3">
                      <ButtonV2
                        size="small"
                        variant="neutral"
                        disabled={busy() || steps().length >= MAX_STEPS}
                        onClick={() => addStep("agent", steps().length)}
                      >
                        + agent
                      </ButtonV2>
                      <ButtonV2
                        size="small"
                        variant="neutral"
                        disabled={busy() || steps().length >= MAX_STEPS}
                        onClick={() => addStep("skill", steps().length)}
                      >
                        + skill
                      </ButtonV2>
                    </div>
                  </div>
                </div>

                <aside
                  data-component="loop-inspector"
                  class="min-w-0 max-h-[660px] overflow-y-auto border-t border-v2-border-border-base bg-v2-background-bg-layer-01 p-4 [&_[data-component=select-v2-root]]:w-full min-[1100px]:border-l min-[1100px]:border-t-0"
                >
                  <Show when={selectedNode() === "trigger"}>
                    <h3 class="mb-4 text-[13px] text-v2-text-text-base [font-weight:600]">Trigger</h3>
                    <div class="grid min-w-0 gap-4">
                      <FieldV2 class="min-w-0" invalid={!!error() && !name().trim()}>
                        <FieldV2.Label>Name</FieldV2.Label>
                        <TextInputV2
                          class="!w-full !min-w-0"
                          value={name()}
                          placeholder="Daily CI sweep"
                          disabled={busy()}
                          onInput={(event) => setName(event.currentTarget.value)}
                        />
                      </FieldV2>
                      <FieldV2 class="min-w-0">
                        <FieldV2.Label>Project</FieldV2.Label>
                        <SelectV2
                          aria-label="Project"
                          class="!w-full !min-w-0"
                          options={directoryOptions()}
                          current={directoryOptions().find((option) => option.value === directory())}
                          value={(option) => option.value}
                          label={(option) => option.label}
                          onSelect={(option) => option && setDirectory(option.value)}
                          disabled={!!selected() || busy()}
                        />
                      </FieldV2>
                      <FieldV2 class="min-w-0">
                        <FieldV2.Label>Trigger type</FieldV2.Label>
                        <SelectV2
                          aria-label="Trigger type"
                          class="!w-full !min-w-0"
                          options={TRIGGER_KIND_OPTIONS}
                          current={TRIGGER_KIND_OPTIONS.find((option) => option.value === triggerKind())}
                          value={(option) => option.value}
                          label={(option) => option.label}
                          onSelect={(option) => option && setTriggerKind(option.value)}
                          disabled={busy()}
                        />
                        <FieldV2.Suffix>Intervals and cron run on a schedule; events fire on local activity.</FieldV2.Suffix>
                      </FieldV2>
                      <Show when={triggerKind() === "interval"}>
                        <FieldV2
                          class="min-w-0"
                          invalid={!!interval() && (!parseInterval(interval()) || parseInterval(interval())! < 60)}
                        >
                          <FieldV2.Label>Interval</FieldV2.Label>
                          <TextInputV2
                            class="!w-full !min-w-0"
                            numeric
                            value={interval()}
                            placeholder="1h"
                            disabled={busy()}
                            onInput={(event) => setInterval(event.currentTarget.value)}
                          />
                          <FieldV2.Suffix>Minimum 60s. Use s, m, h, or d.</FieldV2.Suffix>
                        </FieldV2>
                      </Show>
                      <Show when={triggerKind() === "cron"}>
                        <FieldV2
                          class="min-w-0"
                          invalid={!!cronExpression() && !!validateCronExpression(cronExpression())}
                        >
                          <FieldV2.Label>Cron expression</FieldV2.Label>
                          <TextInputV2
                            class="!w-full !min-w-0"
                            value={cronExpression()}
                            placeholder="*/5 * * * *"
                            disabled={busy()}
                            onInput={(event) => setCronExpression(event.currentTarget.value)}
                          />
                          <FieldV2.Suffix>Five fields: minute hour day month weekday. Max 120 characters.</FieldV2.Suffix>
                        </FieldV2>
                      </Show>
                      <Show when={triggerKind() === "file-change"}>
                        <FieldV2
                          class="min-w-0"
                          invalid={parseEventPaths(eventPaths()).some((pattern) => validateGlobPattern(pattern))}
                        >
                          <FieldV2.Label>Path patterns</FieldV2.Label>
                          <TextareaV2
                            class="min-h-24 !w-full !min-w-0"
                            rows={3}
                            value={eventPaths()}
                            placeholder={"src/**/*.ts\ntests/**/*.ts"}
                            disabled={busy()}
                            onInput={(event) => setEventPaths(event.currentTarget.value)}
                          />
                          <FieldV2.Suffix>One relative glob per line, scoped to the project directory.</FieldV2.Suffix>
                        </FieldV2>
                        <FieldV2
                          class="min-w-0"
                          invalid={!!debounceMs().trim() && !!validateDebounceMs(debounceMs())}
                        >
                          <FieldV2.Label>Debounce (ms)</FieldV2.Label>
                          <TextInputV2
                            class="!w-full !min-w-0"
                            numeric
                            value={debounceMs()}
                            placeholder="1000"
                            disabled={busy()}
                            onInput={(event) => setDebounceMs(event.currentTarget.value)}
                          />
                          <FieldV2.Suffix>Optional. Batches rapid changes between 0 and 60000 ms.</FieldV2.Suffix>
                        </FieldV2>
                      </Show>
                      <Show when={triggerKind() === "session-end"}>
                        <FieldV2 class="min-w-0">
                          <FieldV2.Label>Outcomes</FieldV2.Label>
                          <SelectV2
                            aria-label="Session outcomes"
                            class="!w-full !min-w-0"
                            options={SESSION_OUTCOME_OPTIONS}
                            current={SESSION_OUTCOME_OPTIONS.find((option) => option.value === sessionOutcomes())}
                            value={(option) => option.value}
                            label={(option) => option.label}
                            onSelect={(option) => option && setSessionOutcomes(option.value)}
                            disabled={busy()}
                          />
                          <FieldV2.Suffix>Only fire for sessions ending with these outcomes.</FieldV2.Suffix>
                        </FieldV2>
                        <FieldV2 class="min-w-0">
                          <FieldV2.Label>Session ID</FieldV2.Label>
                          <TextInputV2
                            class="!w-full !min-w-0"
                            value={sessionID()}
                            placeholder="Any session"
                            disabled={busy()}
                            onInput={(event) => setSessionID(event.currentTarget.value)}
                          />
                          <FieldV2.Suffix>Optional. Only fire for one session.</FieldV2.Suffix>
                        </FieldV2>
                        <FieldV2 class="min-w-0">
                          <FieldV2.Label>Agent</FieldV2.Label>
                          <TextInputV2
                            class="!w-full !min-w-0"
                            value={eventAgent()}
                            placeholder="Any agent"
                            disabled={busy()}
                            onInput={(event) => setEventAgent(event.currentTarget.value)}
                          />
                          <FieldV2.Suffix>Optional. Only fire for sessions run by this agent.</FieldV2.Suffix>
                        </FieldV2>
                      </Show>
                      <FieldV2 class="min-w-0" invalid={!!validateTimezone(timezone())}>
                        <FieldV2.Label>Timezone</FieldV2.Label>
                        <TextInputV2
                          class="!w-full !min-w-0"
                          value={timezone()}
                          placeholder="UTC"
                          disabled={busy()}
                          onInput={(event) => setTimezone(event.currentTarget.value)}
                        />
                        <FieldV2.Suffix>IANA timezone for schedule fire times, e.g. America/New_York.</FieldV2.Suffix>
                      </FieldV2>
                      <FieldV2 class="min-w-0">
                        <FieldV2.Label>Agent</FieldV2.Label>
                        <SelectV2
                          aria-label="Agent"
                          class="!w-full !min-w-0"
                          options={agentOptions()}
                          current={agentOptions().find((option) => option.value === agent())}
                          value={(option) => option.value}
                          label={(option) => option.label}
                          onSelect={(option) => option && setAgent(option.value)}
                          disabled={busy()}
                        />
                        <FieldV2.Suffix>Runs every step in this automation.</FieldV2.Suffix>
                      </FieldV2>
                      <FieldV2 class="min-w-0">
                        <FieldV2.Label>Model</FieldV2.Label>
                        <SelectV2
                          aria-label="Model"
                          class="!w-full !min-w-0"
                          options={modelOptions()}
                          current={modelOptions().find((option) => option.value === model())}
                          value={(option) => option.value}
                          label={(option) => option.label}
                          onSelect={(option) => option && setModel(option.value)}
                          disabled={busy()}
                        />
                        <FieldV2.Suffix>
                          {catalogLoading()
                            ? "Loading available models..."
                            : catalogError()
                              ? "Could not load models. The selected model is still available."
                              : catalog().models.filter((item) => item.enabled).length === 0
                                ? "No models available."
                                : "Select the model used by this automation."}
                        </FieldV2.Suffix>
                      </FieldV2>
                      <Show when={triggerVariantOptions().length > 1}>
                        <FieldV2 class="min-w-0">
                          <FieldV2.Label>Effort</FieldV2.Label>
                          <SelectV2
                            aria-label="Effort"
                            class="!w-full !min-w-0"
                            options={triggerVariantOptions()}
                            current={triggerVariantOptions().find((option) => option.value === variant())}
                            value={(option) => option.value}
                            label={(option) => option.label}
                            onSelect={(option) => option && setVariant(option.value)}
                            disabled={busy()}
                          />
                          <FieldV2.Suffix>Reasoning effort used by this model.</FieldV2.Suffix>
                        </FieldV2>
                      </Show>
                      <Show when={!selected()}>
                        <FieldV2 class="min-w-0">
                          <FieldV2.Label>Initial state</FieldV2.Label>
                          <SelectV2
                            aria-label="Initial state"
                            class="!w-full !min-w-0"
                            options={statusOptions}
                            current={statusOptions.find((option) => option.value === initialStatus())}
                            value={(option) => option.value}
                            label={(option) => option.label}
                            onSelect={(option) => option && setInitialStatus(option.value)}
                            disabled={busy()}
                          />
                        </FieldV2>
                      </Show>
                    </div>
                  </Show>

                  <Show when={selectedStep()}>
                    {(step) => (
                      <>
                        <div class="mb-4 flex items-center justify-between gap-2">
                          <div class="min-w-0">
                            <h3 class="text-[13px] text-v2-text-text-base [font-weight:600]">
                              {step().type === "agent" ? "Agent step" : "Skill step"}
                            </h3>
                            <code class="mt-1 block truncate text-[10px] text-v2-text-text-muted">
                              steps.{step().id}
                            </code>
                          </div>
                          <div class="flex shrink-0 gap-1">
                            <ButtonV2
                              size="small"
                              variant="neutral"
                              disabled={busy() || steps().findIndex((item) => item.key === step().key) === 0}
                              onClick={() => moveStep(step().key, -1)}
                            >
                              Up
                            </ButtonV2>
                            <ButtonV2
                              size="small"
                              variant="neutral"
                              disabled={
                                busy() || steps().findIndex((item) => item.key === step().key) === steps().length - 1
                              }
                              onClick={() => moveStep(step().key, 1)}
                            >
                              Down
                            </ButtonV2>
                            <ButtonV2
                              size="small"
                              variant="danger"
                              disabled={busy()}
                              onClick={() => removeStep(step().key)}
                            >
                              Remove
                            </ButtonV2>
                          </div>
                        </div>
                        <div class="grid min-w-0 gap-4">
                          <FieldV2 class="min-w-0" invalid={!!error() && !step().name.trim()}>
                            <FieldV2.Label>Step name</FieldV2.Label>
                            <TextInputV2
                              class="!w-full !min-w-0"
                              value={step().name}
                              placeholder={step().type === "agent" ? "Analyze changes" : "Run skill"}
                              disabled={busy()}
                              onInput={(event) =>
                                setSteps((items) => renameStep(items, step().key, event.currentTarget.value))
                              }
                            />
                            <FieldV2.Suffix>Later steps reference this as steps.{step().id}.output</FieldV2.Suffix>
                          </FieldV2>
                          <Show
                            when={step().type === "agent"}
                            fallback={
                              <>
                                <FieldV2 class="min-w-0">
                                  <FieldV2.Label>Skill</FieldV2.Label>
                                  <SelectV2
                                    aria-label="Skill"
                                    class="!w-full !min-w-0"
                                    options={skillOptions()}
                                    current={skillOptions().find(
                                      (option) =>
                                        option.value ===
                                        (step().type === "skill"
                                          ? (step() as StepDraft & { skill: string }).skill
                                          : ""),
                                    )}
                                    value={(option) => option.value}
                                    label={(option) => option.label}
                                    onSelect={(option) => option && updateStep(step().key, { skill: option.value })}
                                    disabled={!directory() || busy()}
                                    placeholder={directory() ? "Select a skill" : "Select a project first"}
                                  />
                                </FieldV2>
                                <FieldV2 class="min-w-0">
                                  <FieldV2.Label>Instructions</FieldV2.Label>
                                  <TextareaV2
                                    class="min-h-24 !w-full !min-w-0"
                                    rows={4}
                                    value={
                                      step().type === "skill"
                                        ? (step() as StepDraft & { instructions: string }).instructions
                                        : ""
                                    }
                                    placeholder="Optional context for this skill."
                                    disabled={busy()}
                                    onInput={(event) =>
                                      updateStep(step().key, { instructions: event.currentTarget.value })
                                    }
                                  />
                                </FieldV2>
                              </>
                            }
                          >
                            <FieldV2 class="min-w-0">
                              <FieldV2.Label>Prompt</FieldV2.Label>
                              <TextareaV2
                                class="min-h-32 !w-full !min-w-0"
                                rows={6}
                                value={
                                  step().type === "agent" ? (step() as StepDraft & { prompt: string }).prompt : ""
                                }
                                placeholder="What should the agent accomplish in this step?"
                                disabled={busy()}
                                onInput={(event) => updateStep(step().key, { prompt: event.currentTarget.value })}
                              />
                            </FieldV2>
                          </Show>
                          <div class="grid min-w-0 gap-4 border-t border-v2-border-border-subtle pt-4">
                            {/* Each select ignores a selection equal to what the step already has.
                            These lists are rebuilt whenever the step changes, and the select is
                            controlled, so it re-emits its current value on every rebuild; writing
                            that value back would rebuild the list again, without end. */}
                            <p class="text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">Execution</p>
                            <FieldV2 class="min-w-0">
                              <FieldV2.Label>Agent</FieldV2.Label>
                              <SelectV2
                                aria-label="Step agent"
                                class="!w-full !min-w-0"
                                options={stepAgentOptions()}
                                current={stepAgentOptions().find((option) => option.value === (step().agent ?? ""))}
                                value={(option) => option.value}
                                label={(option) => option.label}
                                onSelect={(option) =>
                                  option &&
                                  option.value !== (step().agent ?? "") &&
                                  updateStep(step().key, { agent: option.value || undefined })
                                }
                                disabled={busy()}
                              />
                            </FieldV2>
                            <FieldV2 class="min-w-0">
                              <FieldV2.Label>Model</FieldV2.Label>
                              <SelectV2
                                aria-label="Step model"
                                class="!w-full !min-w-0"
                                options={stepModelOptions()}
                                current={stepModelOptions().find((option) => option.value === modelKey(step().model))}
                                value={(option) => option.value}
                                label={(option) => option.label}
                                onSelect={(option) =>
                                  option &&
                                  option.value !== modelKey(step().model) &&
                                  updateStep(step().key, {
                                    model: modelRef(option.value, step().model?.variant) ?? undefined,
                                  })
                                }
                                disabled={busy()}
                              />
                            </FieldV2>
                            <Show when={stepVariantOptions().length > 1}>
                              <FieldV2 class="min-w-0">
                                <FieldV2.Label>Effort</FieldV2.Label>
                                <SelectV2
                                  aria-label="Step effort"
                                  class="!w-full !min-w-0"
                                  options={stepVariantOptions()}
                                  current={stepVariantOptions().find(
                                    (option) => option.value === (step().model?.variant ?? ""),
                                  )}
                                  value={(option) => option.value}
                                  label={(option) => option.label}
                                  onSelect={(option) =>
                                    option &&
                                    option.value !== (step().model?.variant ?? "") &&
                                    updateStep(step().key, {
                                      model: modelRef(modelKey(step().model), option.value) ?? undefined,
                                    })
                                  }
                                  disabled={busy()}
                                />
                              </FieldV2>
                            </Show>
                          </div>
                          <div>
                            <p class="mb-2 text-[10px] uppercase tracking-[0.12em] text-v2-text-text-muted">
                              Insert data
                            </p>
                            <div class="flex flex-wrap gap-1.5">
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                onClick={() => insertBinding(step(), "{{ trigger.type }}")}
                              >
                                Trigger type
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                onClick={() => insertBinding(step(), "{{ trigger.scheduledAt }}")}
                              >
                                Scheduled time
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                onClick={() => insertBinding(step(), "{{ trigger.payload.repository }}")}
                              >
                                Project path
                              </ButtonV2>
                              <For
                                each={steps().slice(
                                  0,
                                  steps().findIndex((item) => item.key === step().key),
                                )}
                              >
                                {(source) => (
                                  <>
                                    <ButtonV2
                                      size="small"
                                      variant="neutral"
                                      onClick={() => insertBinding(step(), `{{ steps.${source.id}.output }}`)}
                                    >
                                      {source.id} output
                                    </ButtonV2>
                                    <ButtonV2
                                      size="small"
                                      variant="neutral"
                                      onClick={() => insertBinding(step(), `{{ steps.${source.id}.artifacts }}`)}
                                    >
                                      {source.id} artifacts
                                    </ButtonV2>
                                    <For each={outputKeys(source.id)}>
                                      {(key) => (
                                        <ButtonV2
                                          size="small"
                                          variant="neutral"
                                          onClick={() =>
                                            insertBinding(step(), `{{ steps.${source.id}.output.${key} }}`)
                                          }
                                        >
                                          {source.id} output.{key}
                                        </ButtonV2>
                                      )}
                                    </For>
                                  </>
                                )}
                              </For>
                            </div>
                            <Show when={steps().findIndex((item) => item.key === step().key) === 0}>
                              <p class="mt-2 text-[10px] text-v2-text-text-muted">
                                Step outputs become available to steps below this one.
                              </p>
                            </Show>
                          </div>
                        </div>
                      </>
                    )}
                  </Show>

                  <Show when={selectedNode() === "delivery"}>
                    <h3 class="mb-3 text-[13px] text-v2-text-text-base [font-weight:600]">TurenOS delivery</h3>
                    <p class="text-[12px] leading-5 text-v2-text-text-muted">
                      Each run executes in its own TurenOS Session. The final step's result is the run's outcome, and
                      every step's output is captured in run history.
                    </p>
                  </Show>
                </aside>
              </section>
            </Show>

            <Show when={tab() === "runs" && selected()}>
              <section data-component="loop-runs" class={PANEL}>
                <div class="flex items-center justify-between border-b border-v2-border-border-base px-4 py-3">
                  <h3 class="text-[13px] text-v2-text-text-base [font-weight:600]">Run history</h3>
                  <span class="text-[11px] tabular-nums text-v2-text-text-muted">{runs().length} runs</span>
                </div>
                <For
                  each={runs()}
                  fallback={
                    <div class="px-5 py-10 text-center text-[12px] text-v2-text-text-muted">
                      No runs yet. Use "Run now" to trigger one.
                    </div>
                  }
                >
                  {(run) => {
                    const steps = () => selected()?.workflow?.steps ?? []
                    const entries = () => orderedStepOutputs(run, steps())
                    const total = () => runTotal(run, steps())
                    const progress = () => runProgressLabel(run, steps())
                    const failed = () => failedCallout(run, steps())
                    return (
                    <div class="flex items-start gap-4 border-b border-v2-border-border-base px-4 py-3 last:border-b-0">
                      <span class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${RUN_TONE[run.status]}`} />
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-[12px] capitalize text-v2-text-text-base [font-weight:550]">
                            {run.status}
                          </span>
                          <span class="text-[11px] text-v2-text-text-muted">{run.trigger}</span>
                          <span class="text-[11px] text-v2-text-text-muted">
                            {new Date(run.scheduledAt).toLocaleString()}
                          </span>
                          <Show when={runDuration(run)}>
                            {(value) => (
                              <span class="text-[11px] tabular-nums text-v2-text-text-muted">{value()}</span>
                            )}
                          </Show>
                        </div>
                        <Show when={progress()}>
                          {(label) => (
                            <p class="mt-1 text-[11px] text-v2-state-fg-warning">{label()}</p>
                          )}
                        </Show>
                        <Show when={failed()}>
                          {(line) => (
                            <p class="mt-1 text-[11px] text-v2-state-fg-danger">
                              {line()}
                            </p>
                          )}
                        </Show>
                        <Show when={run.error && run.status !== "failed"}>
                          {(message) => <p class="mt-1 truncate text-[11px] text-v2-state-fg-danger">{message()}</p>}
                        </Show>
                        <Show when={entries().length}>
                          <div class="mt-3 grid gap-2">
                            <For each={entries()}>
                              {([stepID, output]) => {
                                const display = stepDisplay(stepID, steps(), total())
                                return (
                                  <RunStepCard
                                    stepID={stepID}
                                    name={display.name}
                                    index={display.index}
                                    total={display.total}
                                    state={stepState(run, stepID, display.index)}
                                    output={output}
                                  />
                                )
                              }}
                            </For>
                          </div>
                        </Show>
                      </div>
                      <Show
                        when={
                          run.sessionID && run.status !== "claimed" && run.status !== "running"
                            ? run.sessionID
                            : undefined
                        }
                      >
                        {(sessionID) => (
                          <div class="flex shrink-0 flex-col gap-2">
                            <ButtonV2
                              size="small"
                              variant="neutral"
                              onClick={() => {
                                const automation = selected()
                                if (automation) viewChat(automation, run)
                              }}
                            >
                              View chat
                            </ButtonV2>
                            <ButtonV2
                              size="small"
                              variant="ghost-muted"
                              onClick={() => navigate(sessionHref(serverKey, sessionID()))}
                            >
                              Open in agent chat
                            </ButtonV2>
                          </div>
                        )}
                      </Show>
                      <Show when={run.status === "claimed" || run.status === "running"}>
                        <ButtonV2
                          size="small"
                          variant="neutral"
                          disabled={busy()}
                          onClick={() => {
                            const automation = selected()
                            if (!automation || busy()) return
                            setBusy(true)
                            void api()
                              .runCancel({ loopID: automation.id, runID: run.id })
                              .then(refresh)
                              .catch((cause) =>
                                setError(cause instanceof Error ? cause.message : "Could not cancel run"),
                              )
                              .finally(() => setBusy(false))
                          }}
                        >
                          Cancel
                        </ButtonV2>
                      </Show>
                    </div>
                    )
                  }}
                </For>
              </section>
            </Show>
          </div>
        </main>
      </div>
    </section>
  )
}
