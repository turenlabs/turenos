import { isInternal } from "./auth"
export function canAccess(email) {
  return isInternal(email)
}
