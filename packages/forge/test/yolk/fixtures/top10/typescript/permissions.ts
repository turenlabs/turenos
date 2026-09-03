import { isInternal } from "./auth"
export const canAccess = (email: string): boolean => isInternal(email)
