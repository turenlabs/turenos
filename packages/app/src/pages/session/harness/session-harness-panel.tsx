import { For, Show, type ComponentProps } from "solid-js"
import { Button } from "@turenlabs/ui/button"
import { Icon } from "@turenlabs/ui/icon"
import { StatusIndicatorV2, type StatusIndicatorV2Tone } from "@turenlabs/ui/v2/status-indicator-v2"

type HarnessIcon = ComponentProps<typeof Icon>["name"]

export type SessionHarnessSnapshot = {
  id?: string
  version: string | number
  label?: string
  updatedAt?: string
}

export type SessionHarnessProposal = {
  id: string
  title: string
  summary: string
  status?: "draft" | "pending" | "approved" | "applied" | "rejected" | "failed"
  details?: string
  changeCount?: number
  createdAt?: string
}

export type SessionHarnessChange = {
  id?: string
  path: string
  summary: string
  kind?: "added" | "modified" | "deleted" | "renamed"
  additions?: number
  deletions?: number
}

export type SessionHarnessGuidance = {
  directive: string
  appliesTo?: string
}

export type SessionHarnessTool = {
  id?: string
  name: string
  description?: string
  status?: string
}

export type SessionHarnessValidation = {
  status: "passed" | "failed" | "pending" | "not_run"
  summary: string
  details?: string[]
  checkedAt?: string
}

export type SessionHarnessReviewerRun = {
  id: string
  outcome: string
  label: string
  detail?: string
  reviewerSessionID?: string
  at?: string
}

export type SessionHarnessPanelProps = {
  snapshot: () => SessionHarnessSnapshot | undefined
  mode: () => string | undefined
  status: () => string | undefined
  proposals: () => SessionHarnessProposal[]
  changes: () => SessionHarnessChange[]
  tools: () => SessionHarnessTool[]
  guidance?: () => SessionHarnessGuidance[]
  validation: () => SessionHarnessValidation | undefined
  reviewerRuns?: () => SessionHarnessReviewerRun[]
  error?: () => string | undefined
  canRollback?: () => boolean
  onApply: (proposal: SessionHarnessProposal) => void
  onApprove: (proposal: SessionHarnessProposal) => void
  onReject: (proposal: SessionHarnessProposal) => void
  onReload: () => void
  onRollback: () => void
}

