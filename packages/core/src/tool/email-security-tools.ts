export * as EmailSecurityTools from "./email-security-tools"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { lookup } from "mime-types"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { NonNegativeInt, PositiveInt } from "../schema"
import { read } from "./binary-file"
import { EmailSecurityRuntime } from "./email-security-runtime"
import type { Result } from "./email-security-runtime"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const MAX_ATTACHMENT_COUNT = 256
const MAX_LINKS = 128
const DEFAULT_MAX_LINKS = 64
const MAX_LINK_CANDIDATES = 1_024
const MAX_REPORT_CHARS = 48 * 1024
const MAX_MODEL_OUTPUT_CHARS = 32 * 1024
const MAX_FIELD_CHARS = 2_048
const MAX_DISPLAY_CHARS = 512
const MAX_WARNING_CHARS = 512
const ATTACHMENT_EXTRACTION_UNAVAILABLE =
  "Attachment byte extraction is unavailable from the bounded email-security WASM API; no attachment bytes were returned or analyzed."
const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/x-download",
  "application/unknown",
  "binary/octet-stream",
])

const Input = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "RFC 5322/MIME email file to inspect." }),
  includeBodies: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include bounded decoded text and HTML body previews. Defaults to false.",
  }),
  maxIocs: PositiveInt.check(Schema.isLessThanOrEqualTo(2048)).pipe(Schema.optional).annotate({
    description: "Maximum indicators to return. Defaults to 2048.",
  }),
})
const Output = Schema.Struct({ path: Schema.String, report: Schema.String })
const HtmlOutput = Schema.Struct({ path: Schema.String, html: Schema.String, truncated: Schema.Boolean })
const AttachmentInput = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "RFC 5322/MIME email file containing the attachment." }),
  attachmentIndex: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_ATTACHMENT_COUNT - 1))
    .pipe(Schema.optional)
    .annotate({
    description: "Zero-based attachment index. Combine with attachmentName only when both identify the same attachment.",
  }),
  attachmentName: Schema.NonEmptyString.pipe(Schema.optional).annotate({
    description: "Exact attachment filename. It must identify one attachment when used without attachmentIndex.",
  }),
  allAttachments: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Explicitly return bounded metadata for every attachment; attachment bytes are never returned.",
  }),
  maxAttachments: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ATTACHMENT_COUNT))
    .pipe(Schema.optional)
    .annotate({
      description: `Maximum attachment metadata records in explicit allAttachments mode. Defaults to ${MAX_ATTACHMENT_COUNT}.`,
    }),
})
const LinkInput = Schema.Struct({
  path: Schema.NonEmptyString.annotate({ description: "RFC 5322/MIME email file to analyze for deceptive links." }),
  maxLinks: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LINKS))
    .pipe(Schema.optional)
    .annotate({ description: `Maximum link findings to return. Defaults to ${DEFAULT_MAX_LINKS}.` }),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* EmailSecurityRuntime.Service

    yield* tools
      .register({
        email_inspect: Tool.make({
          description:
            "Inspect one RFC 5322/MIME email with the bundled WebAssembly parser. Returns decoded headers, addresses, attachment metadata, bounded IOCs, and advertised authentication failures as unverified evidence. The message is never sent, executed, or dereferenced over the network.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: boundedModelOutput(output.report) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "email_inspect", context, mutation, fs, permission)
              const result = yield* runtime
                .inspect({
                  bytes: file.bytes,
                  includeBodies: input.includeBodies ?? false,
                  includeAttachmentData: false,
                  maxIocs: input.maxIocs ?? 2048,
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to inspect ${input.path}: ${error.message}` })))
              return { path: file.resource, report: serializeReport({ path: file.resource, ...result }) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to inspect ${input.path}` }),
              ),
            ),
        }),
        email_attachment_inspect: Tool.make({
          description:
            "Inspect one explicitly selected MIME attachment's bounded metadata, or explicitly list all bounded attachment metadata. Attachment bytes are never returned; byte extraction is unavailable from the current email-security WASM API, so binary and YARA analysis are not attempted here.",
          input: AttachmentInput,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: boundedModelOutput(output.report) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "email_attachment_inspect", context, mutation, fs, permission)
              const inspected = yield* runtime
                .inspect({ bytes: file.bytes, includeBodies: false, includeAttachmentData: false, maxIocs: 0 })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to inspect attachments in ${input.path}: ${error.message}` }),
                  ),
                )
              const attachments = inspected.attachments.slice(0, MAX_ATTACHMENT_COUNT).map(normalizeAttachment)
              const selection = selectAttachment(input, attachments)
              if (selection.type === "error") return yield* new ToolFailure({ message: selection.message })
              const truncated = inspected.truncated || attachments.length < inspected.attachments.length
              const report =
                selection.type === "one"
                  ? serializeAttachmentReport({
                      path: file.resource,
                      selection: { mode: "one", index: selection.attachment.index },
                      attachment: selection.attachment,
                      attachments: [],
                      warnings: boundedWarnings(inspected.warnings),
                      truncated,
                    })
                  : serializeAttachmentReport({
                      path: file.resource,
                      selection: { mode: "all", status: "metadata_only" },
                      attachments: attachments.slice(0, input.maxAttachments ?? MAX_ATTACHMENT_COUNT),
                      warnings: boundedWarnings(inspected.warnings),
                      truncated:
                        truncated || attachments.length > (input.maxAttachments ?? MAX_ATTACHMENT_COUNT),
                    })
              return { path: file.resource, report }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to inspect attachments in ${input.path}` }),
              ),
            ),
        }),
        email_link_analyze: Tool.make({
          description:
            "Analyze bounded links from decoded email bodies and IOCs for URL scheme, host, IP literal, userinfo, suspicious path extensions, and display-vs-target indicators. This is deterministic evidence only and does not fetch URLs or verify DKIM, SPF, or DMARC cryptographically.",
          input: LinkInput,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: boundedModelOutput(output.report) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "email_link_analyze", context, mutation, fs, permission)
              const inspected = yield* runtime
                .inspect({ bytes: file.bytes, includeBodies: true, includeAttachmentData: false, maxIocs: MAX_LINK_CANDIDATES })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to inspect links in ${input.path}: ${error.message}` }),
                  ),
                )
              const candidates = collectLinkCandidates(inspected)
              const maxLinks = input.maxLinks ?? DEFAULT_MAX_LINKS
              const findings = candidates.values.slice(0, maxLinks).map(analyzeLink)
              return {
                path: file.resource,
                report: serializeLinkReport({
                  path: file.resource,
                  links: findings,
                  warnings: boundedWarnings(inspected.warnings),
                  truncated:
                    inspected.truncated || candidates.truncated || candidates.values.length > maxLinks,
                }),
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to inspect links in ${input.path}` }),
              ),
            ),
        }),
        email_sanitize_html: Tool.make({
          description:
            "Sanitize the first HTML body in one RFC 5322/MIME email with the bundled WebAssembly allowlist sanitizer. Scripts, forms, event handlers, and unsafe URL schemes are removed; the message is never sent or fetched.",
          input: Schema.Struct({
            path: Schema.NonEmptyString.annotate({ description: "RFC 5322/MIME email file to sanitize." }),
          }),
          output: HtmlOutput,
          toModelOutput: ({ output }) => [
            { type: "text", text: boundedModelOutput(`${output.html}${output.truncated ? "\n[output truncated]" : ""}`) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const file = yield* read(input.path, "email_sanitize_html", context, mutation, fs, permission)
              const inspected = yield* runtime
                .inspect({ bytes: file.bytes, includeBodies: true, includeAttachmentData: false, maxIocs: 0 })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to inspect ${input.path}: ${error.message}` })))
              const body = inspected.bodies.find((item) => item.content_type === "text/html")
              if (!body) return yield* new ToolFailure({ message: `${input.path} has no HTML body` })
              const sanitized = yield* runtime
                .sanitizeHtml(body.value)
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to sanitize ${input.path}: ${error.message}` })))
              const html = boundedString(sanitized.html, MAX_REPORT_CHARS)
              return {
                path: file.resource,
                html,
                truncated: sanitized.truncated || inspected.truncated || html.length < sanitized.html.length,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to sanitize ${input.path}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/email-security",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, EmailSecurityRuntime.node],
})

