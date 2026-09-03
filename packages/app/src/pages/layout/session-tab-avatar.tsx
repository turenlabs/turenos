import type { LocalProject } from "@/context/layout"
import { getProjectAvatarVariant } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { ProjectAvatar } from "@turenlabs/ui/v2/project-avatar-v2"
import { Thinking } from "@turenlabs/ui/thinking"
import { Show } from "solid-js"

export function SessionTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  server: ServerConnection.Key
  revealProjectOnHover?: boolean
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionId,
  )
  const projectAvatar = () => (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color)}
      unread={state.unread()}
    />
  )
  return (
    <Show when={state.loading()} fallback={projectAvatar()}>
      <span class="relative block size-4 shrink-0">
        <span
          class={`absolute inset-0 flex items-center justify-center ${props.revealProjectOnHover === false ? "" : "group-hover:invisible"}`}
        >
          <Thinking state="working" size={20} aria-hidden="true" />
        </span>
        <Show when={props.revealProjectOnHover !== false}>
          <span class="invisible absolute inset-0 group-hover:visible">{projectAvatar()}</span>
        </Show>
      </span>
    </Show>
  )
}
