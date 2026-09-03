import { For, createMemo, createSignal } from "solid-js"
import "./system-map.css"

type Scope = "client" | "global" | "location" | "external"
type BuildingKind =
  | "screen"
  | "gateway"
  | "ledger"
  | "coordinator"
  | "location"
  | "runner"
  | "provider"
  | "tools"
  | "board"

type ArchitectureNode = {
  id: string
  name: string
  shortName: string
  eyebrow: string
  scope: Scope
  kind: BuildingKind
  x: number
  y: number
  height: number
  color: string
  summary: string
  detail: string
  facts: ReadonlyArray<string>
  citations: ReadonlyArray<string>
}

type TraceEdge = {
  d: string
  label: string
  labelX: number
  labelY: number
  labelWidth: number
}

type Trace = {
  id: "prompt" | "tools" | "replay" | "subagents"
  number: string
  name: string
  shortName: string
  color: string
  summary: string
  payload: string
  steps: ReadonlyArray<string>
  citations: ReadonlyArray<string>
  edges: ReadonlyArray<TraceEdge>
}

const nodes: ReadonlyArray<ArchitectureNode> = [
  {
    id: "renderer",
    name: "Desktop renderer",
    shortName: "Renderer",
    eyebrow: "Operator surface",
    scope: "client",
    kind: "screen",
    x: 70,
    y: 246,
    height: 72,
    color: "#5ed4c3",
    summary: "Solid UI and local desktop host",
    detail:
      "The renderer submits typed API requests and maintains a reactive, per-server view. The desktop host launches the TurenOS server as an Electron utility sidecar and waits for its authenticated health endpoint.",
    facts: [
      "Solid stores reduce live server events",
      "Electron owns sidecar lifecycle",
      "No session execution runs in the renderer",
    ],
    citations: ["packages/app/src/context/server-sync.tsx:354-432", "packages/desktop/src/main/server.ts:80-170"],
  },
  {
    id: "gateway",
    name: "Typed HTTP gateway",
    shortName: "HTTP API",
    eyebrow: "Authenticated boundary",
    scope: "global",
    kind: "gateway",
    x: 270,
    y: 154,
    height: 112,
    color: "#f3b95f",
    summary: "Effect HttpApi routes and workspace routing",
    detail:
      "The sidecar composes typed root, instance, event, PTY, and workbench routes. Authorization and workspace routing establish the request boundary before session handlers call the core service.",
    facts: [
      "Typed request and failure contracts",
      "Authorization precedes handlers",
      "Location is derived from request context",
    ],
    citations: [
      "packages/forge/src/server/routes/instance/httpapi/server.ts:171-233",
      "packages/server/src/handlers/session.ts:287-337",
    ],
  },
  {
    id: "ledger",
    name: "Durable event ledger",
    shortName: "Event ledger",
    eyebrow: "SQLite / WAL",
    scope: "global",
    kind: "ledger",
    x: 458,
    y: 300,
    height: 62,
    color: "#f1cf76",
    summary: "Ordered aggregates plus operational projections",
    detail:
      "EventV2 commits a versioned event, its projectors, aggregate sequence, and event row inside one immediate SQLite transaction. Session tables are projections; the durable event stream remains the ordering authority.",
    facts: [
      "WAL with FULL synchronous writes",
      "Per-aggregate sequence ordering",
      "Projection and event commit are atomic",
    ],
    citations: [
      "packages/core/src/database/database.ts:27-72",
      "packages/core/src/event.ts:251-404",
      "packages/core/src/session/projector.ts:1-180",
    ],
  },
  {
    id: "coordinator",
    name: "Session execution",
    shortName: "Coordinator",
    eyebrow: "Process-global control",
    scope: "global",
    kind: "coordinator",
    x: 438,
    y: 72,
    height: 102,
    color: "#f17f64",
    summary: "One local owner per active Session ID",
    detail:
      "SessionExecution owns the process-local coordinator. Wakes coalesce, explicit resumes join an existing run, and different Session IDs can drain concurrently. Placement is discovered only when a drain begins.",
    facts: [
      "Same-session work is serialized",
      "Different sessions run concurrently",
      "Wake is advisory, not durable ownership",
    ],
    citations: [
      "packages/core/src/session/execution/local.ts:56-104",
      "packages/core/src/session/run-coordinator.ts:42-171",
    ],
  },
  {
    id: "location",
    name: "Location service map",
    shortName: "Location map",
    eyebrow: "Workspace placement",
    scope: "global",
    kind: "location",
    x: 660,
    y: 142,
    height: 78,
    color: "#92b5ff",
    summary: "Lazy map from Location.Ref to scoped services",
    detail:
      "The global map lazily compiles a service graph for a directory and optional workspace identity. Each graph binds Location and owns workspace policy, files, tools, agents, permissions, models, and the SessionRunner.",
    facts: ["Created on first use", "Idle graphs expire after 60 minutes", "Global and Location scopes stay disjoint"],
    citations: ["packages/core/src/location-services.ts:55-138"],
  },
  {
    id: "runner",
    name: "Session runner",
    shortName: "Runner",
    eyebrow: "Located orchestration",
    scope: "location",
    kind: "runner",
    x: 700,
    y: 314,
    height: 118,
    color: "#bb8cff",
    summary: "History, context, provider turn, and continuation",
    detail:
      "The runner promotes durable input at safe boundaries, resolves agent and model context, reloads projected history, materializes tools, and owns the single explicit llm.stream call site. Bounded retries create fresh stream attempts; tool settlement stays here before continuation.",
    facts: [
      "One stream per provider attempt",
      "History reloads before continuation",
      "Tool fan-out is capped at eight",
    ],
    citations: ["packages/core/src/session/runner/llm.ts:560-875", "packages/core/src/session/runner/llm.ts:95-126"],
  },
  {
    id: "provider",
    name: "Model provider",
    shortName: "Provider",
    eyebrow: "External compute",
    scope: "external",
    kind: "provider",
    x: 900,
    y: 106,
    height: 138,
    color: "#ef80aa",
    summary: "Selected LLM transport and streaming response",
    detail:
      "A resolved model receives the lowered transcript, system context, and permission-filtered tool definitions. Its response returns as streamed text, reasoning, usage, errors, and tool-call frames.",
    facts: [
      "Model is resolved per provider turn",
      "Retries create a fresh stream",
      "Provider frames are persisted incrementally",
    ],
    citations: ["packages/core/src/session/runner/llm.ts:643-708", "packages/core/src/session/runner/llm.ts:868-919"],
  },
  {
    id: "tools",
    name: "Tool exchange",
    shortName: "Tool registry",
    eyebrow: "Policy boundary",
    scope: "location",
    kind: "tools",
    x: 890,
    y: 388,
    height: 72,
    color: "#63c5f4",
    summary: "Permission-filtered definitions and settlement",
    detail:
      "The Location-scoped registry materializes only allowed definitions, records execution before side effects, runs interceptors, validates tool input, and bounds output before returning it to the model.",
    facts: ["Definitions are turn-specific", "Execution is recorded before effects", "Output resources are bounded"],
    citations: ["packages/core/src/tool/registry.ts:87-246", "packages/core/src/tool/execution.ts:87-111"],
  },
  {
    id: "workspace",
    name: "Workspace services",
    shortName: "Workspace I/O",
    eyebrow: "Directory-scoped effects",
    scope: "location",
    kind: "location",
    x: 650,
    y: 510,
    height: 52,
    color: "#5fd18b",
    summary: "Filesystem, PTY, MCP, skills, policy",
    detail:
      "The located graph contains the concrete effects a tool can invoke: filesystem and search, mutation guards, PTYs, MCP sources, skills, plugins, snapshots, and permission checks.",
    facts: [
      "Bound to one directory",
      "Policy wraps mutations and process access",
      "Heavy MCP discovery is demand-driven",
    ],
    citations: [
      "packages/core/src/location-services.ts:55-102",
      "packages/forge/src/server/routes/instance/httpapi/server.ts:325-333",
    ],
  },
  {
    id: "board",
    name: "Team board",
    shortName: "Team board",
    eyebrow: "Durable collaboration",
    scope: "global",
    kind: "board",
    x: 308,
    y: 482,
    height: 58,
    color: "#78d8b6",
    summary: "Subagent findings and parent notifications",
    detail:
      "Specialized agents run as owned child Sessions. Their board posts are durable, bounded observations; the execution owner converts pending notes into durable parent inputs and schedules an advisory wake.",
    facts: [
      "Children have bounded authority",
      "Posts are data, never instructions",
      "Parent notification retries are idempotent",
    ],
    citations: [
      "packages/core/src/tool/subagent.ts:127-260",
      "packages/core/src/team/board.ts:1-220",
      "packages/core/src/session/execution/local.ts:146-197",
    ],
  },
]