type AttachmentInputType = typeof AttachmentInput.Type

interface AttachmentMetadata {
  readonly index: number
  readonly name: string | null
  readonly declaredMime: string | null
  readonly inline: boolean
  readonly contentID: string | null
  readonly extensionMime: string | null
  readonly suspiciousFlags: ReadonlyArray<string>
  readonly filename: string | null
  readonly content_type: string | null
  readonly content_disposition: string | null
  readonly size: number | null
  readonly content_id: string | null
  readonly transfer_encoding: string | null
  readonly expected_content_type: string | null
  readonly mime_filename_mismatch: boolean
}

type AttachmentSelection =
  | { readonly type: "one"; readonly attachment: AttachmentMetadata }
  | { readonly type: "all" }
  | { readonly type: "error"; readonly message: string }

interface AttachmentReportInput {
  readonly path: string
  readonly selection:
    | { readonly mode: "one"; readonly index: number }
    | { readonly mode: "all"; readonly status: "metadata_only" }
  readonly attachment?: AttachmentMetadata
  readonly attachments: ReadonlyArray<AttachmentMetadata>
  readonly warnings: ReadonlyArray<string>
  readonly truncated: boolean
}

interface LinkCandidate {
  readonly value: string
  readonly source: string
  readonly displayText?: string
}

