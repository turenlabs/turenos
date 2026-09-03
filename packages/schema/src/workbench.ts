export * as Workbench from "./workbench"

import { Option, Schema, SchemaGetter } from "effect"
import { Model } from "./model"
import { Pentest } from "./pentest"
import { Provider } from "./provider"
import { PositiveInt, optional } from "./schema"

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const boundedNonEmpty = (maximum: number) => Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(maximum)))
const integerBetween = (minimum: number, maximum: number) =>
  Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum)))

export const ProfileID = boundedNonEmpty(160).annotate({ identifier: "Workbench.ProfileID" })
export type ProfileID = typeof ProfileID.Type

export const ProfileRevision = PositiveInt.annotate({ identifier: "Workbench.ProfileRevision" })
export type ProfileRevision = typeof ProfileRevision.Type

/** A model/profile choice after it has crossed the admission boundary. */
export const ModelProfileSelection = Schema.Struct({
  model: Model.Ref,
  profileID: ProfileID,
  profileRevision: ProfileRevision,
}).annotate({ identifier: "Workbench.ModelProfileSelection" })
export interface ModelProfileSelection extends Schema.Schema.Type<typeof ModelProfileSelection> {}

/** The stable provider/model spelling used by the Workbench UI forms. */
export const ModelRefText = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^/\s]+\/\S+$/), Schema.isMaxLength(512)),
).annotate({ identifier: "Workbench.ModelRefText" })
export type ModelRefText = typeof ModelRefText.Type

/** Bidirectional provider/model codec; variants stay in their separate selection field. */
export const ModelRefFromString = ModelRefText.pipe(
  Schema.decodeTo(Model.Ref, {
    decode: SchemaGetter.transform((value) => modelRefOf(value)),
    encode: SchemaGetter.transform((value) => `${value.providerID}/${value.id}`),
  }),
).annotate({ identifier: "Workbench.ModelRefFromString" })
export const decodeModelRef = Schema.decodeUnknownOption(ModelRefFromString)

export const ModelProfileSelectionInput = Schema.Struct({
  modelRef: ModelRefText,
  profileID: ProfileID,
  profileRevision: ProfileRevision,
  variant: optional(Schema.String),
}).annotate({ identifier: "Workbench.ModelProfileSelectionInput" })
export interface ModelProfileSelectionInput extends Schema.Schema.Type<typeof ModelProfileSelectionInput> {}

/** The optional spelling used by the model-facing @workbench start tools. */
export const ToolModelProfileSelectionInput = Schema.Struct({
  model: optional(Model.Ref),
  profile_id: optional(ProfileID),
  profile_revision: optional(ProfileRevision),
}).annotate({ identifier: "Workbench.ToolModelProfileSelectionInput" })
export interface ToolModelProfileSelectionInput extends Schema.Schema.Type<typeof ToolModelProfileSelectionInput> {}

export const PentestBudget = Pentest.TargetContract.fields.budgets
export type PentestBudget = typeof PentestBudget.Type

export const PENTEST_BUDGET_DEFAULTS: PentestBudget = {
  wallSecondsMax: 36_000,
  modelTokensMax: 2_000_000_000,
  modelCostUsdMax: 100_000,
  requestLimit: 1_000_000,
}

const INVALID_PENTEST_TARGET =
  "Invalid pentest target admission: use a credential-free absolute HTTP(S) base URL, at least one valid HTTP(S) in-scope rule, and only valid HTTP(S) out-of-scope rules; scope rules may also be root-relative"

/** Shared, bounded scope rules. */
export const Scope = Schema.Struct({
  inScope: Pentest.TargetContract.fields.inScope,
  outOfScope: Pentest.TargetContract.fields.outOfScope,
}).annotate({ identifier: "Workbench.Scope" })
export interface Scope extends Schema.Schema.Type<typeof Scope> {}

export const ScopeLines = Schema.Struct({
  inScopeLines: Schema.String,
  outOfScopeLines: Schema.String,
}).annotate({ identifier: "Workbench.ScopeLines" })
export interface ScopeLines extends Schema.Schema.Type<typeof ScopeLines> {}

