import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK, type DirectorySDK } from "@/context/sdk"

type HarnessStateResponse = Awaited<ReturnType<DirectorySDK["client"]["v2"]["session"]["harness"]["state"]>>
type HarnessState = NonNullable<HarnessStateResponse["data"]>["data"]
type HarnessProposal = HarnessState["proposals"][number]

export function createSessionHarnessController(input: { sessionID: Accessor<string | undefined> }) {
  const sdk = useSDK()
  const [store, setStore] = createStore({
    state: {} as Record<string, HarnessState | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    error: {} as Record<string, string | undefined>,
  })
  let request = 0

  const load = (sessionID: string) => {
    const current = ++request
    setStore("loading", sessionID, true)
    setStore("error", sessionID, undefined)
    return sdk()
      .client.v2.session.harness.state({ sessionID })
      .then((result) => {
        if (current !== request || input.sessionID() !== sessionID) return
        if (result.data) setStore("state", sessionID, result.data.data)
      })
      .catch((error) => {
        if (current !== request || input.sessionID() !== sessionID) return
        setStore("error", sessionID, error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (current === request && input.sessionID() === sessionID) setStore("loading", sessionID, false)
      })
  }

  createEffect(() => {
    const sessionID = input.sessionID()
    if (sessionID) void load(sessionID)
  })

  // Reviewer runs are recorded without publishing an event: the outcomes worth watching for
  // (nothing to change, failed, timed out) change no state to emit an event about. Poll instead,
  // or the activity log reads "no runs yet" indefinitely while runs accumulate in the background.
  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    const timer = setInterval(() => void load(sessionID), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const current = sdk()
    const refresh = (event: { properties: { sessionID: string } }) => {
      if (event.properties.sessionID === input.sessionID()) void load(event.properties.sessionID)
    }
    const created = current.event.on("session.next.harness.proposal.created", refresh)
    const status = current.event.on("session.next.harness.proposal.status", refresh)
    const snapshot = current.event.on("session.next.harness.snapshot.created", refresh)
    const reloaded = current.event.on("session.next.harness.reloaded", refresh)
    onCleanup(() => {
      created()
      status()
      snapshot()
      reloaded()
    })
  })

  const report = (sessionID: string, error: unknown) => {
    setStore("error", sessionID, error instanceof Error ? error.message : String(error))
  }

  const apply = (sessionID: string, proposal: HarnessProposal) =>
    sdk()
      .client.v2.session.harness.proposal2.apply({ sessionID, proposalID: proposal.id })
      .then(() => load(sessionID))
      .catch((error) => report(sessionID, error))

  const approve = (sessionID: string, proposal: HarnessProposal) =>
    sdk()
      .client.v2.session.harness.proposal2.status({
        sessionID,
        proposalID: proposal.id,
        sessionHarnessProposalStatusPayload: { status: "approved" },
      })
      .then(() => apply(sessionID, proposal))
      .catch((error) => report(sessionID, error))

  const reject = (sessionID: string, proposal: HarnessProposal) =>
    sdk()
      .client.v2.session.harness.proposal2.reject({ sessionID, proposalID: proposal.id })
      .then(() => load(sessionID))
      .catch((error) => report(sessionID, error))

  const reload = (sessionID: string, version: number) =>
    sdk()
      .client.v2.session.harness.reload({
        sessionID,
        sessionHarnessReloadPayload: { baseVersion: version },
      })
      .then(() => load(sessionID))
      .catch((error) => report(sessionID, error))

  const rollback = (sessionID: string, version: number) => {
    if (version <= 1) return Promise.resolve()
    return sdk()
      .client.v2.session.harness.rollback({
        sessionID,
        sessionHarnessRollbackPayload: { baseVersion: version, version: version - 1 },
      })
      .then(() => load(sessionID))
      .catch((error) => report(sessionID, error))
  }

  return {
    state: (sessionID: string | undefined) => (sessionID ? store.state[sessionID] : undefined),
    loading: (sessionID: string | undefined) => (sessionID ? store.loading[sessionID] === true : false),
    error: (sessionID: string | undefined) => (sessionID ? store.error[sessionID] : undefined),
    apply,
    approve,
    reject,
    reload,
    rollback,
  }
}
