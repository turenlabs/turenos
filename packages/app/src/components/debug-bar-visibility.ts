type DebugBarEnvironment = {
  disabled: boolean
}

const environment = {
  disabled: import.meta.env.VITE_DISABLE_DEBUG_BAR === "1",
}

export function shouldShowDebugBar(enabled: boolean, current = environment) {
  return !current.disabled && enabled
}
