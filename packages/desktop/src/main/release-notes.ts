import type { DesktopProductStorage } from "./storage/product"

type Options = {
  version: string
  storage: Pick<
    DesktopProductStorage,
    "getReleaseNotesVersion" | "setReleaseNotesVersion" | "isFirstLaunchOnboardingPending" | "isOldLayoutEligible"
  >
  legacy: () => Promise<string | null>
  warn: (error: unknown) => void
}

export function createReleaseNotesCoordinator(options: Options) {
  const owner = "main/release-notes"
  let queue = Promise.resolve()
  let claimed: { id: number; cancelled: boolean } | undefined
  let disabled = false
  const pending = new Set<{ id: number; cancelled: boolean }>()
  const serialize = <T>(run: () => Promise<T>) => {
    const result = queue.then(run)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const initialize = async () => {
    if (disabled) return
    const previous = await options.storage.getReleaseNotesVersion(owner)
    if (previous) return previous
    if (!stableVersion(options.version)) return
    const legacy = legacyVersion(await options.legacy())
    const existing =
      (await options.storage.isOldLayoutEligible(owner)) ||
      !(await options.storage.isFirstLaunchOnboardingPending(owner))
    const baseline = legacy ?? (existing ? "0.0.0" : options.version)
    await options.storage.setReleaseNotesVersion(owner, baseline)
    return baseline
  }
  return {
    initialize: () => serialize(initialize).catch(failed),
    claim(id: number, enabled: boolean): Promise<{ previous: string } | null> {
      const request = { id, cancelled: false }
      pending.add(request)
      return serialize(async () => {
        const previous = await initialize()
        const current = stableVersion(options.version)
        const baseline = stableVersion(previous)
        if (request.cancelled || claimed !== undefined || !current || !baseline || !previous) return null
        const difference = current.map((part, index) => part - baseline[index]!).find((part) => part !== 0)
        if (!difference || difference < 0) return null
        if (!enabled) {
          await options.storage.setReleaseNotesVersion(owner, options.version)
          return null
        }
        claimed = request
        return { previous }
      })
        .catch((error) => {
          failed(error)
          return null
        })
        .finally(() => pending.delete(request))
    },
    shown(id: number) {
      // Capture this claim, not a later claim from a remounted provider in the same window.
      const request = claimed
      if (!request || request.id !== id) return Promise.resolve()
      return serialize(async () => {
        if (claimed !== request) return
        await options.storage.setReleaseNotesVersion(owner, options.version)
        claimed = undefined
      }).catch(failed)
    },
    release(id: number) {
      // Teardown cannot queue behind the read it needs to cancel.
      pending.forEach((request) => {
        if (request.id === id) request.cancelled = true
      })
      if (claimed?.id === id) claimed = undefined
    },
  }

  function failed(error: unknown) {
    // Stay silent for this launch; do not persist a failure or suppress the next launch.
    disabled = true
    claimed = undefined
    options.warn(error)
  }
}

function stableVersion(value: string | undefined) {
  if (!value || /\s/.test(value)) return
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return
  const parts = match.slice(1, 4).map(Number)
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

function legacyVersion(raw: string | null) {
  if (!raw) return
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || !value || !("version" in value) || typeof value.version !== "string") return
    return stableVersion(value.version) ? value.version : undefined
  } catch {
    return undefined
  }
}
