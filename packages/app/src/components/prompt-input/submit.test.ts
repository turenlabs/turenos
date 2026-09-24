import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createPromptState } from "@/context/prompt-state"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import { ServerScope } from "@/utils/server-scope"
import { createPromptAdmission } from "./prompt-admission"
import { Worktree } from "@/utils/worktree"
import type { SessionGoalInfo } from "@turenlabs/sdk/v2/client"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let sendFollowupDraft: typeof import("./submit").sendFollowupDraft
let readPromptAdmission: typeof import("./submit").readPromptAdmission

const createdClients: string[] = []
const createdSessions: string[] = []
const createInputs: Array<{ id?: string }> = []
const createErrors: unknown[] = []
let draftPlacement = { type: "draft", draftID: "draft-1", server: "project-server", directory: "/repo/main" }
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    id: string
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
  parts?: Array<{ type: string; text?: string }>
}> = []
const optimisticSeeded: boolean[] = []
const optimisticRemovals: string[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const activationStarts: Array<{ scope: string; directory: string; sessionID: string; draftID?: string }> = []
const v2Prompts: string[] = []
const v2PromptPayloads: Array<Record<string, unknown>> = []
const v2Shells: Array<Record<string, unknown>> = []
const v2Commands: Array<Record<string, unknown>> = []
const v2Gets: string[] = []
const v2AgentSwitches: string[] = []
const v2ModelSwitches: Array<Record<string, unknown>> = []
const v2PromptErrors: unknown[] = []
const v2ShellErrors: unknown[] = []
const v2CommandErrors: unknown[] = []
const v2PendingInputReads: string[] = []
const v2MessageReads: string[] = []
const v2InputStatusReads: string[] = []
const v2PendingInputErrors: unknown[] = []
const v2MessageErrors: unknown[] = []
const pendingInputIDs: string[] = []
const projectedMessageIDs = new Set<string>()
const inputStatuses = new Map<string, "admitted" | "promoted" | "cancelled">()
const extensionLists: string[] = []
const abortOrder: string[] = []
const interrupted: Array<{ directory: string; sessionID: string }> = []
const interruptErrors: unknown[] = []
const todoWrites: unknown[][] = []
const toasts: Array<{ title?: string; description?: string }> = []
const restoredPrompts: Prompt[] = []
const configuredCommands: Array<{ name: string; source?: "command" | "mcp" | "skill" }> = []
const configuredSkills: string[] = []
const promptContextItems: Array<{ key: string; type: "file"; path: string }> = []
const promotionOperations: string[] = []

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let newLayoutDesigns = false
let automationsEnabled = false
const navigations: string[] = []
const loops: Array<{ id: string; name: string; status: string; directory: string }> = []
const loopRuns: Array<{ id: string; loopID: string; status: string }> = []
const pausedLoops: string[] = []
const cancelledLoopRuns: string[] = []
let createSessionGate: Promise<void> | undefined
let createWorktreeGate: Promise<void> | undefined
let v2CommandGate: Promise<void> | undefined
let v2PromptGate: Promise<void> | undefined
let sdkScope = "local"
let resetCount = 0
let interruptGate: Promise<void> | undefined
let selectedClient: ReturnType<typeof clientFor> | undefined

type CapturedPrompt = ReturnType<ReturnType<typeof usePrompt>["capture"]>

let capturePrompt: ((scope?: unknown) => CapturedPrompt) | undefined

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const prompt = {
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  save: async () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => {
    resetCount++
  },
  set: (value: Prompt) => {
    restoredPrompts.push(value)
  },
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => promptContextItems,
  },
  capture: (scope?: unknown): CapturedPrompt => capturePrompt?.(scope) ?? (prompt as unknown as CapturedPrompt),
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  const create = async (input: { id?: string } = {}) => {
    createInputs.push(input)
    await createSessionGate
    if (createErrors.length) throw createErrors.shift()
    createdSessions.push(directory)
    const id = `session-${createdSessions.length}`
    return {
      data: {
        data: {
          id,
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() },
          title: `New session ${createdSessions.length}`,
          location: { directory },
          agent: "agent",
          model: { id: "model", providerID: "provider", variant },
        },
      },
    }
  }
  return {
    v2: {
      loop: {
        list: async () => ({
          data: {
            data: loops.map((item) => ({
              id: item.id,
              name: item.name,
              status: item.status,
              location: { directory: item.directory },
            })),
          },
        }),
        pause: async ({ loopID }: { loopID: string }) => {
          pausedLoops.push(loopID)
          return { data: { data: {} } }
        },
        run: {
          list: async ({ loopID }: { loopID: string }) => ({
            data: { data: loopRuns.filter((run) => run.loopID === loopID) },
          }),
          cancel: async ({ loopID, runID }: { loopID: string; runID: string }) => {
            cancelledLoopRuns.push(`${loopID}/${runID}`)
            return { data: { data: {} } }
          },
        },
      },
      session: {
        create,
        active: async () => ({ data: { data: {} as Record<string, boolean> } }),
        get: async ({ sessionID }: { sessionID: string }) => {
          v2Gets.push(sessionID)
          return {
            data: {
              data: {
                id: sessionID,
                agent: "agent",
                model: { id: "model", providerID: "provider", variant },
              },
            },
          }
        },
        switchAgent: async (input: { agent: string }) => {
          v2AgentSwitches.push(input.agent)
          return { data: undefined }
        },
        switchModel: async (input: Record<string, unknown>) => {
          v2ModelSwitches.push(input)
          return { data: undefined }
        },
        prompt: async (payload: Record<string, unknown>) => {
          const sessionID = payload.sessionID as string
          v2Prompts.push(sessionID)
          v2PromptPayloads.push(payload)
          await v2PromptGate
          if (v2PromptErrors.length) throw v2PromptErrors.shift()
          return { data: undefined }
        },
        pendingInputs: async ({ sessionID }: { sessionID: string }) => {
          v2PendingInputReads.push(sessionID)
          if (v2PendingInputErrors.length) throw v2PendingInputErrors.shift()
          return { data: { data: pendingInputIDs.map((id) => ({ id })) } }
        },
        inputStatus: async ({ messageID }: { messageID: string }) => {
          v2InputStatusReads.push(messageID)
          const status = inputStatuses.get(messageID)
          return { data: status ? { data: { id: messageID, status } } : {} }
        },
        message: async ({ messageID }: { messageID: string }) => {
          v2MessageReads.push(messageID)
          if (v2MessageErrors.length) throw v2MessageErrors.shift()
          if (projectedMessageIDs.has(messageID)) return { data: { data: { id: messageID } } }
          throw Object.assign(new Error("Message not found"), { status: 404 })
        },
        shell: async (payload: Record<string, unknown>) => {
          v2Shells.push(payload)
          if (v2ShellErrors.length) throw v2ShellErrors.shift()
          return { data: undefined }
        },
        command: async (payload: Record<string, unknown>) => {
          v2Commands.push(payload)
          if (v2CommandErrors.length) throw v2CommandErrors.shift()
          await v2CommandGate
          return { data: undefined }
        },
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          abortOrder.push("interrupt")
          interrupted.push({ directory, sessionID })
          await interruptGate
          if (interruptErrors.length) throw interruptErrors.shift()
          return { data: undefined }
        },
      },
    },
    session: {
      create: async () => {
        const result = await create()
        return { data: result.data.data }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async () => ({ data: undefined }),
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => {
        await createWorktreeGate
        return { data: { directory: `${directory}/new` } }
      },
    },
    extension: {
      list: async () => {
        extensionLists.push(directory)
        return {
          data: configuredSkills.map((name) => ({
            enabled: true,
            manifest: {
              contributions: [{ type: "skill", id: name, name, description: `${name} description` }],
            },
          })),
        }
      },
    },
  }
}

