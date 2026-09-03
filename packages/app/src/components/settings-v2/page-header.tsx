import type { Component, JSX, ParentProps } from "solid-js"
import { Show } from "solid-js"

export const SettingsPageHeaderV2: Component<
  ParentProps<{
    title: string
    description?: string
    scope?: string
    actions?: JSX.Element
    stacked?: boolean
    class?: string
  }>
> = (props) => (
  <div
    class={`settings-v2-tab-header settings-v2-page-header${props.class ? ` ${props.class}` : ""}`}
    classList={{ "settings-v2-tab-header--stacked": props.stacked }}
  >
    <div class="settings-v2-tab-header-row">
      <div class="settings-v2-page-header-copy">
        <h2 class="settings-v2-tab-title">{props.title}</h2>
        <Show when={props.description}>
          {(description) => <p class="settings-v2-page-description">{description()}</p>}
        </Show>
      </div>
      <Show when={props.scope || props.actions}>
        <div class="settings-v2-page-header-actions">
          <Show when={props.scope}>{(scope) => <span class="settings-v2-scope-badge">{scope()}</span>}</Show>
          {props.actions}
        </div>
      </Show>
    </div>
    {props.children}
  </div>
)