const traces: ReadonlyArray<Trace> = [
  {
    id: "prompt",
    number: "01",
    name: "Durable prompt admission",
    shortName: "Prompt",
    color: "#f3b95f",
    summary: "The prompt is durable before model execution is scheduled.",
    payload: "Prompt -> admitted event -> Session ID -> LLM request",
    steps: [
      "The renderer sends a typed session.prompt request.",
      "SessionV2 validates retry identity and publishes PromptAdmitted.",
      "EventV2 atomically projects session_input and commits the event row.",
      "After commit, SessionV2 issues a process-local advisory wake; that wake is not durable.",
      "The drain resolves the Session's Location graph and invokes its runner.",
      "The runner reloads history and starts a provider attempt; bounded retries can start a fresh stream.",
    ],
    citations: [
      "packages/server/src/handlers/session.ts:287-337",
      "packages/core/src/session.ts:444-515",
      "packages/core/src/session/input.ts:119-183",
      "packages/core/src/session/execution/local.ts:56-104",
    ],
    edges: [
      { d: "M124 350 C190 350 220 304 324 294", label: "Prompt JSON", labelX: 200, labelY: 322, labelWidth: 86 },
      { d: "M324 294 C362 330 420 374 512 394", label: "session.prompt", labelX: 382, labelY: 351, labelWidth: 104 },
      { d: "M512 394 C470 320 400 286 324 294", label: "commit ack", labelX: 426, labelY: 318, labelWidth: 82 },
      { d: "M324 294 C360 238 420 210 492 220", label: "advisory wake", labelX: 410, labelY: 236, labelWidth: 102 },
      { d: "M492 220 C564 190 638 220 714 252", label: "Session ID", labelX: 578, labelY: 207, labelWidth: 82 },
      { d: "M714 252 C752 292 770 370 754 456", label: "Location.Ref", labelX: 736, labelY: 340, labelWidth: 92 },
      { d: "M754 456 C822 414 886 322 954 278", label: "LLM request", labelX: 846, labelY: 373, labelWidth: 92 },
    ],
  },
  {
    id: "tools",
    number: "02",
    name: "Tool settlement loop",
    shortName: "Tool loop",
    color: "#63c5f4",
    summary: "Calls are recorded before effects; results re-enter through durable history.",
    payload: "tool-call frame -> authorized input -> bounded result -> next turn",
    steps: [
      "The provider streams a non-provider-executed tool-call frame.",
      "The runner commits Tool.Called before starting settlement.",
      "ToolRegistry claims ToolExecution, applies policy, and invokes workspace effects.",
      "Bounded output and Tool.Result are committed after the effect settles.",
      "The runner waits for every call, reloads projected history, then continues.",
    ],
    citations: [
      "packages/core/src/session/runner/llm.ts:868-919",
      "packages/core/src/session/runner/publish-llm-event.ts:369-421",
      "packages/core/src/tool/registry.ts:87-246",
      "packages/core/src/tool/execution.ts:87-111",
    ],
    edges: [
      { d: "M954 278 C900 324 828 410 754 456", label: "tool-call frame", labelX: 836, labelY: 363, labelWidth: 108 },
      { d: "M754 456 C666 438 582 410 512 394", label: "Tool.Called", labelX: 632, labelY: 416, labelWidth: 88 },
      { d: "M512 394 C598 388 684 425 754 456", label: "call committed", labelX: 606, labelY: 398, labelWidth: 102 },
      { d: "M754 456 C820 447 880 474 944 492", label: "settle call", labelX: 820, labelY: 458, labelWidth: 84 },
      { d: "M944 492 C876 548 794 585 704 594", label: "authorized I/O", labelX: 818, labelY: 552, labelWidth: 104 },
      { d: "M704 594 C786 608 884 564 944 492", label: "bounded output", labelX: 820, labelY: 597, labelWidth: 108 },
      { d: "M944 492 C808 530 642 470 512 394", label: "Tool.Result", labelX: 700, labelY: 486, labelWidth: 88 },
      { d: "M512 394 C598 388 684 425 754 456", label: "projected history", labelX: 602, labelY: 408, labelWidth: 118 },
      { d: "M754 456 C822 414 886 322 954 278", label: "next LLM turn", labelX: 846, labelY: 373, labelWidth: 102 },
    ],
  },
  {
    id: "replay",
    number: "03",
    name: "Live projection replay",
    shortName: "Live UI",
    color: "#5ed4c3",
    summary: "Located events stream to the matching directory and reduce into UI stores.",
    payload: "committed event -> location filter -> SSE JSON -> Solid store",
    steps: [
      "A durable commit notifies EventV2 subscribers after its transaction settles.",
      "The event endpoint filters by directory and optional workspace identity.",
      "The sidecar encodes events and heartbeats as Server-Sent Events.",
      "ServerSync applies global or directory reducers to the Solid stores.",
    ],
    citations: [
      "packages/core/src/event.ts:372-404",
      "packages/forge/src/server/routes/instance/httpapi/handlers/event.ts:20-116",
      "packages/app/src/context/server-sync.tsx:354-432",
    ],
    edges: [
      { d: "M512 394 C448 358 386 318 324 294", label: "located event", labelX: 402, labelY: 344, labelWidth: 96 },
      { d: "M324 294 C250 304 190 336 124 350", label: "SSE event", labelX: 210, labelY: 318, labelWidth: 78 },
    ],
  },
  {
    id: "subagents",
    number: "04",
    name: "Subagent collaboration",
    shortName: "Subagents",
    color: "#78d8b6",
    summary: "A child is another durable Session; the board feeds verified progress back safely.",
    payload: "spawn request -> child prompt -> board note -> parent steer",
    steps: [
      "The parent calls spawn_agent through its turn-local tool registry.",
      "SessionTask creates an authority-bounded child Session and admits its prompt.",
      "The coordinator wakes the child and runs it through the same Location runner.",
      "The child posts bounded evidence to the durable Team Board.",
      "The execution owner admits a parent notification and schedules a safe-boundary wake.",
    ],
    citations: [
      "packages/core/src/tool/subagent.ts:127-260",
      "packages/core/src/team/board.ts:1-220",
      "packages/core/src/session/execution/local.ts:146-197",
    ],
    edges: [
      { d: "M754 456 C820 447 880 474 944 492", label: "spawn_agent", labelX: 822, labelY: 458, labelWidth: 94 },
      { d: "M944 492 C812 522 644 470 512 394", label: "child prompt", labelX: 704, labelY: 486, labelWidth: 92 },
      { d: "M512 394 C552 330 552 252 492 220", label: "child wake", labelX: 520, labelY: 294, labelWidth: 84 },
      { d: "M492 220 C568 190 640 220 714 252", label: "child Session ID", labelX: 570, labelY: 207, labelWidth: 112 },
      { d: "M714 252 C752 292 770 370 754 456", label: "same runner", labelX: 736, labelY: 340, labelWidth: 88 },
      { d: "M754 456 C650 510 516 554 362 566", label: "board_post", labelX: 548, labelY: 520, labelWidth: 88 },
      { d: "M362 566 C388 496 448 428 512 394", label: "parent input", labelX: 402, labelY: 474, labelWidth: 90 },
    ],
  },
]