export function SessionHarnessPanel(props: SessionHarnessPanelProps) {
  const snapshot = () => props.snapshot()
  const snapshotVersion = () => {
    const current = snapshot()
    return current ? String(current.version) : "—"
  }
  const snapshotDetails = () => {
    const current = snapshot()
    if (!current) return []
    return [current.label ? current.id : undefined, current.updatedAt].filter(
      (detail): detail is string => detail !== undefined,
    )
  }
  const mode = () => props.mode() ?? "Not available"
  const status = () => props.status() ?? "Not available"
  const proposals = () => props.proposals()
  const changes = () => props.changes()
  const tools = () => props.tools()
  const guidance = () => props.guidance?.() ?? []
  const validation = () => props.validation()
  const reviewerRuns = () => props.reviewerRuns?.() ?? []
  const error = () => props.error?.()
  const validationStatus = () => validation()?.status ?? "not_run"
  const validationDetails = () => validation()?.details ?? []

  return (
    <section
      data-component="session-harness-panel"
      data-status={status()}
      class="flex h-full min-h-0 flex-col overflow-hidden rounded-surface border border-v2-border-border-muted bg-v2-background-bg-base"
    >
      <header class="shrink-0 border-b border-v2-border-border-muted px-4 py-3 md:px-5">
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2.5">
            <Icon name="shield" size="small" class="shrink-0 text-v2-text-weak" aria-hidden="true" />
            <div class="min-w-0">
              <h2 class="text-14-medium text-v2-text-strong">Harness</h2>
              <p class="mt-0.5 max-w-xl text-11-regular text-v2-text-weak">
                Review proposed work and keep the session's working state under control.
              </p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <StatusIndicatorV2 tone={statusTone(status())} live>
              {status()}
            </StatusIndicatorV2>
            <Button data-action="session-harness-reload" size="small" variant="ghost" onClick={props.onReload}>
              Reload
            </Button>
          </div>
        </div>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="@container mx-auto w-full max-w-240 px-4 md:px-5">
          <Show when={error()}>
            {(message) => (
              <div
                class="flex min-w-0 items-start gap-3 border-b border-v2-border-border-muted py-3 text-12-regular text-v2-state-fg-danger"
                role="alert"
              >
                <StatusIndicatorV2 tone="danger" class="mt-px shrink-0">
                  Error
                </StatusIndicatorV2>
                <span class="min-w-0 break-words">{message()}</span>
              </div>
            )}
          </Show>

          <section class="grid grid-cols-2 gap-x-5 gap-y-3 py-4 @[42rem]:grid-cols-4">
            <HarnessMeta
              label="Snapshot"
              value={snapshot()?.label ?? snapshot()?.id ?? "No snapshot"}
              details={snapshotDetails()}
            />
            <HarnessMeta label="Version" value={snapshotVersion()} />
            <HarnessMeta label="Mode" value={mode()} />
            <HarnessMeta label="Status" value={status()} tone={statusTone(status())} />
          </section>

          <section class="border-t border-v2-border-border-muted py-4">
            <SectionHeading icon="review" title="Proposals" count={proposals().length} />
            <Show
              when={proposals().length > 0}
              fallback={<EmptySection message="The reviewer has not proposed anything for this session yet." />}
            >
              <div class="mt-3 grid grid-cols-1 border-t border-v2-border-border-muted @[54rem]:grid-cols-2 @[54rem]:gap-x-6">
                <For each={proposals()}>
                  {(proposal) => (
                    <article class="flex min-w-0 flex-col border-b border-v2-border-border-muted py-3 last:border-b-0">
                      <div class="flex min-w-0 items-start justify-between gap-3">
                        <div class="min-w-0">
                          <h3 class="break-words text-13-medium text-v2-text-strong">{proposal.title}</h3>
                          <div class="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-v2-text-weak">
                            <span class="min-w-0 break-all">{proposal.id}</span>
                            <Show when={proposal.changeCount !== undefined}>
                              <span aria-hidden="true">·</span>
                              <span>
                                {proposal.changeCount} {proposal.changeCount === 1 ? "change" : "changes"}
                              </span>
                            </Show>
                            <Show when={proposal.createdAt}>
                              {(createdAt) => (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{createdAt()}</span>
                                </>
                              )}
                            </Show>
                          </div>
                        </div>
                        <StatusIndicatorV2 tone={statusTone(proposal.status ?? "pending")} class="shrink-0">
                          {proposalStatusLabel(proposal.status)}
                        </StatusIndicatorV2>
                      </div>
                      <p class="mt-2 break-words text-12-regular text-v2-text-base">{proposal.summary}</p>
                      <Show when={proposal.details}>
                        {(details) => <p class="mt-1.5 break-words text-11-regular text-v2-text-weak">{details()}</p>}
                      </Show>
                      {/* Applied and rejected proposals are settled history. Approved proposals
                          keep an explicit Apply action so a transient apply failure is recoverable. */}
                      <div
                        class="mt-3 flex flex-wrap justify-end gap-2"
                        classList={{ hidden: proposal.status === "applied" || proposal.status === "rejected" }}
                      >
                        <Button
                          data-action="session-harness-reject"
                          size="small"
                          variant="ghost"
                          class="text-v2-state-fg-danger"
                          onClick={() => props.onReject(proposal)}
                        >
                          Reject
                        </Button>
                        <Show when={proposal.status !== "approved"}>
                          <Button
                            data-action="session-harness-approve"
                            size="small"
                            variant="secondary"
                            icon="check"
                            onClick={() => props.onApprove(proposal)}
                          >
                            Approve
                          </Button>
                        </Show>
                        <Show when={proposal.status === "approved"}>
                          <Button
                            data-action="session-harness-apply"
                            size="small"
                            variant="secondary"
                            icon="check"
                            onClick={() => props.onApply(proposal)}
                          >
                            Apply
                          </Button>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <div class="grid min-w-0 grid-cols-1 border-t border-v2-border-border-muted @[64rem]:grid-cols-2">
            <section class="min-w-0 py-4 @[64rem]:pr-6">
              <SectionHeading icon="review" title="Changes" count={changes().length} />
              <Show
                when={changes().length > 0}
                fallback={<EmptySection message="No changes are associated with this snapshot." />}
              >
                <div class="mt-3 border-t border-v2-border-border-muted">
                  <For each={changes()}>
                    {(change) => (
                      <article class="flex min-w-0 items-start gap-2.5 border-b border-v2-border-border-muted py-2.5 last:border-b-0">
                        <Icon name="code" size="small" class="mt-0.5 shrink-0 text-v2-text-weak" aria-hidden="true" />
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span class="min-w-0 break-all font-mono text-11-medium text-v2-text-strong">
                              {change.path}
                            </span>
                            <Show when={change.kind}>
                              {(kind) => (
                                <span class="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-v2-text-weak">
                                  {kind()}
                                </span>
                              )}
                            </Show>
                          </div>
                          <Show when={change.id}>
                            {(id) => <p class="mt-0.5 break-all font-mono text-[10px] text-v2-text-weak">{id()}</p>}
                          </Show>
                          <p class="mt-1 break-words text-11-regular text-v2-text-base">{change.summary}</p>
                          <Show when={change.additions !== undefined || change.deletions !== undefined}>
                            <div class="mt-1 flex flex-wrap gap-2 font-mono text-[10px] font-medium">
                              <Show when={change.additions !== undefined}>
                                <span class="text-v2-state-fg-success">+{change.additions}</span>
                              </Show>
                              <Show when={change.deletions !== undefined}>
                                <span class="text-v2-state-fg-danger">−{change.deletions}</span>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </section>

            <section class="min-w-0 border-t border-v2-border-border-muted py-4 @[64rem]:border-l @[64rem]:border-t-0 @[64rem]:pl-6">
              <SectionHeading icon="terminal" title="Tools" count={tools().length} />
              <Show
                when={tools().length > 0}
                fallback={<EmptySection message="Tools used by the harness appear here." />}
              >
                <div class="mt-3 border-t border-v2-border-border-muted">
                  <For each={tools()}>
                    {(tool) => (
                      <article class="flex min-w-0 items-start gap-2.5 border-b border-v2-border-border-muted py-2.5 last:border-b-0">
                        <Icon
                          name="terminal"
                          size="small"
                          class="mt-0.5 shrink-0 text-v2-text-weak"
                          aria-hidden="true"
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 items-start justify-between gap-3">
                            <span class="min-w-0 break-words text-12-medium text-v2-text-strong">{tool.name}</span>
                            <StatusIndicatorV2 tone={statusTone(tool.status ?? "available")} class="shrink-0">
                              {tool.status ?? "Available"}
                            </StatusIndicatorV2>
                          </div>
                          <Show when={tool.id}>
                            {(id) => <p class="mt-0.5 break-all font-mono text-[10px] text-v2-text-weak">{id()}</p>}
                          </Show>
                          <Show when={tool.description}>
                            {(description) => (
                              <p class="mt-1 break-words text-11-regular text-v2-text-weak">{description()}</p>
                            )}
                          </Show>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </div>

          <section class="min-w-0 border-t border-v2-border-border-muted py-4">
            <SectionHeading icon="bullet-list" title="Standing instructions" count={guidance().length} />
            <Show
              when={guidance().length > 0}
              fallback={
                <EmptySection message="Instructions the reviewer wants the agent to follow every turn appear here." />
              }
            >
              <div class="mt-3 border-t border-v2-border-border-muted">
                <For each={guidance()}>
                  {(item) => (
                    <article class="min-w-0 border-b border-v2-border-border-muted py-2.5 last:border-b-0">
                      <Show when={item.appliesTo}>
                        {(appliesTo) => (
                          <p class="mb-1 truncate font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-v2-text-weak">
                            {appliesTo()}
                          </p>
                        )}
                      </Show>
                      <p class="break-words text-12-regular text-v2-text-base">{item.directive}</p>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section class="border-t border-v2-border-border-muted py-4">
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-3">
                  <SectionHeading icon={validationIcon(validationStatus())} title="Validation" />
                  <StatusIndicatorV2 tone={statusTone(validationStatus())} live>
                    {validationLabel(validationStatus())}
                  </StatusIndicatorV2>
                </div>
                <p class="mt-2 break-words text-12-regular text-v2-text-base">
                  {validation()?.summary ?? "Validation has not run for this snapshot."}
                </p>
                <Show when={validation()?.checkedAt}>
                  {(checkedAt) => (
                    <p class="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-v2-text-weak">
                      Checked {checkedAt()}
                    </p>
                  )}
                </Show>
              </div>
              <Button
                data-action="session-harness-rollback"
                size="small"
                variant="ghost"
                icon="reset"
                class="shrink-0"
                disabled={props.canRollback ? !props.canRollback() : false}
                onClick={props.onRollback}
              >
                Rollback
              </Button>
            </div>
            <Show when={validationDetails().length > 0}>
              <ul class="mt-3 border-t border-v2-border-border-muted text-11-regular text-v2-text-base">
                <For each={validationDetails()}>
                  {(detail) => (
                    <li class="flex min-w-0 items-start gap-2 border-b border-v2-border-border-muted py-2 last:border-b-0">
                      <Icon
                        name="check-small"
                        size="small"
                        class="mt-0.5 shrink-0 text-v2-text-weak"
                        aria-hidden="true"
                      />
                      <span class="min-w-0 break-words">{detail}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <details data-component="session-harness-reviewer" class="group border-t border-v2-border-border-muted">
            <summary class="flex cursor-pointer list-none items-center gap-2 py-3 text-v2-text-strong">
              <Icon
                name="chevron-right"
                size="small"
                class="shrink-0 text-v2-text-weak transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              <Icon name="brain" size="small" class="shrink-0 text-v2-text-weak" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-v2-text-weak">
                Background reviewer
              </span>
              <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-v2-text-weak">
                {reviewerRuns().length > 0 ? `${reviewerRuns().length} runs` : "no runs yet"}
              </span>
            </summary>
            <div class="border-t border-v2-border-border-muted pb-2">
              <Show
                when={reviewerRuns().length > 0}
                fallback={
                  <EmptySection message="The hidden reviewer has not completed a pass for this session yet. It first runs shortly after the session starts, then every few minutes while the session stays active." />
                }
              >
                <ul>
                  <For each={reviewerRuns()}>
                    {(run) => (
                      <li
                        data-outcome={run.outcome}
                        class="flex min-w-0 items-start gap-3 border-b border-v2-border-border-muted py-2.5 last:border-b-0"
                      >
                        <StatusIndicatorV2 tone={statusTone(run.outcome)} class="mt-px shrink-0">
                          {run.outcome}
                        </StatusIndicatorV2>
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span class="break-words text-12-medium text-v2-text-strong">{run.label}</span>
                            <Show when={run.at}>
                              {(at) => <span class="font-mono text-[10px] text-v2-text-weak">{at()}</span>}
                            </Show>
                          </div>
                          <div class="mt-0.5 flex min-w-0 flex-wrap gap-x-2 font-mono text-[10px] text-v2-text-weak">
                            <span class="break-all">{run.id}</span>
                            <Show when={run.reviewerSessionID}>
                              {(reviewerSessionID) => (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span class="break-all">{reviewerSessionID()}</span>
                                </>
                              )}
                            </Show>
                          </div>
                          <Show when={run.detail}>
                            {(detail) => <p class="mt-1 break-words text-11-regular text-v2-text-weak">{detail()}</p>}
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </details>
        </div>
      </div>
    </section>
  )
}

function proposalStatusLabel(status: SessionHarnessProposal["status"]) {
  if (status === "applied") return "Applied"
  if (status === "approved") return "Approved"
  if (status === "rejected") return "Rejected"
  if (status === "failed") return "Failed"
  if (status === "draft") return "Draft"
  return "Pending"
}

function HarnessMeta(props: { label: string; value: string; details?: string[]; tone?: StatusIndicatorV2Tone }) {
  return (
    <div class="min-w-0">
      <div class="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-v2-text-weak">{props.label}</div>
      <Show
        when={props.tone}
        fallback={<div class="mt-1 truncate text-12-medium text-v2-text-strong">{props.value}</div>}
      >
        {(tone) => (
          <StatusIndicatorV2 tone={tone()} class="mt-1 max-w-full truncate">
            {props.value}
          </StatusIndicatorV2>
        )}
      </Show>
      <For each={props.details}>
        {(detail) => <div class="mt-0.5 truncate font-mono text-[10px] text-v2-text-weak">{detail}</div>}
      </For>
    </div>
  )
}

function SectionHeading(props: { icon: HarnessIcon; title: string; count?: number }) {
  return (
    <div class="flex min-w-0 items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <Icon name={props.icon} size="small" class="shrink-0 text-v2-text-weak" aria-hidden="true" />
        <h2 class="truncate font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-v2-text-weak">
          {props.title}
        </h2>
      </div>
      <Show when={props.count !== undefined}>
        <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-v2-text-weak">{props.count}</span>
      </Show>
    </div>
  )
}

function EmptySection(props: { message: string }) {
  return <p class="mt-3 py-2 text-11-regular text-v2-text-weak">{props.message}</p>
}

function validationLabel(status: SessionHarnessValidation["status"]) {
  if (status === "passed") return "Passed"
  if (status === "failed") return "Failed"
  if (status === "pending") return "Running"
  return "Not run"
}

function validationIcon(status: SessionHarnessValidation["status"]): HarnessIcon {
  if (status === "passed") return "circle-check"
  if (status === "failed") return "circle-ban-sign"
  if (status === "pending") return "status"
  return "help"
}

function statusTone(status: string | undefined): StatusIndicatorV2Tone {
  const normalized = status?.trim().toLowerCase()
  if (
    normalized === "passed" ||
    normalized === "ready" ||
    normalized === "available" ||
    normalized === "approved" ||
    normalized === "applied" ||
    normalized === "success"
  ) {
    return "success"
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "blocked" ||
    normalized === "rejected" ||
    normalized === "critical" ||
    normalized === "timeout" ||
    normalized === "unparseable"
  ) {
    return "danger"
  }
  if (
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "in_progress" ||
    normalized === "in progress" ||
    normalized === "draft"
  ) {
    return "warning"
  }
  if (normalized === "active" || normalized === "working" || normalized === "proposed") return "info"
  return "neutral"
}
