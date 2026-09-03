import { write as writeLog } from "./logging"
import type { DesktopProductStorage } from "./storage/product"

export function createOnboarding(storage: DesktopProductStorage) {
  return {
    isOldLayoutEligible: (owner: number) => storage.isOldLayoutEligible(owner),
    async isFirstLaunchOnboardingPending(owner: number) {
      const pending = await storage.isFirstLaunchOnboardingPending(owner)
      writeLog("onboarding", "first launch onboarding pending checked", { pending })
      return pending
    },
    async finishFirstLaunchOnboarding(owner: number) {
      if (!(await storage.isFirstLaunchOnboardingPending(owner))) {
        writeLog("onboarding", "first launch onboarding already completed")
        return
      }
      await storage.finishFirstLaunchOnboarding(owner)
      writeLog("onboarding", "first launch onboarding completed")
    },
  }
}
