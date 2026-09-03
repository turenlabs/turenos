import { MAX_RETRY_ATTEMPTS } from "./config.ts"
import { normalizeTenantId } from "./tenant.ts"

export interface Principal {
  readonly tenantId: string
  readonly subject: string
  readonly scopes: readonly string[]
}

export interface AuthRequest {
  readonly tenant: string
  readonly subject: string
  readonly token: string
}

const TOKEN_PATTERN = /^bw_[a-z0-9]{8,}$/

export function authenticate(request: AuthRequest): Principal {
  if (!TOKEN_PATTERN.test(request.token)) throw new Error("malformed token")
  return {
    tenantId: normalizeTenantId(request.tenant),
    subject: request.subject.trim(),
    scopes: ["records:read"],
  }
}

export function retryBudgetFor(_principal: Principal): number {
  return MAX_RETRY_ATTEMPTS
}
