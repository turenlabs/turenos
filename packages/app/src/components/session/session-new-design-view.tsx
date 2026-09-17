import type { JSX } from "solid-js"
import { ForgeLogo } from "@/launch/forge-logo"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <ForgeLogo class="w-full" />
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