interface LinkCandidates {
  readonly values: ReadonlyArray<LinkCandidate>
  readonly truncated: boolean
}

interface LinkReportInput {
  readonly path: string
  readonly links: ReadonlyArray<LinkFinding>
  readonly warnings: ReadonlyArray<string>
  readonly truncated: boolean
}

interface LinkFinding {
  readonly value: string
  readonly url: string
  readonly source: string
  readonly valid: boolean
  readonly display_text: string | null
  readonly scheme: string | null
  readonly host: string | null
  readonly userinfo: boolean
  readonly hasUserinfo: boolean
  readonly ip_literal: boolean
  readonly suspicious_extension: boolean
  readonly suspicious_extension_name: string | null
  readonly findings: ReadonlyArray<string>
  readonly flags: ReadonlyArray<string>
  readonly displayHostRelation: "matched" | "mismatch" | "unavailable"
}

const MAX_WARNING_COUNT = 64
const MAX_LINK_SCAN_CHARS = 4 * 1024 * 1024
const SUSPICIOUS_EXTENSIONS = new Set([
  "ade",
  "adp",
  "apk",
  "appx",
  "appxbundle",
  "arj",
  "bat",
  "cab",
  "cmd",
  "com",
  "cpl",
  "dll",
  "dmg",
  "docm",
  "exe",
  "hta",
  "img",
  "iso",
  "jar",
  "js",
  "jse",
  "lnk",
  "msi",
  "msp",
  "msix",
  "ocx",
  "ps1",
  "rar",
  "scr",
  "sh",
  "sys",
  "vbe",
  "vbs",
  "vhd",
  "vxd",
  "wsf",
  "wsc",
  "xlam",
  "xlsm",
  "xltm",
  "zip",
])
const EXECUTABLE_EXTENSIONS = new Set([
  "ade",
  "adp",
  "apk",
  "appx",
  "appxbundle",
  "bat",
  "cmd",
  "com",
  "cpl",
  "dll",
  "exe",
  "hta",
  "jar",
  "js",
  "jse",
  "lnk",
  "msi",
  "msp",
  "msix",
  "ocx",
  "ps1",
  "scr",
  "sh",
  "sys",
  "vbe",
  "vbs",
  "vhd",
  "vxd",
  "wsf",
  "wsc",
])

