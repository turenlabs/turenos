import { array, isRecord, object, string } from "../response-validation"
import type { Extension, Field } from "./types"

// Catalog ids are namespaced (`turenlabs/scorecard`), so `/` is allowed; a leading letter or digit rules out `.` and `..`,
// which `new URL` would resolve out of the `/extension/<id>` route.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/

export function extensionList(value: unknown): Extension[] {
  return array(value, 2048)
    .map((value) => {
      const item = object(value)
      const manifest = object(item.manifest)
      const flags = (value: unknown) =>
        isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, set]) => [key, set === true])) : {}
      return {
        id: string(manifest.id, 256),
        name: string(manifest.name, 512),
        description: typeof manifest.description === "string" ? manifest.description : "",
        enabled: item.enabled === true,
        mutable: item.mutable === true,
        status: string(item.status, 32),
        detail: typeof item.detail === "string" ? item.detail : undefined,
        secretsSet: flags(item.secretsSet),
        configurationSet: flags(item.configurationSet),
        contributions: array(manifest.contributions, 256).map((value) => {
          const contribution = object(value)
          return {
            type: string(contribution.type, 32),
            id: string(contribution.id, 256),
            name: typeof contribution.name === "string" ? contribution.name : string(contribution.id, 256),
            description: typeof contribution.description === "string" ? contribution.description : "",
            secrets: fields(contribution.secrets),
            configuration: fields(contribution.configuration),
            authentication: typeof contribution.authentication === "string" ? contribution.authentication : undefined,
          }
        }),
      }
    })
    .filter((item) => SAFE_ID.test(item.id))
}

function fields(value: unknown): Field[] {
  if (value === undefined) return []
  return array(value, 64).map((value) => {
    const field = object(value)
    return { id: string(field.id, 256), label: string(field.label, 512), required: field.required === true }
  })
}
