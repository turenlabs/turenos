import { For, Show } from "solid-js"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Tag } from "@turenlabs/ui/v2/badge-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@turenlabs/ui/v2/dialog-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import "./intel-tables.css"
import {
  intelAgeLabel,
  isIntelStale,
  severityDot,
  type Advisory,
  type IntelSeverity,
  type KevItem,
  type NewsItem,
} from "./intel-api"

export const INTEL_SEVERITIES: ReadonlyArray<"all" | IntelSeverity> = [
  "all",
  "critical",
  "high",
  "medium",
  "low",
  "info",
]

/** Severity chip reusing the Tag primitive and the run-dot vocabulary from loops. */
export function SeverityTag(props: { severity: IntelSeverity }) {
  return (
    <Tag
      data-severity={props.severity}
      class="shrink-0 capitalize"
      style={{
        height: "24px",
        padding: "0 8px",
        gap: "6px",
        "border-radius": "5px",
        "font-size": "12px",
        "line-height": "18px",
        "border-color": "color-mix(in srgb, currentColor 20%, transparent)",
        background: "color-mix(in srgb, currentColor 7%, transparent)",
        color:
          props.severity === "critical" || props.severity === "high"
            ? "var(--v2-state-fg-danger)"
            : props.severity === "medium"
              ? "var(--v2-state-fg-warning)"
              : "var(--v2-text-text-muted)",
      }}
    >
      <span aria-hidden="true" class={`h-1.5 w-1.5 shrink-0 rounded-full ${severityDot(props.severity)}`} />
      {props.severity}
    </Tag>
  )
}

/**
 * Stale-cache age badge. Shows when the backing cache was last polled and
 * flips to a stale tone past the poll interval — the server polls
 * automatically, so staleness is informational, never an error.
 */
export function CacheAgeBadge(props: { lastPollAt: number | undefined; staleAfterMs?: number }) {
  const stale = () => isIntelStale(props.lastPollAt, Date.now(), props.staleAfterMs)
  const label = () => intelAgeLabel(Date.now(), props.lastPollAt)
  return (
    <span
      data-component="intel-age-badge"
      data-stale={stale() ? "true" : "false"}
      title={
        props.lastPollAt === undefined
          ? "The server has not polled intel feeds yet"
          : `Last polled ${new Date(props.lastPollAt).toLocaleString()}`
      }
      class={`shrink-0 font-mono text-[10px] ${stale() ? "text-v2-state-fg-warning" : "text-v2-text-text-faint"}`}
    >
      {stale() && props.lastPollAt !== undefined ? `stale · ${label()}` : label()}
    </span>
  )
}

export function IntelEmpty(props: { title: string; hint: string }) {
  return (
    <div data-component="intel-empty" class="px-3.5 py-8 text-center">
      <p class="text-[13px] text-v2-text-text-base [font-weight:600]">{props.title}</p>
      <p class="mx-auto mt-1 max-w-md text-[12px] leading-5 text-v2-text-text-muted">{props.hint}</p>
    </div>
  )
}

export function IntelError(props: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-component="intel-error"
      class="m-3 rounded-[9px] border border-v2-state-border-danger bg-v2-state-bg-danger px-4 py-3 text-[12px] text-v2-state-fg-danger"
    >
      <p>{props.message}</p>
      <button
        type="button"
        data-action="intel-retry"
        class="mt-2 font-mono text-[11px] underline outline-none focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
        onClick={props.onRetry}
      >
        Retry
      </button>
    </div>
  )
}