function normalizeAttachment(raw: Record<string, unknown>, index: number): AttachmentMetadata {
  const filename = stringField(raw, ["filename", "file_name", "name"])
  const contentType = stringField(raw, ["content_type", "contentType", "mime", "mime_type"])
  const disposition = stringField(raw, ["content_disposition", "contentDisposition", "disposition"])
  const expectedContentType = filename ? lookup(filename) : false
  const expected = typeof expectedContentType === "string" ? normalizeMime(expectedContentType) : undefined
  const declared = normalizeMime(contentType)
  const mismatch = expected !== undefined && declared !== undefined && !isGenericMime(declared) && expected !== declared
  const extension = filename?.match(/\.([a-z0-9]{1,16})$/i)?.[1]?.toLowerCase()
  const suspiciousFlags = [
    ...(extension && EXECUTABLE_EXTENSIONS.has(extension) ? ["executable_extension"] : []),
    ...(filename && /\.[^.]+\.(?:exe|scr|bat|cmd|com|js|jse|vbs|vbe|ps1|hta|lnk|msi|dll)$/i.test(filename)
      ? ["double_extension"]
      : []),
    ...(mismatch ? ["declared_mime_extension_mismatch"] : []),
  ]

  return {
    index,
    name: filename ?? null,
    declaredMime: contentType ?? null,
    inline: raw.inline === true || disposition?.toLowerCase() === "inline",
    contentID: stringField(raw, ["content_id", "contentId", "cid"]) ?? null,
    extensionMime: expected ?? null,
    suspiciousFlags,
    filename: filename ?? null,
    content_type: contentType ?? null,
    content_disposition: disposition ?? null,
    size: numberField(raw, ["size", "length", "content_length", "contentLength"]),
    content_id: stringField(raw, ["content_id", "contentId", "cid"]) ?? null,
    transfer_encoding: stringField(raw, ["content_transfer_encoding", "contentTransferEncoding", "transfer_encoding"]) ?? null,
    expected_content_type: expected ?? null,
    mime_filename_mismatch: mismatch,
  }
}

function selectAttachment(input: AttachmentInputType, attachments: ReadonlyArray<AttachmentMetadata>): AttachmentSelection {
  const hasIndex = input.attachmentIndex !== undefined
  const hasName = input.attachmentName !== undefined

  if (input.allAttachments === true && (hasIndex || hasName))
    return { type: "error", message: "allAttachments cannot be combined with attachmentIndex or attachmentName" }
  if (input.allAttachments === true) return { type: "all" }

  const byIndex = hasIndex
    ? input.attachmentIndex! < attachments.length
      ? attachments[input.attachmentIndex!]
      : undefined
    : undefined
  if (hasIndex && !byIndex)
    return { type: "error", message: `Attachment index ${input.attachmentIndex} was not found` }

  const byName = hasName
    ? attachments.find((attachment) => attachment.filename === input.attachmentName || attachment.name === input.attachmentName)
    : undefined
  if (hasName && !byName) return { type: "error", message: `Attachment ${input.attachmentName} was not found` }
  if (byIndex && byName && byIndex.index !== byName.index)
    return { type: "error", message: "attachmentIndex and attachmentName identify different attachments" }
  if (byIndex ?? byName) return { type: "one", attachment: byIndex ?? byName! }
  if (attachments.length === 0) return { type: "error", message: "email has no attachments" }
  return { type: "one", attachment: attachments[0] }
}

