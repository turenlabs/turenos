export type FirstLaunchEligibility = {
  pending: boolean
  local: boolean
  initialUrl: string
  tabs: number
}

export function shouldShowFirstLaunchOnboarding(input: FirstLaunchEligibility) {
  return input.pending && input.local && input.initialUrl === "/" && input.tabs === 0
}

export function selectedOnboardingDirectory(value: string | string[] | null) {
  if (typeof value === "string") return value
  return value?.[0]
}
