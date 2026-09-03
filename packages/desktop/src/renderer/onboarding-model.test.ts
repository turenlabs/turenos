import { expect, test } from "bun:test"
import { selectedOnboardingDirectory, shouldShowFirstLaunchOnboarding } from "./onboarding-model"

const eligible = {
  pending: true,
  local: true,
  initialUrl: "/",
  tabs: 0,
}

test("shows onboarding only for an incomplete fresh local root window", () => {
  expect(shouldShowFirstLaunchOnboarding(eligible)).toBe(true)
  for (const input of [
    { ...eligible, pending: false },
    { ...eligible, local: false },
    { ...eligible, initialUrl: "/session/1" },
    { ...eligible, tabs: 1 },
  ]) {
    expect(shouldShowFirstLaunchOnboarding(input)).toBe(false)
  }
})

test("normalizes single and multiple directory picker results", () => {
  expect(selectedOnboardingDirectory("/workspace")).toBe("/workspace")
  expect(selectedOnboardingDirectory(["/one", "/two"])).toBe("/one")
  expect(selectedOnboardingDirectory(null)).toBeUndefined()
})