function serializeAttachmentReport(input: AttachmentReportInput) {
  const warnings = [...input.warnings, ATTACHMENT_EXTRACTION_UNAVAILABLE]
  const build = (attachments: ReadonlyArray<AttachmentMetadata>, truncated: boolean) => ({
    schema_version: 1,
    path: boundedString(input.path, MAX_FIELD_CHARS),
    selection: input.selection,
    attachment: input.attachment ?? null,
    attachments,
    analysis: "metadata_only",
    attachment_bytes_analyzed: false,
    warnings,
    limitations: [ATTACHMENT_EXTRACTION_UNAVAILABLE],
    truncated,
  })

  if (input.selection.mode === "one") return serializeReport(build([], input.truncated))

  let count = input.attachments.length
  let report = encodeReport(build(input.attachments, input.truncated))
  while (report.length > MAX_REPORT_CHARS && count > 0) {
    count = count === 1 ? 0 : Math.floor(count / 2)
    report = encodeReport(build(input.attachments.slice(0, count), input.truncated || count < input.attachments.length))
  }
  return report.length <= MAX_REPORT_CHARS
    ? report
    : serializeReport(build([], true))
}

function collectLinkCandidates(result: Result): LinkCandidates {
  const values: LinkCandidate[] = []
  const indexes = new Map<string, number>()
  let truncated = result.truncated

  const add = (raw: string, source: string, displayText?: string) => {
    const value = trimLink(raw)
    if (!isLinkLike(value)) return
    const boundedValue = boundedString(value, MAX_FIELD_CHARS)
    if (boundedValue.length !== value.length) truncated = true
    const existingIndex = indexes.get(boundedValue)
    if (existingIndex !== undefined) {
      const existing = values[existingIndex]
      values[existingIndex] = {
        ...existing,
        source: mergeSources(existing.source, source),
        ...(existing.displayText || !displayText ? {} : { displayText: boundedString(displayText, MAX_DISPLAY_CHARS) }),
      }
      return
    }
    if (values.length >= MAX_LINK_CANDIDATES) {
      truncated = true
      return
    }
    indexes.set(boundedValue, values.length)
    values.push({
      value: boundedValue,
      source: boundedString(source, MAX_FIELD_CHARS),
      ...(displayText ? { displayText: boundedString(displayText, MAX_DISPLAY_CHARS) } : {}),
    })
  }

  for (const body of result.bodies) {
    const bodyText = scanField(body, ["value", "text", "body", "content"])
    if (!bodyText) continue
    if (bodyText.truncated) truncated = true
    const contentType = stringField(body, ["content_type", "contentType", "type"]) ?? "unknown"
    const source = `body:${contentType}`
    extractAnchorCandidates(bodyText.value, source, add)
    for (const value of extractURLTokens(bodyText.value)) add(value, source)
  }

  for (const ioc of result.iocs) {
    const value = stringField(ioc, ["value", "url", "uri", "indicator"])
    if (!value || !isLinkLike(trimLink(value))) continue
    const type = stringField(ioc, ["type", "kind", "category"]) ?? "unknown"
    add(value, `ioc:${type}`)
  }

  return { values, truncated }
}

