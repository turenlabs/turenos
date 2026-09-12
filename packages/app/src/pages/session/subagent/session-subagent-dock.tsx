import { Button } from "@turenlabs/ui/button"
import { DockTray } from "@turenlabs/ui/dock-surface"
import { Icon } from "@turenlabs/ui/icon"
import { IconButton } from "@turenlabs/ui/icon-button"
import { Thinking } from "@turenlabs/ui/thinking"
import { StatusIndicatorV2 } from "@turenlabs/ui/v2/status-indicator-v2"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import {
  formatSessionTaskDuration,
  sessionTaskActive,
  sessionTaskElapsedSeconds,
  sessionTaskStatusLabel,
  sessionTaskThinkingProfiles,
  type SessionTaskInfo,
} from "./session-subagent"
import type { ThinkingState } from "@turenlabs/ui/thinking"
import type { SessionSubagentController } from "./session-subagent-controller"
import type { SessionSwarmProgress } from "./session-subagent"
import { SessionSubagentRoom } from "./session-room"
import { SessionSwarmProgressView } from "./session-swarm-progress"

type SessionSubagentViewProps = {
  controller: SessionSubagentController
  swarm?: () => SessionSwarmProgress | undefined
  onOpenSession: (sessionID: string) => void
  onOpenParent: (sessionID: string) => void
  onRetryFromParent: (task: SessionTaskInfo) => void
}

export function SessionSubagentDock(props: SessionSubagentViewProps & { variant?: "dock" | "panel" }) {
  const language = useLanguage()
  const [store, setStore] = createStore({ collapsed: true })
  const tasks = createMemo(() =>
    props.controller.taskIDs().flatMap((id) => {
      const task = props.controller.task(id)
      return task ? [task] : []
    }),
  )
  const active = createMemo(() => tasks().filter(sessionTaskActive).length)
  const failed = createMemo(() => tasks().filter((task) => task.status === "failed").length)
  const shown = createMemo(
    () =>
      tasks().length > 0 ||
      !!props.controller.loadFailure() ||
      (props.variant === "panel" && props.controller.room() !== undefined),
  )
  const profiles = createMemo(() => sessionTaskThinkingProfiles(props.controller.taskIDs()))
  const toggle = () => setStore("collapsed", (value) => !value)

  return (
    <Show when={shown()}>
      <Show
        when={props.variant === "panel"}
        fallback={
          <DockTray
            attach="bottom"
            data-component="session-subagent-dock"
            data-active-count={active()}
            data-failed-count={failed()}
            data-rule={failed() > 0 ? "error" : active() > 0 ? "info" : "muted"}
          >
            <div class="flex min-h-10 items-center gap-2 py-2 pl-3 pr-2">
              <button
                type="button"
                data-action="session-subagent-toggle"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={!store.collapsed}
                onClick={toggle}
              >
                <Show when={active() > 0}>
                  <Thinking state="working" size={20} aria-hidden="true" class="shrink-0" />
                </Show>
                <span class="shrink-0 text-13-medium text-text-strong">{language.t("session.subagents.title")}</span>
                <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak" aria-live="polite">
                  {language.t("session.subagents.summary", { active: active(), total: tasks().length })}
                </span>
              </button>
              <Show when={props.controller.owner()}>
                {(owner) => (
                  <Button
                    size="small"
                    variant="ghost"
                    class="shrink-0"
                    onClick={() => props.onOpenParent(owner().parentSessionID)}
                  >
                    {language.t("session.subagents.backToParent")}
                  </Button>
                )}
              </Show>
              <IconButton
                icon="chevron-down"
                size="normal"
                variant="ghost"
                style={{ transform: `rotate(${store.collapsed ? 0 : 180}deg)` }}
                onClick={toggle}
                aria-label={language.t(store.collapsed ? "session.subagents.expand" : "session.subagents.collapse")}
              />
            </div>

            <Show when={!store.collapsed}>
              <div
                data-slot="session-subagent-list"
                class="flex max-h-72 flex-col gap-1 overflow-y-auto px-3 pb-7"
                aria-busy={props.controller.loading()}
              >
                <SessionSubagentLoadError controller={props.controller} />
                <SessionSubagentRows
                  controller={props.controller}
                  profiles={profiles}
                  onOpenSession={props.onOpenSession}
                  onRetryFromParent={props.onRetryFromParent}
                />
              </div>
            </Show>
            <Show when={store.collapsed}>
              <div class="h-5" aria-hidden="true" />
            </Show>
          </DockTray>
        }
      >
        <SessionSubagentPanel
          controller={props.controller}
          swarm={props.swarm}
          tasks={tasks}
          active={active}
          failed={failed}
          profiles={profiles}
          onOpenSession={props.onOpenSession}
          onOpenParent={props.onOpenParent}
          onRetryFromParent={props.onRetryFromParent}
        />
      </Show>
    </Show>
  )
}

