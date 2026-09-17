import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { SessionGoalDock } from "@/pages/session/goal/session-goal-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"
import "./composer-terminal.css"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
  subagents?: JSX.Element
  liveDock?: JSX.Element
}) {
  const language = useLanguage()
  const controller = props.controller
  const settings = useSettings()
  const todoDockProgress = () => (settings.general.newLayoutDesigns() ? 0 : controller.dockProgress())
  const rolled = () => {
    const revert = controller.revert()
    return revert?.items.length ? revert : undefined
  }

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none": true,
        "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
        "bg-background-stronger": !settings.general.newLayoutDesigns(),
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
      >
        {props.subagents}

        <Show
          when={
            controller.child() || !settings.general.newLayoutDesigns()
              ? controller.state.questionRequest()
              : undefined
          }
          keyed
        >
          {(request) => (
            <div data-prevent-autofocus>
              <SessionQuestionDock request={request} onSubmit={controller.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={controller.state.permissionRequest()} keyed>
          {(request) => (
            <div data-prevent-autofocus>
              <SessionPermissionDock
                request={request}
                responding={controller.state.permissionResponding()}
                onDecide={(response) => {
                  controller.onResponseSubmit()
                  controller.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show
          when={
            controller.state.blocked() &&
            !controller.child() &&
            !(settings.general.newLayoutDesigns() && controller.state.questionRequest())
          }
        >
          <p data-component="session-request-guidance" class="px-1 pb-2 text-12-regular text-text-weak">
            {language.t(
              controller.state.permissionRequest()
                ? "session.permission.redirectHint"
                : "session.question.redirectHint",
            )}
          </p>
        </Show>
        <Show when={!settings.general.newLayoutDesigns() && controller.dock()}>
          <div
            classList={{
              "overflow-hidden": true,
              "pointer-events-none": todoDockProgress() < 0.98,
            }}
            style={{
              "max-height": `${controller.dockHeight() * todoDockProgress()}px`,
            }}
          >
            <div ref={controller.setDockBodyRef}>
              <SessionTodoDock
                todos={controller.state.todos()}
                collapsed={controller.todo.collapsed()}
                onToggle={controller.todo.onToggle}
                onClear={controller.state.clearTodos}
                clearLabel={`${language.t("common.clear")} ${language.t("session.todo.title")}`}
                collapseLabel={language.t("session.todo.collapse")}
                expandLabel={language.t("session.todo.expand")}
                dockProgress={todoDockProgress()}
              />
            </div>
          </div>
        </Show>
        <Show
          when={controller.promptReady()}
          fallback={
            <>
              <Show when={rolled()} keyed>
                {(revert) => (
                  <div class="pb-2">
                    <SessionRevertDock
                      items={revert.items}
                      restoring={revert.restoring}
                      disabled={revert.disabled}
                      onRestore={revert.onRestore}
                    />
                  </div>
                )}
              </Show>
              <div
                class="w-full min-h-20 md:min-h-24 rounded-[2px] border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none"
                style={{ "margin-top": `${-36 * todoDockProgress()}px` }}
              >
                {controller.handoffPrompt() || language.t("prompt.loading")}
              </div>
            </>
          }
        >
          <Show when={rolled()} keyed>
            {(revert) => (
              <div
                style={{
                  "margin-top": `${-36 * todoDockProgress()}px`,
                }}
              >
                <SessionRevertDock
                  items={revert.items}
                  restoring={revert.restoring}
                  disabled={revert.disabled}
                  onRestore={revert.onRestore}
                />
              </div>
            )}
          </Show>
          <Show when={controller.child() && controller.promptReady() && props.liveDock}>
            <div class="flex w-full justify-center pb-1">{props.liveDock}</div>
          </Show>
          <div
            class="relative z-[70]"
            style={{
              "margin-top": `${-36 * todoDockProgress()}px`,
            }}
          >
            <Show when={!settings.general.newLayoutDesigns() && controller.goal()}>
              <SessionGoalDock
                goal={controller.goal()!.goal}
                disabled={controller.goal()!.pending}
                editRequest={controller.goal()!.editRequest}
                onEdit={controller.goal()!.onEdit}
                onPause={controller.goal()!.onPause}
                onResume={controller.goal()!.onResume}
                onClear={controller.goal()!.onClear}
              />
            </Show>
            <Show when={controller.followup()}>
              {(followup) => (
                <SessionFollowupDock
                  items={followup().items}
                  disabled={followup().pending}
                  onSend={followup().onSend}
                  onEdit={followup().onEdit}
                />
              )}
            </Show>
            <div class="flex w-full flex-col gap-2 @[48rem]:flex-row @[48rem]:items-end">
              <div class="min-w-0 flex-1">
                <Show when={controller.child()} fallback={props.promptInput}>
                  <div
                    ref={controller.setPromptRef}
                    class="w-full rounded-[2px] border border-border-weak-base bg-background-base p-3 text-[12.5px] leading-5 text-text-weak"
                  >
                    <span>{language.t("session.child.promptDisabled")} </span>
                    <Show when={controller.parentID()}>
                      <button
                        type="button"
                        class="text-text-base transition-colors hover:text-text-strong"
                        onClick={controller.openParent}
                      >
                        {language.t("session.child.backToParent")}
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <Show when={props.liveDock && !controller.promptReady()}>{props.liveDock}</Show>
      </div>
    </div>
  )
}