const scopeLabels: Record<Scope, string> = {
  client: "Client",
  global: "Process-global",
  location: "Location-scoped",
  external: "External",
}

export default function SystemMapPage() {
  const [traceID, setTraceID] = createSignal<Trace["id"]>("prompt")
  const [nodeID, setNodeID] = createSignal("runner")
  const trace = createMemo(() => traces.find((item) => item.id === traceID()) ?? traces[0])
  const selected = createMemo(() => nodes.find((item) => item.id === nodeID()) ?? nodes[0])

  return (
    <main data-component="system-map" class="system-map-page">
      <header class="system-map-header">
        <div>
          <div class="system-map-kicker">
            <span>TurenOS</span>
            <span>/</span>
            <span>Runtime atlas</span>
          </div>
          <h1>How a session moves</h1>
          <p>A code-derived map of durable admission, located execution, tools, and live projection.</p>
        </div>
        <div class="system-map-status" aria-label="Map status: traced from current source">
          <span class="system-map-status__pulse" />
          <span>Traced from current source</span>
          <code>V2 / LOCAL</code>
        </div>
      </header>

      <div class="system-map-trace-picker" role="tablist" aria-label="Architecture traces">
        <For each={traces}>
          {(item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={traceID() === item.id}
              classList={{ "system-map-trace-picker__active": traceID() === item.id }}
              style={`--trace-color:${item.color}`}
              onClick={() => setTraceID(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                event.preventDefault()
                const offset = event.key === "ArrowRight" ? 1 : -1
                const next = (index() + offset + traces.length) % traces.length
                setTraceID(traces[next].id)
                const nextButton = event.currentTarget.parentElement?.children[next]
                if (nextButton instanceof HTMLElement) nextButton.focus()
              }}
            >
              <span>{item.number}</span>
              {item.shortName}
            </button>
          )}
        </For>
      </div>

      <div class="system-map-layout">
        <section class="system-map-canvas" aria-label={`Isometric system map showing ${trace().name}`}>
          <div class="system-map-canvas__meta">
            <span>ACTIVE TRACE</span>
            <strong>{trace().name}</strong>
            <code>{trace().payload}</code>
          </div>
          <div class="system-map-scroll">
            <svg
              class="system-map-svg"
              viewBox="0 0 1080 660"
              role="group"
              aria-labelledby="system-map-title system-map-description"
            >
              <title id="system-map-title">TurenOS session runtime architecture</title>
              <desc id="system-map-description">
                Isometric buildings represent the renderer, HTTP gateway, event ledger, execution coordinator, location
                map, session runner, provider, tool registry, workspace services, and team board.
              </desc>
              <defs>
                <pattern id="iso-grid" width="80" height="46" patternUnits="userSpaceOnUse">
                  <path d="M40 0 80 23 40 46 0 23Z" fill="none" stroke="rgba(130, 178, 157, .16)" stroke-width="1" />
                </pattern>
                <filter id="building-shadow" x="-40%" y="-40%" width="180%" height="200%">
                  <feGaussianBlur stdDeviation="8" />
                </filter>
                <For each={traces}>
                  {(item) => (
                    <marker
                      id={`arrow-${item.id}`}
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={item.color} />
                    </marker>
                  )}
                </For>
              </defs>

              <path
                d="M28 330 512 52 1052 364 568 642Z"
                fill="#091510"
                stroke="rgba(143, 198, 173, .2)"
                stroke-width="1"
              />
              <path d="M28 330 512 52 1052 364 568 642Z" fill="url(#iso-grid)" />
              <path class="system-map-zone" d="M78 330 290 208 426 286 214 408Z" />
              <path class="system-map-zone system-map-zone--global" d="M278 198 514 62 738 192 502 328Z" />
              <path class="system-map-zone system-map-zone--location" d="M492 352 746 206 1010 358 756 504Z" />
              <text class="system-map-zone-label" x="92" y="374">
                CLIENT EDGE
              </text>
              <text class="system-map-zone-label" x="360" y="142">
                GLOBAL CONTROL
              </text>
              <text class="system-map-zone-label" x="734" y="526">
                LOCATION / WORKSPACE
              </text>

              <g class="system-map-traces" style={`--trace-color:${trace().color}`}>
                <For each={trace().edges}>
                  {(edge, index) => (
                    <g>
                      <path class="system-map-trace-shadow" d={edge.d} />
                      <path class="system-map-trace-line" d={edge.d} marker-end={`url(#arrow-${trace().id})`} />
                      <g class="system-map-payload" aria-hidden="true">
                        <rect x="-4" y="-4" width="8" height="8" rx="2" fill={trace().color} />
                        <animateMotion
                          path={edge.d}
                          dur={`${3.4 + (index() % 3) * 0.45}s`}
                          begin={`${index() * 0.28}s`}
                          repeatCount="indefinite"
                        />
                      </g>
                      <g class="system-map-edge-label" transform={`translate(${edge.labelX} ${edge.labelY})`}>
                        <rect x={-edge.labelWidth / 2} y="-10" width={edge.labelWidth} height="20" rx="5" />
                        <text text-anchor="middle" dominant-baseline="middle">
                          {edge.label}
                        </text>
                      </g>
                    </g>
                  )}
                </For>
              </g>

              <For each={nodes}>
                {(node) => (
                  <Building node={node} selected={selected().id === node.id} onSelect={() => setNodeID(node.id)} />
                )}
              </For>
            </svg>
          </div>

          <div class="system-map-legend" aria-label="Map legend">
            <span class="system-map-legend__title">Legend</span>
            <span>
              <i class="scope-client" /> Client
            </span>
            <span>
              <i class="scope-global" /> Global
            </span>
            <span>
              <i class="scope-location" /> Located
            </span>
            <span>
              <i class="scope-external" /> External
            </span>
            <span class="system-map-legend__line">
              <i style={`--legend-color:${trace().color}`} /> Active payload path
            </span>
          </div>
        </section>

        <aside class="system-map-explainer" aria-live="polite">
          <section class="system-map-explainer__trace">
            <div class="system-map-panel-label">
              <span style={`background:${trace().color}`} /> Trace {trace().number}
            </div>
            <h2>{trace().name}</h2>
            <p>{trace().summary}</p>
            <ol>
              <For each={trace().steps}>
                {(step, index) => (
                  <li>
                    <span>{String(index() + 1).padStart(2, "0")}</span>
                    <p>{step}</p>
                  </li>
                )}
              </For>
            </ol>
            <SourceList citations={trace().citations} />
          </section>

          <section class="system-map-explainer__node">
            <div class="system-map-panel-label">
              <span style={`background:${selected().color}`} /> Selected structure
            </div>
            <div class="system-map-explainer__node-heading">
              <div>
                <small>{selected().eyebrow}</small>
                <h3>{selected().name}</h3>
              </div>
              <span class={`system-map-scope system-map-scope--${selected().scope}`}>
                {scopeLabels[selected().scope]}
              </span>
            </div>
            <p>{selected().detail}</p>
            <ul>
              <For each={selected().facts}>{(fact) => <li>{fact}</li>}</For>
            </ul>
            <SourceList citations={selected().citations} />
          </section>

          <footer>
            <span>Boundary note</span>
            <p>
              Execution ownership is process-local today. The Location map is placement discovery, not clustered
              ownership.
            </p>
          </footer>
        </aside>
      </div>
    </main>
  )
}