function SessionSubagentPanel(props: {
  controller: SessionSubagentController
  swarm?: () => SessionSwarmProgress | undefined
  tasks: () => SessionTaskInfo[]
  active: () => number
  failed: () => number
  profiles: () => Record<string, ThinkingState>
  onOpenSession: (sessionID: string) => void
  onOpenParent: (sessionID: string) => void
  onRetryFromParent: (task: SessionTaskInfo) => void
}) {
  const language = useLanguage()
  const completed = createMemo(() => props.tasks().filter((task) => task.status === "completed").length)

  return (
    <section
      data-component="session-subagent-panel"
      data-active-count={props.active()}
      data-failed-count={props.failed()}
      class="flex h-full min-h-0 flex-col overflow-hidden rounded-surface border border-v2-border-border-muted bg-v2-background-bg-base"
    >
      <header class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-v2-border-border-muted px-4 py-3">
        <div class="flex min-w-48 flex-1 items-center gap-2">
          <Show when={props.active() > 0} fallback={<Icon name="subagent" size="normal" aria-hidden="true" />}>
            <Thinking state="working" size={20} aria-hidden="true" class="shrink-0" />
          </Show>
          <div class="min-w-0">
            <div class="truncate text-13-medium text-text-strong">{language.t("session.subagents.title")}</div>
            <div class="truncate text-11-regular text-text-weak" aria-live="polite">
              {language.t("session.subagents.summary", { active: props.active(), total: props.tasks().length })}
            </div>
          </div>
        </div>

        <dl class="flex min-w-0 flex-wrap items-center gap-y-1 text-10-regular uppercase tracking-wide text-text-weak">
          <div class="flex items-baseline gap-1 border-l border-border-weak-base px-3">
            <dt>Active</dt>
            <dd class="text-11-medium text-text-strong">{props.active()}</dd>
          </div>
          <div class="flex items-baseline gap-1 border-l border-border-weak-base px-3">
            <dt>Completed</dt>
            <dd class="text-11-medium text-text-strong">{completed()}</dd>
          </div>
          <div class="flex items-baseline gap-1 border-l border-border-weak-base px-3">
            <dt>Failed</dt>
            <dd class="text-11-medium text-text-strong">{props.failed()}</dd>
          </div>
          <div class="flex items-baseline gap-1 border-l border-border-weak-base px-3">
            <dt>Total</dt>
            <dd class="text-11-medium text-text-strong">{props.tasks().length}</dd>
          </div>
        </dl>

        <div class="ml-auto flex shrink-0 items-center">
          <Show when={props.controller.owner()}>
            {(owner) => (
              <Button
                size="small"
                variant="ghost"
                class="shrink-0"
                onClick={() => props.onOpenParent(owner().parentSessionID)}
              >
                {language.t("session.subagents.backToParent")}
              </Button>
            )}
          </Show>
        </div>
      </header>

      <div
        class="min-h-0 flex-1 overflow-y-auto px-4"
        aria-busy={props.controller.loading()}
      >
        <Show when={props.swarm?.()}>
          {(swarm) => <SessionSwarmProgressView progress={swarm()} surface="subagents" embedded />}
        </Show>
        <SessionSubagentLoadError controller={props.controller} panel />
        <Show when={props.controller.room() || props.controller.roomLoading() || props.controller.roomFailure()}>
          <SessionSubagentRoom controller={props.controller} />
        </Show>
        <Show
          when={props.tasks().length > 0}
          fallback={
            <p class="py-8 text-center text-13-regular text-text-weak">No background agents have been spawned.</p>
          }
        >
          <SessionSubagentRows
            controller={props.controller}
            profiles={props.profiles}
            panel
            onOpenSession={props.onOpenSession}
            onRetryFromParent={props.onRetryFromParent}
          />
        </Show>
      </div>
    </section>
  )
}

