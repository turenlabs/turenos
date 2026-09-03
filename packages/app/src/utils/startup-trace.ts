export function startupTrace(scope: string, event: string, detail: Record<string, unknown> = {}) {
  console.info(`[startup.${scope}]`, JSON.stringify({ event, atMs: Math.round(performance.now()), ...detail }))
}