export const ScopeFromLines = ScopeLines.pipe(
  Schema.decodeTo(Scope, {
    decode: SchemaGetter.transform((value) => scopeFromLines(value)),
    encode: SchemaGetter.transform((value) => ({
      inScopeLines: value.inScope.join("\n"),
      outOfScopeLines: value.outOfScope.join("\n"),
    })),
  }),
).annotate({ identifier: "Workbench.ScopeFromLines" })

export const splitScopeLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

export const splitLines = splitScopeLines

const scopeFromLinesRaw = (input: ScopeLines) => ({
  inScope: splitScopeLines(input.inScopeLines),
  outOfScope: splitScopeLines(input.outOfScopeLines),
})

export const scopeFromLines = (input: ScopeLines): Scope => Schema.decodeUnknownSync(Scope)(scopeFromLinesRaw(input))

export const scopeOf = scopeFromLines

export const decodeScopeLines = (value: unknown) => {
  const input = Schema.decodeUnknownOption(ScopeLines)(value)
  if (Option.isNone(input)) return Option.none<Scope>()
  return Schema.decodeUnknownOption(Scope)(scopeFromLinesRaw(input.value))
}

export const modelRefFromString = (value: unknown): Model.Ref | undefined => {
  const text = Schema.decodeUnknownOption(ModelRefText)(value)
  if (Option.isNone(text)) return undefined
  const separator = text.value.indexOf("/")
  return Model.Ref.make({
    providerID: Provider.ID.make(text.value.slice(0, separator)),
    id: Model.ID.make(text.value.slice(separator + 1)),
  })
}

export const modelRefOf = (value: string): Model.Ref => {
  const model = modelRefFromString(value)
  if (model) return model
  throw new Error("Workbench model references must use the provider/model form")
}

export const encodeModelRef = (model: Model.Ref): ModelRefText => `${model.providerID}/${model.id}`

export const modelProfileSelectionOf = (input: ModelProfileSelectionInput): ModelProfileSelection => ({
  model: {
    ...modelRefOf(input.modelRef),
    ...(input.variant === undefined ? {} : { variant: Model.VariantID.make(input.variant) }),
  },
  profileID: input.profileID,
  profileRevision: input.profileRevision,
})

export const decodeModelProfileSelection = (value: unknown) => {
  const input = Schema.decodeUnknownOption(ModelProfileSelectionInput)(value)
  if (Option.isNone(input)) return Option.none<ModelProfileSelection>()
  return Option.some(modelProfileSelectionOf(input.value))
}

export const encodeModelProfileSelection = (selection: ModelProfileSelection): ModelProfileSelectionInput => ({
  modelRef: encodeModelRef(selection.model),
  profileID: selection.profileID,
  profileRevision: selection.profileRevision,
  ...(selection.model.variant === undefined ? {} : { variant: selection.model.variant }),
})

export const PentestTargetInput = Schema.Struct({
  label: Pentest.TargetContract.fields.label,
  baseURL: Pentest.TargetContract.fields.baseURL,
  mode: Pentest.RunMode,
  sourceDir: Pentest.TargetContract.fields.sourceDir,
  authProfiles: Pentest.TargetContract.fields.authProfiles,
  inScope: Scope.fields.inScope,
  outOfScope: Scope.fields.outOfScope,
  networkPolicy: Pentest.NetworkPolicy,
  budgets: PentestBudget,
  authorizationNote: Pentest.TargetContract.fields.authorization.fields.note,
  recordedAt: Pentest.TargetContract.fields.authorization.fields.recordedAt,
}).annotate({ identifier: "Workbench.PentestTargetInput" })
export interface PentestTargetInput extends Schema.Schema.Type<typeof PentestTargetInput> {}