function SessionSubagentLoadError(props: { controller: SessionSubagentController; panel?: boolean }) {
  const language = useLanguage()

  return (
    <Show when={props.controller.loadFailure()}>
      {(failure) => (
        <div
          data-slot="session-subagent-load-error"
          classList={{
            "flex items-center gap-2": true,
            "mb-3 rounded-control border border-border-weak-base bg-surface-raised-base px-2.5 py-2": !props.panel,
            "flex-wrap border-b border-border-weak-base py-2.5": props.panel,
          }}
          role="alert"
        >
          <span class="min-w-0 flex-1 text-12-regular text-text-base">
            {language.t("session.subagents.loadError")}: {failure()}
          </span>
          <Button size="small" variant="secondary" onClick={() => void props.controller.refresh()}>
            {language.t("session.subagents.retryLoad")}
          </Button>
        </div>
      )}
    </Show>
  )
}

function SessionSubagentRows(props: {
  controller: SessionSubagentController
  profiles: () => Record<string, ThinkingState>
  panel?: boolean
  onOpenSession: (sessionID: string) => void
  onRetryFromParent: (task: SessionTaskInfo) => void
}) {
  return (
    <div class={props.panel ? "min-w-0" : "flex flex-col gap-1"}>
      <Show when={props.panel}>
        <div
          data-slot="session-subagent-table-header"
          class="hidden grid-cols-[minmax(12rem,2fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_minmax(7rem,auto)_minmax(7rem,auto)_auto] gap-3 border-b border-border-weak-base px-3 py-2 text-10-medium uppercase tracking-wide text-text-weak xl:grid"
          aria-hidden="true"
        >
          <span>Task</span>
          <span>Specialist / role</span>
          <span>Model</span>
          <span>Elapsed</span>
          <span>Status</span>
          <span class="text-right">Actions</span>
        </div>
      </Show>
      <For each={props.controller.taskIDs()}>
        {(taskID) => (
          <Show when={props.controller.task(taskID)}>
            {(task) => (
              <SessionSubagentRow
                task={task}
                profile={() => props.profiles()[taskID] ?? "working"}
                panel={props.panel}
                selected={() => props.controller.sessionID() === task().childSessionID}
                cancelPending={() => props.controller.cancelPending(taskID)}
                cancelFailure={() => props.controller.cancelFailure(taskID)}
                onCancel={() => void props.controller.cancel(taskID)}
                onDismissCancelFailure={() => props.controller.dismissCancelFailure(taskID)}
                onOpenSession={props.onOpenSession}
                onRetryFromParent={props.onRetryFromParent}
              />
            )}
          </Show>
        )}
      </For>
    </div>
  )
}