function admissionForTest() {
  const values = new Map<string, string>()
  return createPromptAdmission({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
      keys: () => [...values.keys()],
    },
  })
}

function followupPromptInput(messageID: string, optimisticCalls: string[], statuses?: string[]) {
  let revision = 0
  return {
    scope: ServerScope.local,
    admission: admissionForTest(),
    client: clientFor("/repo/followup") as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
    serverSync: {
      session: {
        set: (_key: string, _sessionID: string, value: { type: string }) => {
          revision++
          statuses?.push(value.type)
        },
      },
    } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
    sync: {
      data: { command: [], session_working: () => false },
      session: {
        statusRevision: () => revision,
        optimistic: {
          add: () => optimisticCalls.push("add"),
          remove: () => optimisticCalls.push("remove"),
        },
      },
    } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
    draft: {
      sessionID: "session-followup",
      sessionDirectory: "/repo/followup",
      prompt: [{ type: "text" as const, content: "Continue", start: 0, end: 8 }],
      context: [],
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
    },
    messageID,
    optimisticBusy: true,
  } satisfies Parameters<typeof sendFollowupDraft>[0]
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")
  // `mock.module` replaces the module for the whole `bun test` process, so these stubs have to
  // keep every export the rest of the suite reads - swapping a namespace wholesale used to strip
  // `ServerConnection` and break files that run after this one.
  const serverContext = await import("@/context/server")
  const dialogContext = await import("@turenlabs/ui/context/dialog")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (path: string) => {
      navigations.push(path)
    },
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@turenlabs/sdk/v2/client", () => ({
    createForgeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@turenlabs/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: (value: { title?: string; description?: string }) => {
      toasts.push(value)
      return 0
    },
  }))

  mock.module("@turenlabs/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
    checksum: () => "checksum",
    sampledChecksum: () => "checksum",
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/server", () => ({
    ...serverContext,
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({ server: undefined }),
  }))

  // `createPromptSubmit` runs as component setup in production, so it resolves the dialog context
  // up front the same way it resolves every other context. These tests drive it without a reactive
  // owner, so the context is stubbed here alongside the rest.
  mock.module("@turenlabs/ui/context/dialog", () => ({
    ...dialogContext,
    useDialog: () => ({
      active: undefined,
      show: () => undefined,
      push: () => undefined,
      close: () => undefined,
    }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => draftPlacement,
      get store() {
        return [draftPlacement]
      },
      state: (tab: { type: string; sessionId?: string }) =>
        tab.type === "session" ? (capturePrompt?.({ id: tab.sessionId }) ?? prompt) : (capturePrompt?.() ?? prompt),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotionOperations.push("promote")
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      activation: {
        start: (input: { scope: string; directory: string; sessionID: string; draftID?: string }) => {
          activationStarts.push(input)
        },
      },
    }),
  }))

  mock.module("@/context/global", () => ({
    useGlobal: () => ({
      ensureServerCtx: () => ({ sdk: { client: rootClient } }),
    }),
  }))

  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      general: {
        newLayoutDesigns: () => newLayoutDesigns,
        automationsEnabled: () => automationsEnabled,
        setAutomationsEnabled: (value: boolean) => {
          automationsEnabled = value
        },
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        get scope() {
          return sdkScope
        },
        directory: "/repo/main",
        get client() {
          return selectedClient ?? rootClient
        },
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: configuredCommands, session_working: () => false },
      session: {
        statusRevision: () => 0,
        optimistic: {
          add: (value: (typeof optimistic)[number]) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: (value: { messageID: string }) => optimisticRemovals.push(value.messageID),
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: (...args: unknown[]) => {
          if (args[0] === "todo") todoWrites.push(args)
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  sendFollowupDraft = mod.sendFollowupDraft
  readPromptAdmission = mod.readPromptAdmission
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  createInputs.length = 0
  createErrors.length = 0
  draftPlacement = { type: "draft", draftID: "draft-1", server: "project-server", directory: "/repo/main" }
  optimistic.length = 0
  optimisticSeeded.length = 0
  optimisticRemovals.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  activationStarts.length = 0
  params = {}
  search = {}
  newLayoutDesigns = false
  automationsEnabled = false
  navigations.length = 0
  loops.length = 0
  loopRuns.length = 0
  pausedLoops.length = 0
  cancelledLoopRuns.length = 0
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  createSessionGate = undefined
  createWorktreeGate = undefined
  v2CommandGate = undefined
  v2PromptGate = undefined
  sdkScope = "local"
  resetCount = 0
  v2Prompts.length = 0
  v2PromptPayloads.length = 0
  v2Shells.length = 0
  v2Commands.length = 0
  v2Gets.length = 0
  v2AgentSwitches.length = 0
  v2ModelSwitches.length = 0
  v2PromptErrors.length = 0
  v2ShellErrors.length = 0
  v2CommandErrors.length = 0
  v2PendingInputReads.length = 0
  v2MessageReads.length = 0
  v2InputStatusReads.length = 0
  v2PendingInputErrors.length = 0
  v2MessageErrors.length = 0
  pendingInputIDs.length = 0
  projectedMessageIDs.clear()
  inputStatuses.clear()
  extensionLists.length = 0
  abortOrder.length = 0
  interrupted.length = 0
  interruptErrors.length = 0
  todoWrites.length = 0
  interruptGate = undefined
  selectedClient = undefined
  toasts.length = 0
  restoredPrompts.length = 0
  configuredCommands.length = 0
  configuredSkills.length = 0
  promptContextItems.length = 0
  promotionOperations.length = 0
  capturePrompt = undefined
  promptValue[0] = { type: "text", content: "ls", start: 0, end: 2 }
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

function stopControls(onAbort?: () => Promise<void>) {
  return createPromptSubmit({
    prompt,
    info: () => ({ id: "session-1" }),
    imageAttachments: () => [],
    commentCount: () => 0,
    mode: () => "normal",
    working: () => true,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: () => 2,
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    onAbort,
  })
}

function newDraftControls(info: () => { id: string } | undefined = () => undefined, shouldQueue?: () => boolean) {
  return createPromptSubmit({
    prompt,
    info,
    imageAttachments: () => [],
    commentCount: () => 0,
    mode: () => "normal",
    working: () => false,
    editor: () => undefined,
    queueScroll: () => undefined,
    promptLength: () => 2,
    addToHistory: () => undefined,
    resetHistoryNavigation: () => undefined,
    setMode: () => undefined,
    setPopover: () => undefined,
    newSessionWorktree: () => selected,
    shouldQueue,
  })
}
const submitEvent = () => ({ preventDefault() {} }) as unknown as Event
const waitUntil = async (ready: () => boolean) => {
  const deadline = Date.now() + 1000
  while (!ready() && Date.now() < deadline) await Bun.sleep(1)
  expect(ready()).toBe(true)
}

describe("prompt submit worktree selection", () => {
  test("coalesces an existing composer's double Enter without swallowing a later identical prompt", async () => {
    params = { id: "session-1" }
    const source = createPromptState({ prompt: "first prompt" })
    capturePrompt = () => source
    const gate = Promise.withResolvers<void>()
    v2PromptGate = gate.promise
    let busy = false
    const controls = newDraftControls(
      () => ({ id: "session-1" }),
      () => busy,
    )
    const first = controls.handleSubmit(submitEvent())
    busy = true
    const duplicate = controls.handleSubmit(submitEvent())
    expect(duplicate).toBe(first)
    await waitUntil(() => v2PromptPayloads.length === 1)
    expect(source.current()[0]).toMatchObject({ content: "" })
    source.set([{ type: "text", content: "first prompt", start: 0, end: 12 }])
    const next = controls.handleSubmit(submitEvent())
    expect(next).not.toBe(first)
    await waitUntil(() => v2PromptPayloads.length === 2)
    gate.resolve()
    await Promise.all([first, next])
    expect(v2PromptPayloads[0].id).not.toBe(v2PromptPayloads[1].id)
  })

  test.each([
    ["rejected", false],
    ["rejected", true],
    ["unknown", false],
    ["unknown", true],
  ] as const)("reconciles %s send activity from the server: active=%s", async (outcome, active) => {
    v2PromptErrors.push(
      ...Array.from({ length: outcome === "unknown" ? 4 : 1 }, () =>
        outcome === "unknown"
          ? new TypeError("Failed to fetch")
          : Object.assign(new Error("invalid prompt"), { status: 400 }),
      ),
    )
    const statuses: string[] = []
    const input = followupPromptInput(`${outcome}-active-${active}`, [], statuses)
    const client = clientFor("/repo/followup")
    client.v2.session.active = async () => ({
      data: { data: Object.fromEntries<boolean>(active ? [["session-followup", true]] : []) },
    })
    input.client = client as unknown as typeof input.client
    expect(await sendFollowupDraft(input)).toBe(outcome)
    expect(statuses).toEqual(active ? ["busy"] : ["busy", "idle"])
    expect(input.admission.get(input.scope, input.draft.sessionID, input.messageID)?.payload.id).toBe(input.messageID)
  })

  test.each(["rejected", "unknown"] as const)(
    "a %s send activity check cannot overwrite a newer status",
    async (outcome) => {
      v2PromptErrors.push(
        ...Array.from({ length: outcome === "unknown" ? 4 : 1 }, () =>
          outcome === "unknown"
            ? new TypeError("Failed to fetch")
            : Object.assign(new Error("invalid prompt"), { status: 400 }),
        ),
      )
      const statuses: string[] = []
      const input = followupPromptInput("rejected-newer-status", [], statuses)
      const client = clientFor("/repo/followup")
      client.v2.session.active = async () => {
        input.serverSync.session.set("session_status", "session-followup", { type: "busy" })
        return { data: { data: {} } }
      }
      input.client = client as unknown as typeof input.client
      expect(await sendFollowupDraft(input)).toBe(outcome)
      expect(statuses).toEqual(["busy", "busy"])
    },
  )

  test("bounds draft hydration and never promotes after its deadline", async () => {
    search = { draftId: "draft-1" }
    const source = createPromptState({ prompt: "first prompt" })
    const gate = Promise.withResolvers<boolean>()
    const session = {
      ...createPromptState(),
      ready: Object.assign(() => false, { promise: gate.promise }),
      save: async () => true,
    }
    capturePrompt = (scope) => (scope ? session : source)
    await newDraftControls().handleSubmit(submitEvent())
    gate.resolve(true)
    await Bun.sleep(10)
    expect(source.current()[0]).toMatchObject({ content: "first prompt" })
    expect(promotedDrafts).toHaveLength(0)
    expect(v2PromptPayloads).toHaveLength(0)
    expect(toasts).toHaveLength(1)
  }, 10_000)

  test("bounds destination persistence, preserves the draft, and allows retry after a late save", async () => {
    search = { draftId: "draft-1" }
    const source = createPromptState({ prompt: "first prompt" })
    const gate = Promise.withResolvers<boolean>()
    const session = { ...createPromptState(), save: () => gate.promise }
    capturePrompt = (scope) => (scope ? session : source)
    const controls = newDraftControls()
    await controls.handleSubmit(submitEvent())
    gate.resolve(true)
    await Bun.sleep(10)
    expect(source.current()[0]).toMatchObject({ content: "first prompt" })
    expect(promotedDrafts).toHaveLength(0)
    expect(v2PromptPayloads).toHaveLength(0)
    await controls.handleSubmit(submitEvent())
    expect(v2PromptPayloads).toHaveLength(1)
  }, 10_000)

  test("coalesces double Enter during delayed Session creation", async () => {
    search = { draftId: "draft-1" }
    const gate = Promise.withResolvers<void>()
    createSessionGate = gate.promise
    const controls = newDraftControls()
    const first = controls.handleSubmit(submitEvent())
    const second = controls.handleSubmit(submitEvent())
    expect(second).toBe(first)
    await waitUntil(() => createInputs.length === 1)
    gate.resolve()
    await first
    expect(createdSessions).toHaveLength(1)
    expect(v2PromptPayloads).toHaveLength(1)
  })

  test("preserves a reopened draft's newer prompt and model through delayed creation", async () => {
    search = { draftId: "draft-1" }
    const first = createPromptState({ prompt: "first prompt" })
    const reopened = createPromptState({ prompt: "next prompt", model: { providerID: "next", modelID: "model" } })
    const session = { ...createPromptState(), save: async () => true }
    let source = first
    capturePrompt = (scope) => (scope ? session : source)
    const gate = Promise.withResolvers<void>()
    createSessionGate = gate.promise
    const sending = newDraftControls().handleSubmit(submitEvent())
    await waitUntil(() => createInputs.length === 1)
    source = reopened
    gate.resolve()
    await sending
    expect(v2PromptPayloads[0].prompt).toMatchObject({ text: "first prompt" })
    expect(session.current()[0]).toMatchObject({ content: "next prompt" })
    expect(session.model.current()).toEqual({ providerID: "next", modelID: "model" })
    expect(promotedDrafts).toHaveLength(1)
  })

  test("retains the original draft and makes no POST when destination persistence fails", async () => {
    search = { draftId: "draft-1" }
    const first = createPromptState({ prompt: "first prompt" })
    const session = { ...createPromptState(), save: async () => false }
    capturePrompt = (scope) => (scope ? session : first)
    await newDraftControls().handleSubmit(submitEvent())
    expect(first.current()[0]).toMatchObject({ content: "first prompt" })
    expect(promotedDrafts).toHaveLength(0)
    expect(v2PromptPayloads).toHaveLength(0)
    expect(toasts.some((toast) => toast.description?.includes("safely moved"))).toBe(true)
  })

  test("retains a draft edited while its destination save is pending", async () => {
    search = { draftId: "draft-1" }
    const first = createPromptState({ prompt: "first prompt" })
    const gate = Promise.withResolvers<boolean>()
    let saving = false
    const session = {
      ...createPromptState(),
      save: () => {
        saving = true
        return gate.promise
      },
    }
    capturePrompt = (scope) => (scope ? session : first)
    const sending = newDraftControls().handleSubmit(submitEvent())
    await waitUntil(() => saving)
    first.set([{ type: "text", content: "newer while saving", start: 0, end: 18 }])
    gate.resolve(true)
    await sending
    expect(first.current()[0]).toMatchObject({ content: "newer while saving" })
    expect(promotedDrafts).toHaveLength(0)
    expect(v2PromptPayloads).toHaveLength(0)
  })

  test("releases failed creation ownership and retries the same Session identity", async () => {
    search = { draftId: "draft-1" }
    createErrors.push(new Error("offline"))
    const controls = newDraftControls()
    await controls.handleSubmit(submitEvent())
    expect(v2PromptPayloads).toHaveLength(0)
    await controls.handleSubmit(submitEvent())
    expect(createInputs).toHaveLength(2)
    expect(createInputs[0].id).toBe(createInputs[1].id)
    expect(v2PromptPayloads).toHaveLength(1)
  })

  test("binds creation retry identity to selected placement", async () => {
    search = { draftId: "draft-1" }
    createErrors.push(new Error("lost response"))
    const controls = newDraftControls()
    await controls.handleSubmit(submitEvent())
    selected = "/repo/worktree-b"
    await controls.handleSubmit(submitEvent())
    expect(createInputs).toHaveLength(2)
    expect(createInputs[0].id).not.toBe(createInputs[1].id)
  })

  test("preserves changed project placement during delayed creation", async () => {
    search = { draftId: "draft-1" }
    const source = createPromptState({ prompt: "first prompt" })
    const session = { ...createPromptState(), save: async () => true }
    capturePrompt = (scope) => (scope ? session : source)
    const gate = Promise.withResolvers<void>()
    createSessionGate = gate.promise
    const sending = newDraftControls().handleSubmit(submitEvent())
    await waitUntil(() => createInputs.length === 1)
    draftPlacement = { ...draftPlacement, directory: "/project-b" }
    gate.resolve()
    await sending
    expect(promotedDrafts).toHaveLength(0)
    expect(source.current()[0]).toMatchObject({ content: "first prompt" })
    expect(v2PromptPayloads).toHaveLength(0)
  })

  test("captures new-session intent before worktree creation and later navigation", async () => {
    search = { draftId: "draft-1" }
    selected = "create"
    const gate = Promise.withResolvers<void>()
    createWorktreeGate = gate.promise
    let info: { id: string } | undefined
    const sending = newDraftControls(() => info).handleSubmit(submitEvent())
    await Bun.sleep(1)
    params.id = "existing-other-session"
    info = { id: "existing-other-session" }
    gate.resolve()
    await waitUntil(() => createdSessions.length === 1)
    Worktree.ready(ServerScope.local, "/repo/main/new")
    await sending
    expect(createdSessions).toHaveLength(1)
    expect(v2PromptPayloads[0].sessionID).toBe("session-1")
    expect(v2PromptPayloads[0].sessionID).not.toBe("existing-other-session")
  })

  test("keeps requests and promotion scoped to the server captured before creation", async () => {
    search = { draftId: "draft-1" }
    const gate = Promise.withResolvers<void>()
    createSessionGate = gate.promise
    const sending = newDraftControls().handleSubmit(submitEvent())
    await waitUntil(() => createInputs.length === 1)
    sdkScope = "different-server"
    selectedClient = clientFor("/other-server")
    gate.resolve()
    await sending
    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(promoted).toHaveLength(0)
    expect(activationStarts).toHaveLength(0)
    expect(v2PromptPayloads).toHaveLength(1)
  })

  test("bounds hung creation and permits a later exact-identity retry", async () => {
    search = { draftId: "draft-1" }
    createSessionGate = new Promise(() => {})
    const controls = newDraftControls()
    await controls.handleSubmit(submitEvent())
    expect(v2PromptPayloads).toHaveLength(0)
    createSessionGate = undefined
    await controls.handleSubmit(submitEvent())
    expect(createInputs).toHaveLength(2)
    expect(createInputs[0].id).toBe(createInputs[1].id)
    expect(v2PromptPayloads).toHaveLength(1)
  }, 15_000)

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual([])
    expect(v2Shells).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        sessionShellPayload: expect.objectContaining({ command: "ls" }),
      }),
      expect.objectContaining({
        sessionID: "session-2",
        sessionShellPayload: expect.objectContaining({ command: "ls" }),
      }),
    ])
    expect(
      v2Shells.every((payload) => {
        const body = payload.sessionShellPayload
        return !!body && typeof body === "object" && "id" in body && String(body.id).startsWith("msg_")
      }),
    ).toBe(true)
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("retries an ambiguous V2 shell response once with the identical durable payload", async () => {
    params = { id: "session-1" }
    v2ShellErrors.push(new TypeError("Failed to fetch"))
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(v2Shells).toHaveLength(2)
    expect(v2Shells[1]).toBe(v2Shells[0])
    expect(v2Shells[0]).toMatchObject({
      sessionID: "session-1",
      sessionShellPayload: { command: "ls" },
    })
    expect((v2Shells[0]?.sessionShellPayload as { id?: string }).id).toStartWith("msg_")
    expect(sentShell).toEqual([])
    expect(restoredPrompts).toEqual([])
    expect(toasts).toEqual([])
  })

  test("does not retry a definitive shell 409 and restores the draft", async () => {
    params = { id: "session-1" }
    v2ShellErrors.push(
      new Error("Shell message ID conflicts with an existing durable record", {
        cause: { status: 409, body: { _tag: "ConflictError" } },
      }),
    )
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(v2Shells).toHaveLength(1)
    expect(restoredPrompts).toEqual([promptValue])
    expect(toasts.at(-1)).toEqual({
      title: "prompt.toast.shellSendFailed.title",
      description: "Shell message ID conflicts with an existing durable record",
    })
  })

  test("does not retry an unsupported custom-command 400 and preserves the actionable draft", async () => {
    params = { id: "session-1" }
    configuredCommands.push({ name: "review" })
    configuredSkills.push("review")
    promptValue[0] = { type: "text", content: "/review target", start: 0, end: 14 }
    v2CommandErrors.push(
      new Error("Inline shell commands are not supported by the durable Session runtime", {
        cause: { status: 400, body: { _tag: "InvalidRequestError" } },
      }),
    )
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 14,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(v2Commands).toHaveLength(1)
    expect(v2Commands[0]).toMatchObject({
      sessionID: "session-1",
      sessionCommandPayload: {
        command: "review",
        arguments: "target",
        model: { providerID: "provider", id: "model" },
        resume: true,
      },
    })
    const commandPayload = v2Commands[0]?.sessionCommandPayload
    if (!commandPayload || typeof commandPayload !== "object" || !("id" in commandPayload)) {
      throw new Error("Expected the command to have a message ID")
    }
    const commandID = commandPayload.id
    if (typeof commandID !== "string") throw new Error("Expected the command message ID to be a string")
    expect(commandID).toStartWith("msg_")
    expect(optimisticRemovals).toEqual([commandID])
    expect(restoredPrompts).toEqual([promptValue])
    expect(toasts.at(-1)).toEqual({
      title: "prompt.toast.commandSendFailed.title",
      description: "Inline shell commands are not supported by the durable Session runtime",
    })
  })

  test("routes an installed skill slash through the durable command endpoint", async () => {
    params = { id: "session-1" }
    configuredSkills.push("threat-intel-brief")
    configuredCommands.push({ name: "threat-intel-brief", source: "skill" })
    promptValue[0] = {
      type: "text",
      content: "/threat-intel-brief 8.8.8.8 include confidence",
      start: 0,
      end: 50,
    }
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 50,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      resolveSkillSlash: (text) =>
        text === "/threat-intel-brief 8.8.8.8 include confidence"
          ? { name: "threat-intel-brief", arguments: "8.8.8.8 include confidence" }
          : undefined,
    })

    const commandGate = Promise.withResolvers<void>()
    v2CommandGate = commandGate.promise
    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    const deadline = Date.now() + 1_000
    while (v2Commands.length === 0 && Date.now() < deadline) await Bun.sleep(1)

    expect(v2PromptPayloads).toHaveLength(0)
    expect(v2Commands).toHaveLength(1)
    expect(v2Commands[0]).toMatchObject({
      sessionID: "session-1",
      sessionCommandPayload: {
        command: "threat-intel-brief",
        arguments: "8.8.8.8 include confidence",
        resume: true,
      },
    })
    const commandPayload = v2Commands[0]?.sessionCommandPayload
    if (!commandPayload || typeof commandPayload !== "object" || !("id" in commandPayload)) {
      throw new Error("Expected a durable command message ID")
    }
    if (typeof commandPayload.id !== "string") throw new Error("Expected a string command message ID")
    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        id: commandPayload.id,
      },
      parts: [{ type: "text", text: "/threat-intel-brief 8.8.8.8 include confidence" }],
    })
    expect(extensionLists).toHaveLength(0)
    commandGate.resolve()
    await submitted
  })

  test("uses the caller-stable message ID for a queued custom-command retry", async () => {
    v2CommandErrors.push(
      Object.assign(new Error("UnexpectedStatus"), {
        reason: "UnexpectedStatus",
        cause: { status: 503 },
      }),
    )
    const statuses: string[] = []
    const optimisticCalls: string[] = []
    const client = clientFor("/repo/followup")
    const input = {
      scope: ServerScope.local,
      admission: admissionForTest(),
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      serverSync: {
        session: {
          set: (_key: string, _sessionID: string, value: { type: string }) => statuses.push(value.type),
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
      sync: {
        data: { command: [{ name: "review" }], session_working: () => false },
        session: {
          optimistic: {
            add: () => optimisticCalls.push("add"),
            remove: () => optimisticCalls.push("remove"),
          },
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
      draft: {
        sessionID: "session-followup",
        sessionDirectory: "/repo/followup",
        prompt: [
          { type: "text", content: "/review queued", start: 0, end: 14 },
          { type: "file", path: "src/input.ts", content: "@src/input.ts", start: 14, end: 27 },
        ],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
      messageID: "msg_followup_retry",
      optimisticBusy: true,
      command: { name: "review", arguments: "queued" },
    } satisfies Parameters<typeof sendFollowupDraft>[0]

    expect(await sendFollowupDraft(input)).toBe(true)
    expect(v2Commands).toHaveLength(2)
    expect(v2Commands[1]).toBe(v2Commands[0])
    expect(v2Commands[0]).toMatchObject({
      sessionID: "session-followup",
      sessionCommandPayload: {
        id: "msg_followup_retry",
        command: "review",
        arguments: "queued",
        files: [
          {
            uri: "file:///repo/followup/src/input.ts",
            name: "input.ts",
          },
        ],
      },
    })
    expect(statuses).toEqual(["busy"])
    expect(optimisticCalls).toEqual(["add"])
  })

  test("retries an ambiguous normal prompt once with the identical caller-stable payload", async () => {
    v2PromptErrors.push(new TypeError("Failed to fetch"))
    const statuses: string[] = []
    const optimistic: string[] = []

    expect(await sendFollowupDraft(followupPromptInput("msg_prompt_retry", optimistic, statuses))).toBe(true)
    expect(v2PromptPayloads).toHaveLength(2)
    expect(v2PromptPayloads[1]).toBe(v2PromptPayloads[0])
    expect(v2PromptPayloads[0]).toMatchObject({
      id: "msg_prompt_retry",
      sessionID: "session-followup",
      prompt: { text: "Continue" },
      delivery: "steer",
      agent: "agent",
      model: { providerID: "provider", id: "model" },
      resume: true,
    })
    expect(statuses).toEqual(["busy"])
    expect(optimistic).toEqual(["add"])
  })

  // Regression: a server restart keeps failing mutations for longer than one immediate retry.
  // Bailing out there removes the optimistic message and restores the composer, so a prompt the
  // server already admitted reads as dropped -- and the user's re-send mints a fresh message ID
  // that the server's ID-keyed idempotency cannot collapse, persisting a duplicate user message.
  test("re-sends the identical payload across a restart window instead of reporting a false failure", async () => {
    v2PromptErrors.push(new TypeError("Failed to fetch"))
    v2PromptErrors.push(new TypeError("Failed to fetch"))
    v2PromptErrors.push(new TypeError("Failed to fetch"))
    const optimisticCalls: string[] = []

    expect(await sendFollowupDraft(followupPromptInput("msg_prompt_restart", optimisticCalls))).toBe(true)
    expect(v2PromptPayloads).toHaveLength(4)
    // Every attempt carries the caller-stable ID, so a landed attempt re-admits idempotently.
    expect(new Set(v2PromptPayloads.map((payload) => payload.id))).toEqual(new Set(["msg_prompt_restart"]))
    // The optimistic message is never withdrawn, so the composer is never restored and the
    // user is never prompted to re-send under a new ID.
    expect(optimisticCalls).toEqual(["add"])
  })

  test("keeps the stable optimistic prompt when retry exhaustion resolves to a pending admission", async () => {
    v2PromptErrors.push(
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
    )
    pendingInputIDs.push("msg_prompt_pending")
    const statuses: string[] = []
    const optimisticCalls: string[] = []

    const input = followupPromptInput("msg_prompt_pending", optimisticCalls, statuses)
    expect(await sendFollowupDraft(input)).toBe("unknown")
    expect(await input.admission.check(input.scope, input.draft.sessionID, input.messageID, input.client)).toBe(
      "pending",
    )
    expect(v2PromptPayloads).toHaveLength(4)
    expect(new Set(v2PromptPayloads.map((payload) => payload.id))).toEqual(new Set(["msg_prompt_pending"]))
    expect(v2PendingInputReads).toEqual(["session-followup"])
    expect(v2MessageReads).toEqual([])
    expect(statuses).toEqual(["busy", "idle"])
    expect(optimisticCalls).toEqual(["add"])
  })

  test("retains exact retry identity when a missing read can precede a late commit", async () => {
    v2PromptErrors.push(
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
      new TypeError("Failed to fetch"),
    )
    const statuses: string[] = []
    const optimisticCalls: string[] = []

    const input = followupPromptInput("msg_prompt_failed", optimisticCalls, statuses)
    expect(await sendFollowupDraft(input)).toBe("unknown")
    expect(await input.admission.check(input.scope, input.draft.sessionID, input.messageID, input.client)).toBe(
      "missing",
    )
    expect(input.admission.get(input.scope, input.draft.sessionID, input.messageID)?.payload.id).toBe(input.messageID)
    expect(v2PromptPayloads).toHaveLength(4)
    expect(new Set(v2PromptPayloads.map((payload) => payload.id))).toEqual(new Set(["msg_prompt_failed"]))
    expect(v2PendingInputReads).toEqual(["session-followup"])
    expect(v2MessageReads).toEqual(["msg_prompt_failed"])
    expect(statuses).toEqual(["busy", "idle"])
    expect(optimisticCalls).toEqual(["add"])
  })

  test("reads pending, projected, and failed prompt admission outcomes authoritatively", async () => {
    const client = clientFor("/repo/followup") as unknown as Parameters<typeof readPromptAdmission>[0]

    pendingInputIDs.push("msg_pending")
    expect(await readPromptAdmission(client, "session-followup", "msg_pending")).toBe("pending")

    pendingInputIDs.length = 0
    projectedMessageIDs.add("msg_projected")
    expect(await readPromptAdmission(client, "session-followup", "msg_projected")).toBe("projected")

    expect(await readPromptAdmission(client, "session-followup", "msg_missing")).toBe("failed")

    v2PendingInputErrors.push(new TypeError("Failed to fetch"))
    expect(await readPromptAdmission(client, "session-followup", "msg_pending_unknown")).toBeUndefined()

    v2MessageErrors.push(new TypeError("Failed to fetch"))
    expect(await readPromptAdmission(client, "session-followup", "msg_projected_unknown")).toBeUndefined()

    v2PendingInputErrors.push(Object.assign(new Error("Session not found"), { status: 404 }))
    expect(await readPromptAdmission(client, "session-followup", "msg_session_missing")).toBe("failed")
    expect(v2PendingInputReads).toEqual([
      "session-followup",
      "session-followup",
      "session-followup",
      "session-followup",
      "session-followup",
      "session-followup",
    ])
    expect(v2MessageReads).toEqual([
      "msg_projected",
      "msg_missing",
      "msg_pending_unknown",
      "msg_projected_unknown",
      "msg_session_missing",
    ])
  })

  test("reconciles prompt admission from durable input status by stable ID", async () => {
    const client = clientFor("/repo/followup") as unknown as Parameters<typeof readPromptAdmission>[0]
    inputStatuses.set("msg_status_admitted", "admitted")
    inputStatuses.set("msg_status_promoted", "promoted")
    inputStatuses.set("msg_status_cancelled", "cancelled")

    expect(await readPromptAdmission(client, "session-followup", "msg_status_admitted")).toBe("pending")
    expect(await readPromptAdmission(client, "session-followup", "msg_status_promoted")).toBe("projected")
    expect(await readPromptAdmission(client, "session-followup", "msg_status_cancelled")).toBe("failed")
    expect(v2InputStatusReads).toEqual(["msg_status_admitted", "msg_status_promoted", "msg_status_cancelled"])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    sdkScope = "remote-project"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
    expect(activationStarts).toHaveLength(1)
    expect(activationStarts[0]).toMatchObject({
      scope: "remote-project",
      sessionID: "session-1",
      draftID: "draft-1",
    })
  })

  test("retargets the captured submission before draft promotion removes its persistence", async () => {
    search = { draftId: "draft-1" }
    promptContextItems.push({ key: "file:src/input.ts", type: "file", path: "src/input.ts" })
    const sessionTarget = {
      ...prompt,
      context: {
        ...prompt.context,
        add: () => promotionOperations.push("retarget"),
      },
    }
    capturePrompt = (scope) => {
      if (!scope) return prompt
      promotionOperations.push("capture")
      return sessionTarget
    }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotionOperations.slice(0, 3)).toEqual(["capture", "retarget", "promote"])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([
      expect.objectContaining({ id: "session-1", title: "New session 1" }),
    ])
    expect(optimisticSeeded).toEqual([true])
  })

  test("edits an unfinished goal without admitting a second visible prompt", async () => {
    params = { id: "session-1" }
    const current = sessionGoal({ status: "active" })
    const mutations: string[] = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      goal: goalControls(current, mutations),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(mutations).toEqual(["edit"])
    expect(v2Prompts).toEqual([])
  })

  test("starts a new atomic goal after the completed goal", async () => {
    params = { id: "session-1" }
    const mutations: string[] = []
    const starts: Array<Record<string, unknown>> = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      goal: goalControls(sessionGoal({ status: "complete" }), mutations, starts),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(mutations).toEqual(["start"])
    expect(starts).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        objective: "ls",
        agent: "agent",
        model: { providerID: "provider", id: "model" },
      }),
    ])
    expect(v2Prompts).toEqual([])
    expect(v2Gets).toEqual([])
    expect(v2AgentSwitches).toEqual([])
    expect(v2ModelSwitches).toEqual([])
  })

  test("acknowledges a new goal before durable admission completes", async () => {
    params = { id: "session-1" }
    promptValue[0] = { type: "text", content: "/goal Ship the release", start: 0, end: 22 }
    const mutations: string[] = []
    const starts: Array<Record<string, unknown>> = []
    const gate = Promise.withResolvers<void>()
    const callbacks: string[] = []
    const pending: Prompt[] = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 22,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      goal: goalControls(undefined, mutations, starts, undefined, gate.promise),
      onSubmit: () => callbacks.push("submit"),
      onPendingPrompt: (value) => {
        if (value) pending.push(value)
      },
    })

    const admission = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    while (starts.length === 0) await Bun.sleep(1)

    expect(callbacks).toEqual(["submit"])
    expect(resetCount).toBe(1)
    expect(pending).toEqual([[{ type: "text", content: "Ship the release", start: 0, end: 16 }]])

    gate.resolve()
    await admission
  })

  test("keeps a second goal draft while admission is pending", async () => {
    params = { id: "session-1" }
    const mutations: string[] = []
    const goal = goalControls(undefined, mutations)
    goal.pending = () => true
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      goal,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(mutations).toEqual([])
    expect(resetCount).toBe(0)
  })

  test("keeps the entire goal draft when objective-only admission has attachments", async () => {
    params = { id: "session-1" }
    const mutations: string[] = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [
        {
          type: "image",
          id: "image-1",
          filename: "proof.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,AA==",
        },
      ],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      goal: goalControls(undefined, mutations),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(mutations).toEqual([])
    expect(resetCount).toBe(0)
  })

  test("persists the goal pause before interrupting V2 execution", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: async () => {
        abortOrder.push("pause")
      },
    })

    await submit.abort()

    expect(abortOrder).toEqual(["pause", "interrupt"])
  })

  test("keeps task state and reports a failed Stop so it can be retried", async () => {
    params = { id: "session-1" }
    const submit = stopControls()
    interruptErrors.push(new Error("Server unreachable"))
    await submit.abort()
    expect(todoWrites).toEqual([])
    expect(submit.interrupting()).toBe(false)
    expect(toasts).toContainEqual({ title: "session.interrupt.error", description: "Server unreachable" })
    await submit.abort()
    expect(interrupted).toHaveLength(2)
    expect(todoWrites).toEqual([])
  })

  test("coalesces Stop requests and keeps task state until acknowledgement", async () => {
    params = { id: "session-1" }
    const gate = Promise.withResolvers<void>()
    interruptGate = gate.promise
    const submit = stopControls()
    const first = submit.abort()
    expect(submit.interrupting()).toBe(true)
    expect(submit.abort()).toBe(first)
    await Promise.resolve()
    expect(interrupted).toHaveLength(1)
    expect(todoWrites).toEqual([])
    await submit.handleSubmit({ preventDefault: () => undefined } as Event, true)
    expect(v2Prompts).toEqual([])
    gate.resolve()
    await first
    expect(submit.interrupting()).toBe(false)
    expect(todoWrites).toEqual([])
  })

  test("Stop remains on its captured server and session while a goal pause waits", async () => {
    params = { id: "session-1" }
    const gate = Promise.withResolvers<void>()
    const submit = stopControls(() => gate.promise)
    const stopping = submit.abort()
    params.id = "session-2"
    sdkScope = "other-server"
    selectedClient = clientFor("/other/server")
    expect(submit.interrupting()).toBe(false)
    gate.resolve()
    await stopping
    expect(interrupted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
    expect(todoWrites).toEqual([])
  })

  test("a failed goal pause leaves task state intact and does not interrupt", async () => {
    params = { id: "session-1" }
    const submit = stopControls(() => Promise.reject(new Error("Goal pause failed")))
    await submit.abort()
    expect(interrupted).toEqual([])
    expect(todoWrites).toEqual([])
    expect(submit.interrupting()).toBe(false)
    expect(toasts).toContainEqual({ title: "session.interrupt.error", description: "Goal pause failed" })
  })

  test("preserves a goal draft and surfaces an actionable transcript-adoption error", async () => {
    params = { id: "session-1" }
    const failure = {
      data: {
        kind: "session_transcript_adoption",
        message: "Legacy message ID is incompatible with Session V2: old-message",
      },
    }
    const mutations: string[] = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      goal: goalControls(undefined, mutations, undefined, failure),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(mutations).toEqual([])
    expect(resetCount).toBe(1)
    expect(restoredPrompts).toEqual([promptValue])
    expect(toasts.at(-1)).toEqual({
      title: "session.error.transcriptAdoption",
      description: "Legacy message ID is incompatible with Session V2: old-message",
    })
  })

  const busySubmit = () =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
    })

  test("queues a follow-up sent while the agent is working", async () => {
    params = { id: "session-1" }
    await busySubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(v2PromptPayloads).toHaveLength(1)
    expect(v2PromptPayloads[0]).toMatchObject({ sessionID: "session-1", delivery: "queue" })
  })

  test("steers immediately when requested while the agent is working", async () => {
    params = { id: "session-1" }
    await busySubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event, true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(v2PromptPayloads).toHaveLength(1)
    expect(v2PromptPayloads[0]).toMatchObject({ sessionID: "session-1", delivery: "steer" })
  })
})