export const PentestAdmissionInput = Schema.Struct({
  label: Pentest.TargetContract.fields.label,
  baseURL: Pentest.TargetContract.fields.baseURL,
  mode: Pentest.RunMode,
  sourceDir: optional(bounded(2_048)),
  authProfiles: Pentest.TargetContract.fields.authProfiles,
  inScopeLines: Schema.String,
  outOfScopeLines: Schema.String,
  network: Pentest.NetworkPolicy,
  wallSecondsMax: PentestBudget.fields.wallSecondsMax,
  modelTokensMax: PentestBudget.fields.modelTokensMax,
  modelCostUsdMax: PentestBudget.fields.modelCostUsdMax,
  requestLimit: PentestBudget.fields.requestLimit,
  authorizationNote: Pentest.TargetContract.fields.authorization.fields.note,
  recordedAt: Pentest.TargetContract.fields.authorization.fields.recordedAt,
}).annotate({ identifier: "Workbench.PentestAdmissionInput" })
export interface PentestAdmissionInput extends Schema.Schema.Type<typeof PentestAdmissionInput> {}
export const PentestAdmission = PentestAdmissionInput
export type PentestAdmission = PentestAdmissionInput

/** The snake-case spelling exposed by the model-facing @workbench pentest tool. */
export const ToolPentestAuthProfile = Schema.Struct({
  id: Pentest.TargetAuthProfile.fields.id,
  label: Pentest.TargetAuthProfile.fields.label,
  credential_id: Pentest.TargetAuthProfile.fields.credentialID,
  type: Pentest.TargetAuthProfile.fields.type,
  header_name: Pentest.TargetAuthProfile.fields.headerName,
}).annotate({ identifier: "Workbench.ToolPentestAuthProfile" })

export const ToolPentestAdmissionInput = Schema.Struct({
  label: Pentest.TargetContract.fields.label,
  base_url: Pentest.TargetContract.fields.baseURL,
  mode: Pentest.RunMode,
  source_dir: optional(bounded(2_048)),
  auth_profiles: optional(Schema.Array(ToolPentestAuthProfile).pipe(Schema.check(Schema.isMaxLength(20)))),
  in_scope: Schema.NonEmptyArray(bounded(512)).pipe(Schema.check(Schema.isMaxLength(200))),
  out_of_scope: optional(Schema.Array(bounded(512)).pipe(Schema.check(Schema.isMaxLength(200)))),
  authorization_note: Pentest.TargetContract.fields.authorization.fields.note,
  network_policy: Pentest.NetworkPolicy,
  name: optional(bounded(80)),
}).annotate({ identifier: "Workbench.ToolPentestAdmissionInput" })
export interface ToolPentestAdmissionInput extends Schema.Schema.Type<typeof ToolPentestAdmissionInput> {}

export const pentestAdmissionFromToolInput = (
  value: ToolPentestAdmissionInput,
  budgets: PentestBudget = PENTEST_BUDGET_DEFAULTS,
): PentestAdmissionInput => {
  const scope = canonicalPentestScope(value.base_url, value.in_scope, value.out_of_scope ?? [])
  if (!scope) {
    throw new Error(INVALID_PENTEST_TARGET)
  }
  return {
    label: value.label,
    baseURL: scope.baseURL,
    mode: value.mode,
    ...(value.source_dir?.trim() ? { sourceDir: value.source_dir.trim() } : {}),
    ...(value.auth_profiles
      ? {
          authProfiles: value.auth_profiles.map((profile) => ({
            id: profile.id,
            label: profile.label,
            credentialID: profile.credential_id,
            type: profile.type,
            ...(profile.header_name ? { headerName: profile.header_name } : {}),
          })),
        }
      : {}),
    inScopeLines: scope.inScope.join("\n"),
    outOfScopeLines: scope.outOfScope.join("\n"),
    network: value.network_policy,
    wallSecondsMax: budgets.wallSecondsMax,
    modelTokensMax: budgets.modelTokensMax,
    modelCostUsdMax: budgets.modelCostUsdMax,
    requestLimit: budgets.requestLimit,
    authorizationNote: value.authorization_note,
    recordedAt: Date.now(),
  }
}

export const pentestTargetFromToolInput = (value: ToolPentestAdmissionInput, budgets?: PentestBudget) =>
  buildPentestTargetFromAdmission(pentestAdmissionFromToolInput(value, budgets))