function analyzeLink(candidate: LinkCandidate): LinkFinding {
  const parsed = parseURL(candidate.value)
  const scheme = schemeOf(candidate.value, parsed) ?? null
  const authority = authorityOf(candidate.value)
  const hostValue = parsed?.hostname || hostOfAuthority(authority)
  const host = hostValue ? boundedString(normalizeHost(hostValue), MAX_FIELD_CHARS) : null
  const userinfo = Boolean(parsed?.username || parsed?.password || authority?.includes("@"))
  const ipLiteral = host !== null && isIpLiteral(host)
  const extension = suspiciousExtension(parsed?.pathname ?? pathOf(candidate.value, authority))
  const findings: string[] = []

  if (!parsed) findings.push("invalid_url")
  if (!scheme) findings.push("missing_scheme")
  else if (scheme !== "http" && scheme !== "https") findings.push(`non_http_scheme:${scheme}`)
  if ((scheme === "http" || scheme === "https") && !host) findings.push("missing_host")
  if (userinfo) findings.push("userinfo")
  if (ipLiteral) findings.push("ip_literal")
  if (
    parsed?.port &&
    !((scheme === "http" && parsed.port === "80") || (scheme === "https" && parsed.port === "443"))
  )
    findings.push("non_default_port")
  if (extension) findings.push(`suspicious_extension:${extension}`)
  if (host?.split(".").some((label) => label.toLowerCase().startsWith("xn--"))) findings.push("punycode_host")
  if (host && /[^\x00-\x7f]/.test(host)) findings.push("unicode_host")

  const displayedURL = candidate.displayText ? firstURLToken(candidate.displayText) : undefined
  const displayedHost = displayedURL ? parseURL(displayedURL)?.hostname : undefined
  const displayHostRelation: LinkFinding["displayHostRelation"] =
    host && displayedHost ? (normalizeHost(displayedHost) === host ? "matched" : "mismatch") : "unavailable"
  if (displayHostRelation === "mismatch") findings.push("display_target_mismatch")

  return {
    value: candidate.value,
    url: candidate.value,
    source: candidate.source,
    valid: parsed !== undefined,
    display_text: candidate.displayText ?? null,
    scheme,
    host,
    userinfo,
    hasUserinfo: userinfo,
    ip_literal: ipLiteral,
    suspicious_extension: extension !== undefined,
    suspicious_extension_name: extension ?? null,
    findings,
    flags: findings.map((finding) =>
      finding.startsWith("non_http_scheme:")
        ? "non_http_scheme"
        : finding.startsWith("suspicious_extension:")
          ? "suspicious_extension"
          : finding === "punycode_host"
            ? "punycode"
            : finding,
    ),
    displayHostRelation,
  }
}

function serializeLinkReport(input: LinkReportInput) {
  const limitations = [
    "URLs were parsed locally; no URL was dereferenced.",
    "DKIM, SPF, and DMARC cryptographic verification are not performed by this tool.",
  ]
  const build = (links: ReadonlyArray<LinkFinding>, truncated: boolean) => ({
    schema_version: 1,
    path: boundedString(input.path, MAX_FIELD_CHARS),
    links,
    warnings: input.warnings,
    limitations,
    dereferenced: false,
    truncated,
  })

  let count = input.links.length
  let report = encodeReport(build(input.links, input.truncated))
  while (report.length > MAX_REPORT_CHARS && count > 0) {
    count = count === 1 ? 0 : Math.floor(count / 2)
    report = encodeReport(build(input.links.slice(0, count), input.truncated || count < input.links.length))
  }
  return report.length <= MAX_REPORT_CHARS ? report : serializeReport(build([], true))
}

function boundedWarnings(warnings: ReadonlyArray<string>) {
  return warnings.slice(0, MAX_WARNING_COUNT).map((warning) => boundedString(warning, MAX_WARNING_CHARS))
}

function boundedModelOutput(report: string) {
  if (report.length <= MAX_MODEL_OUTPUT_CHARS) return report
  const suffix = "\n[model output truncated]"
  return `${report.slice(0, MAX_MODEL_OUTPUT_CHARS - suffix.length)}${suffix}`
}

function serializeReport(value: unknown) {
  const report = encodeReport(value)
  if (report.length <= MAX_REPORT_CHARS) return report
  const path = isRecord(value) && typeof value.path === "string" ? boundedString(value.path, MAX_FIELD_CHARS) : undefined
  return encodeReport({
    ...(path ? { path } : {}),
    warnings: ["Email security report exceeded the output cap; the report was reduced to a bounded summary."],
    truncated: true,
  })
}

function encodeReport(value: unknown) {
  const report = JSON.stringify(value, null, 2)
  return typeof report === "string" ? report : "{}"
}

function stringField(record: Record<string, unknown>, keys: ReadonlyArray<string>, max = MAX_FIELD_CHARS) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return boundedString(value.trim(), max)
  }
  return undefined
}