describe("/loop commands", () => {
  const submitText = async (text: string) => {
    newLayoutDesigns = true
    promptValue[0] = { type: "text", content: text, start: 0, end: text.length }
    await newDraftControls().handleSubmit(submitEvent())
  }

  test("bare /loop opens the Automations surface and enables it", async () => {
    await submitText("/loop")
    expect(automationsEnabled).toBe(true)
    expect(navigations).toEqual([`/automations?directory=${encodeURIComponent("/repo/main")}`])
  })

  test("/loop list opens the Automations surface", async () => {
    await submitText("/loop list")
    expect(navigations).toEqual([`/automations?directory=${encodeURIComponent("/repo/main")}`])
  })

  test("/loop stop pauses the project's only active loop and cancels its in-flight run", async () => {
    loops.push(
      { id: "lop_1", name: "Loop: ping", status: "active", directory: "/repo/main" },
      { id: "lop_2", name: "Loop: paused", status: "paused", directory: "/repo/main" },
      { id: "lop_3", name: "Loop: elsewhere", status: "active", directory: "/repo/other" },
    )
    loopRuns.push(
      { id: "run_1", loopID: "lop_1", status: "running" },
      { id: "run_2", loopID: "lop_1", status: "succeeded" },
    )
    await submitText("/loop stop")
    expect(pausedLoops).toEqual(["lop_1"])
    expect(cancelledLoopRuns).toEqual(["lop_1/run_1"])
    expect(toasts.at(-1)?.title).toBe("Loop stopped")
    expect(navigations).toEqual([])
  })

  test("/loop stop reports when nothing is running", async () => {
    loops.push({ id: "lop_1", name: "Loop: paused", status: "paused", directory: "/repo/main" })
    await submitText("/loop stop")
    expect(pausedLoops).toEqual([])
    expect(toasts.at(-1)?.title).toBe("No active loops")
  })

  test("/loop stop with several active loops sends the user to Automations to choose", async () => {
    loops.push(
      { id: "lop_1", name: "Loop: one", status: "active", directory: "/repo/main" },
      { id: "lop_2", name: "Loop: two", status: "active", directory: "/repo/main" },
    )
    await submitText("/loop stop")
    expect(pausedLoops).toEqual([])
    expect(toasts.at(-1)?.title).toBe("Multiple loops are running")
    expect(navigations).toEqual([`/automations?directory=${encodeURIComponent("/repo/main")}`])
  })

  test("an invalid /loop argument still shows usage", async () => {
    await submitText("/loop 5")
    expect(toasts.at(-1)?.title).toBe("Could not start loop")
    expect(navigations).toEqual([])
  })
})

function sessionGoal(input: Partial<SessionGoalInfo> = {}): SessionGoalInfo {
  return {
    id: "goal_current",
    sessionID: "session-1",
    revision: 1,
    objective: "Existing objective",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1, statusChanged: 1 },
    ...input,
  }
}

function goalControls(
  current: SessionGoalInfo | undefined,
  mutations: string[],
  starts?: Array<Record<string, unknown>>,
  startError?: unknown,
  startGate?: Promise<void>,
) {
  return {
    mode: () => true,
    current: () => current,
    pending: () => false,
    toggleMode: () => undefined,
    requestEdit: () => undefined,
    start: async (input: Record<string, unknown>) => {
      if (startError) throw startError
      mutations.push("start")
      starts?.push(input)
      await startGate
      return sessionGoal({ id: "goal_next" })
    },
    edit: async () => {
      mutations.push("edit")
      return sessionGoal({ revision: 2 })
    },
    pause: async () => sessionGoal({ status: "paused" }),
    resume: async () => sessionGoal(),
    clear: async () => undefined,
  }
}
