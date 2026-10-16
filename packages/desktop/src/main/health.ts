export async function checkHealth(url: string, password?: string | null, signal?: AbortSignal): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`forge:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const timeout = AbortSignal.timeout(3000)
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    return res.ok
  } catch {
    return false
  }
}

export async function pollHealth(
  check: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
  interval = 100,
) {
  while (!signal.aborted) {
    if (await check(signal)) return
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const done = () => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", done)
        resolve()
      }
      const timeout = setTimeout(done, interval)
      signal.addEventListener("abort", done, { once: true })
    })
  }
}
