import type { JSX } from "solid-js"
import { ForgeLogo } from "@/launch/forge-logo"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-y-auto bg-v2-background-bg-deep">
      <div class="absolute inset-x-0 top-[clamp(1rem,calc(50dvh-272.5px),25.375%)] flex justify-center px-6 pb-4 [@media(max-width:480px)]:top-[clamp(1rem,calc(50dvh-305px),25.375%)]">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <ForgeLogo class="w-full [@media(max-height:760px)]:mx-auto [@media(max-height:760px)]:max-w-[440px]" />
          <div class="mt-8 [@media(max-height:760px)]:mt-4">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