function Building(props: { node: ArchitectureNode; selected: boolean; onSelect: () => void }) {
  const node = () => props.node
  const h = () => node().height
  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onSelect()
  }

  return (
    <g
      class="system-building"
      classList={{ "system-building--selected": props.selected }}
      transform={`translate(${node().x} ${node().y})`}
      style={`--building-color:${node().color}`}
      role="button"
      tabIndex={0}
      aria-label={`${node().name}. ${node().summary}`}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      onKeyDown={keyDown}
    >
      <title>
        {node().name}: {node().summary}
      </title>
      <path class="system-building__shadow" d={`M-8 ${h() + 14} 54 ${h() + 48} 118 ${h() + 14} 54 ${h() - 20}Z`} />
      <path class="system-building__left" d={`M0 0 54 27 54 ${h() + 27} 0 ${h()}Z`} />
      <path class="system-building__right" d={`M54 27 108 0 108 ${h()} 54 ${h() + 27}Z`} />
      <path class="system-building__top" d="M0 0 54-27 108 0 54 27Z" />
      <path class="system-building__rim" d="M0 0 54 27 108 0" />
      <BuildingDetails kind={node().kind} height={node().height} />
      <path
        class="system-building__selection"
        d={`M-9 -4 54 -39 117 -4 117 ${h() + 7} 54 ${h() + 41} -9 ${h() + 7}Z`}
      />
      <g class="system-building__label" transform={`translate(54 ${h() + 50})`}>
        <rect x="-52" y="-12" width="104" height="25" rx="5" />
        <text text-anchor="middle" dominant-baseline="middle">
          {node().shortName}
        </text>
      </g>
    </g>
  )
}