function SessionSubagentRow(props: {
  task: () => SessionTaskInfo
  profile: () => ThinkingState
  panel?: boolean
  selected: () => boolean
  cancelPending: () => boolean
  cancelFailure: () => string | undefined
  onCancel: () => void
  onDismissCancelFailure: () => void
  onOpenSession: (sessionID: string) => void
  onRetryFromParent: (task: SessionTaskInfo) => void
}) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  const task = props.task
  const active = createMemo(() => sessionTaskActive(task()))
  const evidence = createMemo(() => task().error ?? task().result)
  const evidenceLabel = createMemo(() =>
    task().error ? language.t("session.subagents.errorEvidence") : language.t("session.subagents.resultEvidence"),
  )
  const status = createMemo(() => language.t(sessionTaskStatusLabel(task().status)))
  const elapsed = createMemo(() => formatSessionTaskDuration(sessionTaskElapsedSeconds(task(), now())))

  createEffect(() => {
    if (!active()) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <article
      data-component="session-subagent-row"
      data-task-id={task().id}
      data-status={task().status}
      data-thinking-profile={props.profile()}
      data-selected={props.selected() ? "true" : "false"}
      aria-current={props.selected() ? "true" : undefined}
      classList={{
        "min-w-0": true,
        "rounded-control border px-2.5 py-2": !props.panel,
        "border-border-strong-base bg-surface-raised-base": !props.panel && props.selected(),
        "border-border-weak-base bg-background-base": !props.panel && !props.selected(),
        "border-b border-border-weak-base": props.panel,
        "bg-surface-raised-base/50": props.panel && props.selected(),
      }}
      style={{ "margin-left": props.panel ? undefined : `${Math.min(task().depth, 2) * 0.75}rem` }}
    >
      <Show
        when={props.panel}
        fallback={
          <div class="flex min-w-0 items-start gap-2">
            <Show when={active()}>
              <Thinking state={props.profile()} size={20} aria-hidden="true" class="mt-0.5 shrink-0" />
            </Show>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  data-slot="session-subagent-description"
                  class="min-w-0 flex-1 truncate text-13-medium text-text-strong"
                >
                  {task().description}
                </span>
                <span
                  data-slot="session-subagent-status"
                  classList={{
                    "shrink-0 rounded-control px-2 py-0.5 text-11-medium": true,
                    "bg-surface-raised-base text-text-base": active(),
                    "bg-success-base/15 text-success-base": task().status === "completed",
                    "bg-critical-base/15 text-critical-base": task().status === "failed",
                    "bg-surface-raised-base text-text-weak":
                      task().status === "cancelled" || task().status === "interrupted",
                  }}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {status()}
                </span>
              </div>
              <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11-regular text-text-weak">
                <span data-slot="session-subagent-specialist">
                  {language.t("session.subagents.specialist", { specialist: task().agent })}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {language.t(
                    task().parentTaskID
                      ? "session.subagents.relationship.child"
                      : "session.subagents.relationship.root",
                  )}
                </span>
                <span aria-hidden="true">·</span>
                <span data-slot="session-subagent-elapsed">
                  {language.t("session.subagents.elapsed", { elapsed: elapsed() })}
                </span>
                <Show when={task().model}>
                  {(model) => (
                    <>
                      <span aria-hidden="true">·</span>
                      <span class="max-w-52 truncate">{model().id}</span>
                    </>
                  )}
                </Show>
              </div>
            </div>
            <SessionSubagentActions
              task={task}
              active={active}
              selected={props.selected}
              cancelPending={props.cancelPending}
              onCancel={props.onCancel}
              onOpenSession={props.onOpenSession}
              onRetryFromParent={props.onRetryFromParent}
            />
          </div>
        }
      >
        <div class="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,2fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_minmax(7rem,auto)_minmax(7rem,auto)_auto] xl:items-center">
          <div
            class="flex min-w-0 items-start gap-2 sm:col-span-2 xl:col-span-1"
            style={{ "padding-left": `${Math.min(task().depth, 2) * 0.75}rem` }}
          >
            <Show when={active()}>
              <Thinking state={props.profile()} size={20} aria-hidden="true" class="shrink-0" />
            </Show>
            <span data-slot="session-subagent-description" class="min-w-0 break-words text-12-medium text-text-strong">
              {task().description}
            </span>
          </div>
          <div class="flex min-w-0 flex-wrap gap-x-1 text-11-regular text-text-weak">
            <span data-slot="session-subagent-specialist" class="truncate">
              {language.t("session.subagents.specialist", { specialist: task().agent })}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {language.t(
                task().parentTaskID ? "session.subagents.relationship.child" : "session.subagents.relationship.root",
              )}
            </span>
          </div>
          <span data-slot="session-subagent-model" class="min-w-0 truncate text-11-regular text-text-weak">
            {task().model?.id ?? "—"}
          </span>
          <span data-slot="session-subagent-elapsed" class="text-11-regular text-text-weak">
            {language.t("session.subagents.elapsed", { elapsed: elapsed() })}
          </span>
          <StatusIndicatorV2
            data-slot="session-subagent-status"
            tone={
              active()
                ? "info"
                : task().status === "completed"
                  ? "success"
                  : task().status === "failed"
                    ? "danger"
                    : "neutral"
            }
            live
            aria-atomic="true"
          >
            {status()}
          </StatusIndicatorV2>
          <SessionSubagentActions
            task={task}
            active={active}
            selected={props.selected}
            cancelPending={props.cancelPending}
            onCancel={props.onCancel}
            onOpenSession={props.onOpenSession}
            onRetryFromParent={props.onRetryFromParent}
            panel
          />
        </div>
      </Show>

      <Show when={evidence()}>
        {(value) => (
          <details
            classList={{
              "mt-2": !props.panel,
              "mx-3 mb-3 border-t border-border-weak-base pt-2": props.panel,
            }}
            open={task().status === "failed"}
          >
            <summary class="cursor-pointer text-11-medium text-text-base">{evidenceLabel()}</summary>
            <pre
              data-slot="session-subagent-evidence"
              classList={{
                "mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-terminal text-11-regular text-text-base": true,
                "rounded-control bg-surface-raised-base": !props.panel,
                "border-l border-border-strong-base bg-transparent": props.panel,
              }}
            >
              {value()}
            </pre>
          </details>
        )}
      </Show>

      <Show when={props.cancelFailure()}>
        {(failure) => (
          <div
            data-slot="session-subagent-cancel-error"
            classList={{
              "flex items-center gap-2": true,
              "mt-2 rounded-control border border-critical-base/30 bg-critical-base/5 px-2 py-1.5": !props.panel,
              "mx-3 mb-3 flex-wrap border-t border-critical-base/30 pt-2": props.panel,
            }}
            role="alert"
          >
            <span class="min-w-0 flex-1 text-11-regular text-text-base">
              {language.t("session.subagents.cancelError")}: {failure()}
            </span>
            <Button size="small" variant="secondary" onClick={props.onCancel}>
              {language.t("session.subagents.retryCancel")}
            </Button>
            <Button size="small" variant="ghost" onClick={props.onDismissCancelFailure}>
              {language.t("common.dismiss")}
            </Button>
          </div>
        )}
      </Show>
    </article>
  )
}