/** Native title buttons retain keyboard activation; clicks anywhere in a row open details. */
export function AdvisoryList(props: { items: readonly Advisory[] }) {
  const dialog = useDialog()
  return (
    <div data-component="intel-advisory-list" class="intel-table-wrap">
      <table class="intel-table intel-table-advisories" aria-label="Advisories">
        <thead>
          <tr>
            <th scope="col" class="intel-table-source">
              Source / Age
            </th>
            <th scope="col">Advisory</th>
            <th scope="col" class="intel-table-severity">
              Severity
            </th>
            <th scope="col" class="intel-table-score">
              CVSS
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.items}>
            {(item) => (
              <tr
                class="intel-table-action-row"
                onClick={() => void dialog.show(() => <AdvisoryDetails item={item} />)}
              >
                <td class="intel-table-source">
                  <span class="intel-table-source-name" title={item.source}>
                    {item.source}
                  </span>
                  <span class="intel-table-age" title={new Date(item.publishedAt).toLocaleString()}>
                    {intelAgeLabel(Date.now(), item.publishedAt)}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    data-action="intel-advisory-details"
                    class="intel-table-title"
                    title={item.title}
                    aria-label={item.title}
                  >
                    {item.title}
                  </button>
                </td>
                <td class="intel-table-severity">
                  <span class="intel-table-severity-label" data-severity={item.severity}>
                    <span aria-hidden="true" class={`intel-table-dot ${severityDot(item.severity)}`} />
                    {item.severity}
                  </span>
                </td>
                <td class="intel-table-score">{item.cvss?.toFixed(1) ?? "—"}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function AdvisoryDetails(props: { item: Advisory }) {
  const platform = usePlatform()
  return (
    <Dialog size="large" fit>
      <DialogHeader>
        <DialogTitle>Advisory details</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-col gap-5 overflow-y-auto !p-5 sm:!p-6">
        <div data-component="intel-advisory-details" class="flex min-w-0 flex-col gap-5">
          <div>
            <div class="mb-3 flex flex-wrap items-center gap-3">
              <SeverityTag severity={props.item.severity} />
              <span class="text-[12px] text-v2-text-text-muted">{props.item.source}</span>
              <Show when={props.item.cvss !== undefined}>
                <span class="font-mono text-[12px] text-v2-text-text-base">CVSS {props.item.cvss?.toFixed(1)}</span>
              </Show>
            </div>
            <h2 class="break-words text-[20px] leading-7 tracking-[-0.02em] text-v2-text-text-base [font-weight:600] [overflow-wrap:anywhere]">
              {props.item.title}
            </h2>
          </div>
          <dl class="grid grid-cols-1 gap-4 rounded-lg bg-v2-background-bg-layer-01 p-4 text-[12px] sm:grid-cols-2">
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-v2-text-text-muted">Identifier</dt>
              <dd class="mt-1 break-words font-mono text-v2-text-text-base">{props.item.id}</dd>
            </div>
            <div>
              <dt class="text-v2-text-text-muted">Published</dt>
              <dd class="mt-1 text-v2-text-text-base">{new Date(props.item.publishedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt class="text-v2-text-text-muted">Updated</dt>
              <dd class="mt-1 text-v2-text-text-base">{new Date(props.item.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <div>
            <h3 class="mb-2 text-[13px] text-v2-text-text-base [font-weight:600]">Summary</h3>
            <p class="whitespace-pre-wrap break-words text-[13px] leading-6 text-v2-text-text-muted [overflow-wrap:anywhere]">
              {props.item.summary || "This feed did not provide a detailed summary."}
            </p>
          </div>
        </div>
      </DialogBody>
      <Show when={props.item.url && /^https?:\/\//i.test(props.item.url)}>
        <DialogFooter>
          <ButtonV2 variant="outline" size="large" onClick={() => platform.openLink(props.item.url!)}>
            Open original advisory
          </ButtonV2>
        </DialogFooter>
      </Show>
    </Dialog>
  )
}

/** KEV catalog uses only fields supplied by the feed. */
export function KevList(props: { items: readonly KevItem[] }) {
  return (
    <div data-component="intel-kev-list" class="intel-table-wrap">
      <table class="intel-table intel-table-kev" aria-label="Known exploited vulnerabilities">
        <thead>
          <tr>
            <th scope="col" class="intel-table-cve">
              CVE
            </th>
            <th scope="col">Vulnerability</th>
            <th scope="col" class="intel-table-vendor">
              Vendor / Product
            </th>
            <th scope="col" class="intel-table-date intel-table-added">
              Added
            </th>
            <th scope="col" class="intel-table-date">
              Due
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.items}>
            {(item) => (
              <tr>
                <td class="intel-table-cve" title={item.cveID}>
                  <Show when={item.url} fallback={item.cveID}>
                    {(href) => (
                      <a href={href()} target="_blank" rel="noreferrer">
                        {item.cveID}
                      </a>
                    )}
                  </Show>
                </td>
                <td>
                  <span class="intel-table-title" title={item.name}>
                    {item.name}
                  </span>
                </td>
                <td class="intel-table-vendor" title={`${item.vendor} / ${item.product}`}>
                  {item.vendor} / {item.product}
                </td>
                <td class="intel-table-date intel-table-added" title={new Date(item.dateAdded).toLocaleString()}>
                  {intelAgeLabel(Date.now(), item.dateAdded)}
                </td>
                <td class="intel-table-date">
                  {item.dueDate === undefined ? "—" : new Date(item.dueDate).toLocaleDateString()}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

/** Security news rows: linked title, source, age. */
export function NewsList(props: { items: readonly NewsItem[] }) {
  return (
    <div data-component="intel-news-list" class="intel-table-wrap">
      <table class="intel-table intel-table-news" aria-label="Security news">
        <thead>
          <tr>
            <th scope="col" class="intel-table-source">
              Source
            </th>
            <th scope="col">Story</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.items}>
            {(item) => (
              <tr>
                <td class="intel-table-source">
                  <span class="intel-table-source-name" title={item.source}>
                    {item.source}
                  </span>
                  <span class="intel-table-age" title={new Date(item.publishedAt).toLocaleString()}>
                    {intelAgeLabel(Date.now(), item.publishedAt)}
                  </span>
                </td>
                <td>
                  <a href={item.url} target="_blank" rel="noreferrer" class="intel-table-title" title={item.title}>
                    {item.title}
                  </a>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

/** Compact severity controls for the board pane. */
export function SeverityFilter(props: {
  value: "all" | IntelSeverity
  onChange: (value: "all" | IntelSeverity) => void
}) {
  return (
    <div data-component="intel-severity-filter" class="intel-table-filter" role="group" aria-label="Severity filter">
      <For each={INTEL_SEVERITIES}>
        {(option) => (
          <button
            type="button"
            data-action={`intel-severity-${option}`}
            aria-pressed={props.value === option}
            class="intel-table-control"
            onClick={() => props.onChange(option)}
          >
            {option}
          </button>
        )}
      </For>
    </div>
  )
}

/** Prev/Next pager over `{ items, total, page, pageSize }` list shapes. */
export function IntelPager(props: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pageCount = () => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize)))
  return (
    <Show when={props.total > props.pageSize}>
      <div data-component="intel-pager" class="intel-table-pager">
        <span class="font-mono text-[10px] text-v2-text-text-faint">
          page {props.page} of {pageCount()}
        </span>
        <button
          type="button"
          class="intel-table-control"
          data-action="intel-prev-page"
          disabled={props.page <= 1}
          onClick={() => props.onPage(props.page - 1)}
        >
          Prev
        </button>
        <button
          type="button"
          class="intel-table-control"
          data-action="intel-next-page"
          disabled={props.page >= pageCount()}
          onClick={() => props.onPage(props.page + 1)}
        >
          Next
        </button>
      </div>
    </Show>
  )
}