function BuildingDetails(props: { kind: BuildingKind; height: number }) {
  if (props.kind === "ledger") {
    return (
      <g class="system-building__detail">
        <ellipse cx="79" cy="45" rx="17" ry="8" />
        <path d="M62 45v20c0 5 8 9 17 9s17-4 17-9V45" />
        <path d="M62 55c0 5 8 9 17 9s17-4 17-9M62 45c0 5 8 9 17 9s17-4 17-9" />
      </g>
    )
  }
  if (props.kind === "provider") {
    return (
      <g class="system-building__detail">
        <path d="M54-28v-30M42-51l12-12 12 12M45-35l9-9 9 9" />
        <circle cx="54" cy="-63" r="4" />
        <path d="M67 52h12v12H67zM86 42h12v12H86zM67 78h12v12H67zM86 68h12v12H86z" />
      </g>
    )
  }
  if (props.kind === "gateway") {
    return (
      <g class="system-building__detail">
        <path d={`M68 ${props.height}v-31c0-14 25-26 25-7v30`} />
        <path d="M20 24v18M30 29v18M40 34v18" />
        <path d="M54-28v-20M47-43l7-8 7 8" />
      </g>
    )
  }
  if (props.kind === "coordinator") {
    return (
      <g class="system-building__detail">
        <path d="M54-28v-24M36-42l18-10 18 10" />
        <circle cx="54" cy="-52" r="4" />
        <path d="M14 24h12v12H14zM34 34h12v12H34zM66 48h12v12H66zM86 38h12v12H86z" />
      </g>
    )
  }
  if (props.kind === "runner") {
    return (
      <g class="system-building__detail">
        <path d="M13 22h11v11H13zM31 31h11v11H31zM13 47h11v11H13zM31 56h11v11H31z" />
        <path d="M67 50h11v11H67zM86 40h11v11H86zM67 75h11v11H67zM86 65h11v11H86z" />
        <path d="M46-26v-20h16v20M50-46v-8h8v8" />
      </g>
    )
  }
  if (props.kind === "tools") {
    return (
      <g class="system-building__detail">
        <path d="M12 25h32v28H12zM67 42h30v28H67z" />
        <path d="M21 20v-12M28 24V8M35 27V8M77 37V22M84 34V18M91 30V14" />
      </g>
    )
  }
  if (props.kind === "board") {
    return (
      <g class="system-building__detail">
        <path d="M15 17h32v24H15zM19 22h24v14H19zM67 38h28v22H67zM72 43h18M72 49h14M72 55h16" />
      </g>
    )
  }
  if (props.kind === "screen") {
    return (
      <g class="system-building__detail">
        <path d="M13 16h34v29H13zM18 21h24v17H18zM24 49h12M67 38h30v24H67z" />
        <path d="M72 44h20M72 50h15M72 56h18" />
      </g>
    )
  }
  return (
    <g class="system-building__detail">
      <path d="M12 22h34v24H12zM67 39h30v24H67z" />
      <path d="M18 27h8v8h-8zM32 34h8v8h-8zM73 44h8v8h-8zM86 38h8v8h-8z" />
      <path d="M38-18v-16M70-18v-16" />
    </g>
  )
}

function SourceList(props: { citations: ReadonlyArray<string> }) {
  return (
    <div class="system-map-sources">
      <span>Source trail</span>
      <For each={props.citations}>{(citation) => <code>{citation}</code>}</For>
    </div>
  )
}
