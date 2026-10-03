import { PriorWork } from "@turenlabs/schema/prior-work"
import { Option, Schema } from "effect"
import type { GitFingerprint } from "../git-fingerprint"

export function unavailable(reason: PriorWork.CaptureUnavailableReason): PriorWork.Capture {
  return { scheme: "fp_v1", capture_revision: 1, status: "unavailable", reason }
}

/** Maps a primitive result to the stored shape and enforces the stored-baseline budget. */
export function bounded(result: GitFingerprint.Result): PriorWork.Capture {
  if (result.status === "unavailable") return unavailable(result.reason)
  const value: PriorWork.Capture = {
    scheme: "fp_v1",
    capture_revision: 1,
    status: "available",
    object_format: result.objectFormat,
    ...(result.head ? { head: result.head } : {}),
    root: result.root,
    completeness: result.completeness.state === "complete" ? { state: "complete" } : { ...result.completeness },
    anchors: result.anchors.map(
      (anchor): PriorWork.CaptureAnchor =>
        anchor.state === "tree" ? { state: "tree", oid: anchor.oid, contains_symlink: anchor.containsSymlink } : anchor,
    ),
  }
  // Never truncate and call it complete: an oversized or invalid baseline is stored unavailable.
  if (Buffer.byteLength(JSON.stringify(value)) > PriorWork.CAPTURE_BYTES) return unavailable("metadata_limit")
  return Option.getOrElse(Schema.decodeUnknownOption(PriorWork.Capture)(value), () => unavailable("metadata_limit"))
}

/** Stored decoding stays lenient: anything unrecognized becomes an absent baseline (unknown). */
export function decodeCapture(value: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(PriorWork.Capture)(value))
}

/**
 * Applicability algebra from `specs/prior-work.md` (Status algebra). Pure: compares an original
 * stored baseline with a fresh capture of the reader's worktree. `unchanged_since_recording`
 * never means verified, safe, checked at this tree, or a reason to skip investigation.
 */
export function evaluate(input: {
  readonly kind: PriorWork.Kind
  /** Anchor paths of the recording revision, by position; the baseline indexes these. */
  readonly original: readonly string[]
  /** Anchor paths of the exact evaluated revision, which may add anchors but never removes one. */
  readonly evaluated: readonly string[]
  readonly baseline: PriorWork.Capture | undefined
  readonly current: PriorWork.Capture
  /** The fresh capture's result for an anchor path in the union. */
  readonly anchor: (path: string) => PriorWork.CaptureAnchor | undefined
}): Pick<PriorWork.Applicability, "status" | "reason"> {
  const baseline = input.baseline
  const current = input.current
  if (!baseline) return { status: "unknown", reason: "no_baseline" }
  if (baseline.status !== "available") return { status: "unknown", reason: "baseline_unavailable" }
  // A partial baseline is unknown whatever the present holds, and is not captured against.
  if (baseline.completeness.state !== "complete") return { status: "unknown", reason: "partial" }
  if (current.status !== "available") return { status: "unknown", reason: "current_unavailable" }
  if (baseline.scheme !== current.scheme || baseline.object_format !== current.object_format)
    return { status: "unknown", reason: "incompatible" }
  // v1 gates on whole-capture completeness even for anchored findings and leads.
  if (current.completeness.state !== "complete") return { status: "unknown", reason: "partial" }

  // An empty original anchor set never yields unchanged by vacuous iteration: it compares roots.
  if (input.kind === "coverage" || input.kind === "refutation" || input.original.length === 0)
    return baseline.root === current.root
      ? { status: "unchanged_since_recording", reason: "root_unchanged" }
      : { status: "stale", reason: "root_changed" }

  const original = new Set(input.original)
  const results = [
    ...input.original.map((path, index) => compare(baseline.anchors[index], input.anchor(path))),
    // An anchor added after recording has no recorded identifier, so it cannot be current.
    ...input.evaluated.filter((path) => !original.has(path)).map(() => "unknown" as const),
  ]
  // A demonstrated change to an originally resolved anchor outranks every unknown anchor.
  if (results.includes("stale")) return { status: "stale", reason: "anchor_changed" }
  if (results.includes("unknown")) return { status: "unknown", reason: "anchor_unknown" }
  return { status: "unchanged_since_recording", reason: "anchors_unchanged" }
}

function compare(recorded: PriorWork.CaptureAnchor | undefined, current: PriorWork.CaptureAnchor | undefined) {
  // Missing, excluded, unsupported or noncanonical at recording: nothing to compare against.
  if (!recorded || recorded.state === "unknown" || recorded.state === "absent") return "unknown"
  // The capture establishes literal absence only from a no-follow ENOENT; anything else is unknown.
  if (current?.state === "absent") return "stale"
  if (!current || current.state === "unknown") return "unknown"
  if (recorded.state !== current.state) return "stale"
  if (recorded.oid !== current.oid) return "stale"
  if (recorded.state === "entry" && current.state === "entry" && recorded.mode !== current.mode) return "stale"
  // Equal link text, or an equal directory containing a link, cannot prove its target unchanged.
  if (recorded.state === "entry" && recorded.mode === "120000") return "unknown"
  if (recorded.state === "tree" && current.state === "tree" && (recorded.contains_symlink || current.contains_symlink))
    return "unknown"
  return "equal"
}