function SessionSubagentActions(props: {
  task: () => SessionTaskInfo
  active: () => boolean
  selected: () => boolean
  cancelPending: () => boolean
  onCancel: () => void
  onOpenSession: (sessionID: string) => void
  onRetryFromParent: (task: SessionTaskInfo) => void
  panel?: boolean
}) {
  const language = useLanguage()

  return (
    <div
      classList={{
        "flex shrink-0 items-center gap-1": true,
        "flex-wrap sm:col-span-2 sm:justify-end xl:col-span-1": props.panel,
      }}
    >
      <Show when={!props.selected()}>
        <Button size="small" variant="ghost" onClick={() => props.onOpenSession(props.task().childSessionID)}>
          {language.t("session.subagents.openChild")}
        </Button>
      </Show>
      <Show when={props.active()}>
        <Button size="small" variant="secondary" disabled={props.cancelPending()} onClick={props.onCancel}>
          {language.t(props.cancelPending() ? "session.subagents.cancelling" : "common.cancel")}
        </Button>
      </Show>
      <Show when={props.task().status === "failed"}>
        <Button size="small" variant="ghost" onClick={() => props.onRetryFromParent(props.task())}>
          {language.t("session.subagents.retryFromParent")}
        </Button>
      </Show>
    </div>
  )
}