export const buildPentestTarget = (input: PentestTargetInput): Pentest.TargetContract => {
  const scope = canonicalPentestScope(input.baseURL, input.inScope, input.outOfScope)
  if (!scope) throw new Error(INVALID_PENTEST_TARGET)
  return {
    label: input.label,
    baseURL: scope.baseURL,
    mode: input.mode,
    sourceDir: input.sourceDir,
    authProfiles: input.authProfiles,
    inScope: scope.inScope,
    outOfScope: scope.outOfScope,
    networkPolicy: input.networkPolicy,
    budgets: input.budgets,
    authorization: {
      note: input.authorizationNote,
      recordedAt: input.recordedAt,
    },
  }
}

export const pentestTargetOf = buildPentestTarget

export const buildPentestTargetFromAdmission = (value: PentestAdmissionInput): Pentest.TargetContract => {
  const scope = Schema.decodeUnknownOption(Scope)(scopeFromLinesRaw(value))
  if (Option.isNone(scope)) throw new Error(INVALID_PENTEST_TARGET)
  const canonical = canonicalPentestScope(value.baseURL, scope.value.inScope, scope.value.outOfScope)
  if (!canonical) throw new Error(INVALID_PENTEST_TARGET)
  return buildPentestTarget({
    label: value.label.trim(),
    baseURL: canonical.baseURL,
    mode: value.mode,
    ...(value.sourceDir?.trim() ? { sourceDir: value.sourceDir.trim() } : {}),
    ...(value.authProfiles ? { authProfiles: value.authProfiles } : {}),
    inScope: canonical.inScope,
    outOfScope: canonical.outOfScope,
    networkPolicy: value.network,
    budgets: {
      wallSecondsMax: value.wallSecondsMax,
      modelTokensMax: value.modelTokensMax,
      modelCostUsdMax: value.modelCostUsdMax,
      requestLimit: value.requestLimit,
    },
    authorizationNote: value.authorizationNote.trim(),
    recordedAt: value.recordedAt,
  })
}

export const decodePentestAdmission = (value: unknown) => {
  const input = Schema.decodeUnknownOption(PentestAdmissionInput)(value)
  if (Option.isNone(input)) return Option.none<PentestAdmissionInput>()
  const scope = Schema.decodeUnknownOption(Scope)(scopeFromLinesRaw(input.value))
  if (Option.isNone(scope)) return Option.none<PentestAdmissionInput>()
  const canonical = canonicalPentestScope(input.value.baseURL, scope.value.inScope, scope.value.outOfScope)
  if (!canonical) return Option.none<PentestAdmissionInput>()
  const canonicalInput = {
    ...input.value,
    baseURL: canonical.baseURL,
    inScopeLines: canonical.inScope.join("\n"),
    outOfScopeLines: canonical.outOfScope.join("\n"),
  }
  return Schema.decodeUnknownOption(PentestAdmissionInput)(canonicalInput)
}

export const pentestTargetFromAdmission = (value: unknown) => {
  const normalized =
    value && typeof value === "object" && "sourceDir" in value && value.sourceDir === undefined
      ? Object.fromEntries(Object.entries(value).filter(([key, entry]) => key !== "sourceDir" || entry !== undefined))
      : value
  const input = Schema.decodeUnknownOption(PentestAdmissionInput)(normalized)
  if (Option.isNone(input)) throw new Error(INVALID_PENTEST_TARGET)
  const admission = decodePentestAdmission(input.value)
  if (Option.isNone(admission)) throw new Error(INVALID_PENTEST_TARGET)
  return buildPentestTargetFromAdmission(admission.value)
}