function numberField(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    if (typeof value === "string" && /^\d+$/.test(value)) return Math.min(Number(value), Number.MAX_SAFE_INTEGER)
  }
  return null
}

function boundedString(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max)
}

function normalizeMime(value: string | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase()
}

function isGenericMime(value: string) {
  return GENERIC_MIME_TYPES.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function scanField(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== "string" || !value) continue
    return {
      value: value.slice(0, MAX_LINK_SCAN_CHARS),
      truncated: value.length > MAX_LINK_SCAN_CHARS,
    }
  }
  return undefined
}

function extractAnchorCandidates(text: string, source: string, add: (value: string, source: string, displayText?: string) => void) {
  const anchors = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
  let match: RegExpExecArray | null
  while ((match = anchors.exec(text)) !== null) {
    const href = match[1] ?? match[2] ?? match[3]
    if (!href) continue
    const displayText = boundedString(
      (match[4] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      MAX_DISPLAY_CHARS,
    )
    add(href, `${source}:anchor`, displayText || undefined)
  }
}

function extractURLTokens(text: string) {
  const urls: string[] = []
  const tokens = /(?:\b[a-z][a-z0-9+.-]*:|\/\/)[^\s<>"'`]+/gi
  let match: RegExpExecArray | null
  while ((match = tokens.exec(text)) !== null) {
    const value = trimLink(match[0])
    if (value) urls.push(value)
  }
  return urls
}

function firstURLToken(text: string) {
  const value = extractURLTokens(text)[0]
  return value
}

function trimLink(value: string) {
  let result = value.trim()
  while (/[.,!?;:]$/.test(result)) result = result.slice(0, -1)
  while (result.endsWith(")") && countCharacter(result, ")") > countCharacter(result, "("))
    result = result.slice(0, -1)
  while (result.endsWith("]") && countCharacter(result, "]") > countCharacter(result, "["))
    result = result.slice(0, -1)
  while (result.endsWith("}") && countCharacter(result, "}") > countCharacter(result, "{"))
    result = result.slice(0, -1)
  return result
}

function countCharacter(value: string, character: string) {
  return [...value].filter((item) => item === character).length
}

function isLinkLike(value: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
}

function mergeSources(current: string, next: string) {
  if (current === next || current.split(",").includes(next)) return current
  return boundedString(`${current},${next}`, MAX_FIELD_CHARS)
}

function parseURL(value: string) {
  return URL.canParse(value) ? new URL(value) : undefined
}

function schemeOf(value: string, parsed: URL | undefined) {
  if (parsed) return parsed.protocol.slice(0, -1).toLowerCase()
  return value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
}

function authorityOf(value: string) {
  return value.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i)?.[1]
}

function hostOfAuthority(authority: string | undefined) {
  if (!authority) return undefined
  const withoutUserinfo = authority.slice(authority.lastIndexOf("@") + 1)
  if (withoutUserinfo.startsWith("[")) return withoutUserinfo.match(/^\[([^\]]*)\]/)?.[1]
  return withoutUserinfo.split(":", 1)[0]
}

function pathOf(value: string, authority: string | undefined) {
  if (!authority) return ""
  const start = value.indexOf(authority) + authority.length
  return value.slice(start).split(/[?#]/, 1)[0]
}

function normalizeHost(value: string) {
  const host = value.toLowerCase()
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

function isIpLiteral(host: string) {
  if (host.includes(":")) return /^[0-9a-f:]+$/i.test(host)
  const parts = host.split(".")
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function suspiciousExtension(pathname: string) {
  const name = pathname.slice(pathname.lastIndexOf("/") + 1)
  const extension = name.match(/\.([a-z0-9]{1,16})$/i)?.[1]?.toLowerCase()
  return extension && SUSPICIOUS_EXTENSIONS.has(extension) ? extension : undefined
}
