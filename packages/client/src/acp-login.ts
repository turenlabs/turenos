export type AcpLoginState = {
  readonly id: string
  readonly status: "starting" | "waiting" | "authenticated" | "error" | "cancelled"
  readonly url?: string
  readonly message?: string
}

export type AcpLoginView = {
  readonly phase: "idle" | "starting" | "waiting" | "finishing" | "cancelling" | "authenticated" | "error" | "cancelled"
  readonly url?: string
  readonly error?: string
}

type Attempt = {
  readonly authorization: Promise<AcpLoginState>
  id?: string
  cancelled: boolean
  terminal: boolean
  request?: AbortController
  timer?: ReturnType<typeof setTimeout>
  cancellation?: Promise<void>
}

/** Keeps one native login attempt tied to the server that started it. */
export function createAcpLoginController(input: {
  authorize: () => Promise<AcpLoginState>
  status: (id: string, signal: AbortSignal) => Promise<AcpLoginState>
  cancel: (id: string) => Promise<unknown>
  complete: () => Promise<unknown>
  onAuthenticated: () => void
  onState: (state: AcpLoginView) => void
  failure: string
  cancellationFailure: string
}) {
  let active: Attempt | undefined
  let disposed = false

  const current = (attempt: Attempt) => !disposed && active === attempt && !attempt.cancelled
  const stop = (attempt: Attempt) => {
    if (attempt.timer !== undefined) clearTimeout(attempt.timer)
    attempt.timer = undefined
    attempt.request?.abort()
    attempt.request = undefined
  }

  const cancel = async () => {
    const attempt = active
    if (!attempt || attempt.terminal) return
    if (attempt.cancellation) return attempt.cancellation
    attempt.cancelled = true
    stop(attempt)
    if (!disposed) input.onState({ phase: "cancelling" })
    // Do not abort authorize before learning its ID: a late response still owns
    // a native process. Keep retry disabled until that attempt is cancelled.
    attempt.cancellation = (async () => {
      const result = await attempt.authorization
        .then(
          (state) => input.cancel(state.id).then(() => true),
          () => false,
        )
        .catch(() => false)
      if (active !== attempt) return
      active = undefined
      if (disposed) return
      input.onState(result ? { phase: "cancelled" } : { phase: "error", error: input.cancellationFailure })
    })()
    return attempt.cancellation
  }

  const fail = async (attempt: Attempt) => {
    if (!current(attempt)) return
    stop(attempt)
    attempt.cancelled = true
    await input.cancel(attempt.id!).catch(() => undefined)
    if (active !== attempt) return
    active = undefined
    if (!disposed) input.onState({ phase: "error", error: input.failure })
  }

  const accept = async (attempt: Attempt, state: AcpLoginState) => {
    if (!current(attempt)) return
    if (state.id !== attempt.id) return fail(attempt)
    if (state.status === "error" || state.status === "cancelled") {
      attempt.terminal = true
      stop(attempt)
      active = undefined
      input.onState(
        state.status === "cancelled"
          ? { phase: "cancelled" }
          : { phase: "error", error: state.message ?? input.failure },
      )
      return
    }
    if (state.status === "authenticated") {
      attempt.terminal = true
      stop(attempt)
      input.onState({ phase: "finishing" })
      await input.complete().then(
        () => {
          if (!current(attempt)) return
          active = undefined
          input.onState({ phase: "authenticated" })
          input.onAuthenticated()
        },
        () => {
          if (!current(attempt)) return
          active = undefined
          input.onState({ phase: "error", error: input.failure })
        },
      )
      return
    }
    const url = state.url ? googleLoginURL(state.url) : undefined
    if (state.url && !url) return fail(attempt)
    input.onState({ phase: state.status, url })
    attempt.timer = setTimeout(() => void poll(attempt), 1_000)
  }

  const poll = async (attempt: Attempt) => {
    if (!current(attempt) || !attempt.id) return
    attempt.timer = undefined
    const request = new AbortController()
    attempt.request = request
    await input.status(attempt.id, request.signal).then(
      (state) => accept(attempt, state),
      () => fail(attempt),
    )
  }

  return {
    async start() {
      if (disposed || active) return
      input.onState({ phase: "starting" })
      const attempt: Attempt = { authorization: input.authorize(), cancelled: false, terminal: false }
      active = attempt
      await attempt.authorization.then(
        (state) => {
          attempt.id = state.id
          return accept(attempt, state)
        },
        () => {
          if (!current(attempt)) return
          active = undefined
          input.onState({ phase: "error", error: input.failure })
        },
      )
    },
    cancel,
    dispose() {
      disposed = true
      if (active?.terminal) {
        stop(active)
        active = undefined
        return
      }
      void cancel()
    },
  }
}

export function googleLoginURL(value: string) {
  const url = URL.parse(value)
  if (
    !url ||
    url.protocol !== "https:" ||
    url.hostname !== "accounts.google.com" ||
    url.port ||
    url.username ||
    url.password
  )
    return
  if (url.pathname !== "/o/oauth2/v2/auth" && url.pathname !== "/o/oauth2/auth") return
  return url.href
}