function canonicalPentestScope(baseURL: string, inScope: readonly string[], outOfScope: readonly string[]) {
  if (inScope.length === 0 || inScope.length > 200 || outOfScope.length > 200) return
  const canonicalBaseURL = canonicalPentestURL(baseURL, undefined, 2_048)
  if (!canonicalBaseURL) return
  const origin = URL.parse(canonicalBaseURL)?.origin
  if (!origin) return
  const canonicalInScope = inScope.map((rule) => canonicalPentestURL(rule, origin, 512))
  const canonicalOutOfScope = outOfScope.map((rule) => canonicalPentestURL(rule, origin, 512))
  if (canonicalInScope.some((rule) => rule === undefined) || canonicalOutOfScope.some((rule) => rule === undefined)) {
    return
  }
  const validInScope = canonicalInScope as string[]
  const validOutOfScope = canonicalOutOfScope as string[]
  const [firstInScope, ...remainingInScope] = validInScope
  if (!firstInScope) return
  if (validInScope.some((rule) => rule.length > 512) || validOutOfScope.some((rule) => rule.length > 512)) return
  return {
    baseURL: canonicalBaseURL,
    inScope: [firstInScope, ...remainingInScope] as [string, ...string[]],
    outOfScope: validOutOfScope,
  }
}

function canonicalPentestURL(value: string, baseOrigin: string | undefined, maximum: number) {
  if (value.length > maximum) return
  const text = value.trim()
  if (!text || /[\u0000-\u0020\u007f\\]/.test(text)) return
  const absolute = /^https?:\/\//i.test(text)
  const rootRelative = baseOrigin !== undefined && text.startsWith("/") && !text.startsWith("//")
  if (baseOrigin === undefined ? !absolute : !absolute && !rootRelative) return
  if (
    absolute &&
    text
      .slice(text.indexOf("://") + 3)
      .split(/[/?#]/)[0]
      ?.includes("@")
  )
    return
  const parsed = URL.parse(text, rootRelative ? `${baseOrigin}/` : undefined)
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return
  if (!parsed.hostname || !isValidPentestHostname(parsed.hostname)) return
  if (parsed.username || parsed.password || (rootRelative && parsed.origin !== baseOrigin)) {
    return
  }
  try {
    decodeURI(text)
    const path = decodeURIComponent(parsed.pathname)
    if (path.startsWith("//") || /[\u0000-\u001f\u007f\\?#]/.test(path)) return
    const canonicalPath = URL.parse(
      path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/"),
      `${parsed.origin}/`,
    )
    if (!canonicalPath || canonicalPath.origin !== parsed.origin) return
    parsed.pathname = canonicalPath.pathname
    if (parsed.search) {
      const entries = [...parsed.searchParams.entries()]
      parsed.search = ""
      entries.forEach(([key, entry]) => parsed.searchParams.append(key, entry))
    }
  } catch {
    return
  }
  parsed.hash = ""
  const canonical = parsed.toString()
  if (canonical.length > maximum) return
  return /^https?:\/\/[^/?#]+$/i.test(text) && parsed.pathname === "/" ? parsed.origin : canonical
}

function isValidPentestHostname(hostname: string) {
  if (hostname.includes(":")) return true
  if (hostname.length > 253) return false
  return hostname
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9-]+$/i.test(label) &&
        !label.startsWith("-") &&
        !label.endsWith("-"),
    )
}

export type TargetOfInput = {
  readonly label: string
  readonly baseURL: string
  readonly mode: Pentest.RunMode
  readonly inScope: readonly [string, ...string[]]
  readonly outOfScope?: readonly string[]
  readonly authorizationNote: string
  readonly networkPolicy: Pentest.NetworkPolicy
  readonly sourceDir?: string
  readonly budgets?: PentestBudget
  readonly recordedAt?: number
}

/** Compatibility builder for the existing @workbench targetOf call shape. */
export const targetOf = (input: TargetOfInput): Pentest.TargetContract =>
  buildPentestTarget({
    label: input.label,
    baseURL: input.baseURL,
    mode: input.mode,
    sourceDir: input.sourceDir,
    inScope: input.inScope,
    outOfScope: input.outOfScope ?? [],
    networkPolicy: input.networkPolicy,
    budgets: input.budgets ?? PENTEST_BUDGET_DEFAULTS,
    authorizationNote: input.authorizationNote,
    recordedAt: input.recordedAt ?? Date.now(),
  })
