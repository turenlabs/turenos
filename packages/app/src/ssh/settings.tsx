import { useDialog } from "@turenlabs/ui/context/dialog"
import { Tag } from "@turenlabs/ui/v2/badge-v2"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Icon as IconV2 } from "@turenlabs/ui/v2/icon"
import { IconButtonV2 } from "@turenlabs/ui/v2/icon-button-v2"
import { MenuV2 } from "@turenlabs/ui/v2/menu-v2"
import { useMutation } from "@tanstack/solid-query"
import fuzzysort from "fuzzysort"
import { type Accessor, For, Show, createMemo } from "solid-js"
import type { useServerManagementController } from "@/components/dialog-select-server"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { showToast } from "@/utils/toast"
import { DialogAddSshServer } from "./dialog-add-ssh-server"
import { useSshServers } from "./context"
import type { SshServerRuntime } from "./types"

type Controller = ReturnType<typeof useServerManagementController>

export function isSshServer(server: ServerConnection.Any) {
  return server.type === "ssh"
}

export function sshRuntimeRetryable(runtime: SshServerRuntime) {
  return runtime.kind === "failed" || runtime.kind === "stopped"
}

export function useFilteredSshServers(filter: Accessor<string>) {
  const ssh = useSshServers()
  return createMemo(() => {
    const servers = ssh.data?.servers ?? []
    const query = filter().trim()
    if (!query) return servers
    return fuzzysort
      .go(query, servers, {
        keys: [(item) => item.config.displayName ?? "", (item) => item.config.host, (item) => item.config.id],
      })
      .map((x) => x.obj)
  })
}

export function SshServerSettings(props: {
  controller: Controller
  servers: ReturnType<typeof useFilteredSshServers>
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const ssh = useSshServers()
  const api = platform.sshServers

  const request = useMutation(() => ({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))

  const remove = (key: ServerConnection.Key) => {
    props.controller.confirmRemove(key)
  }

  const label = (item: { config: { displayName: string | null; hostname: string | null; host: string; user: string | null } }) =>
    item.config.displayName ??
    `${item.config.user ? item.config.user + "@" : ""}${item.config.hostname ?? item.config.host}`

  return (
    <Show when={api}>
      <For each={props.servers()}>
        {(item) => {
          const key = ServerConnection.Key.make(item.config.id)
          const check = () => ssh.data?.forgeChecks[item.config.id]
          const action = () => {
            const c = check()
            if (!c) return undefined
            if (c.error) return language.t("ssh.server.install")
            if (c.matchesDesktop === false) return language.t("ssh.server.update")
            return undefined
          }
          const busy = () => ssh.data?.job?.kind === "install-forge" && ssh.data.job.id === item.config.id
          return (
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <ServerHealthIndicator health={props.controller.status()[key]} />
                <div class="settings-v2-servers-copy">
                  <span class="flex min-w-0 items-center gap-1">
                    <span class="settings-v2-servers-name">{label(item)}</span>
                    <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                      {language.t("ssh.server.label")}
                    </span>
                  </span>
                  <span class="settings-v2-servers-meta">
                    <Show when={check()?.version}>{(version) => `v${version()}`}</Show>
                    <Show when={item.runtime.kind === "failed"}>
                      {(item.runtime as { kind: "failed"; message: string }).message}
                    </Show>
                  </span>
                </div>
              </div>
              <div class="settings-v2-servers-actions">
                <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                  <Tag>{language.t("dialog.server.status.default")}</Tag>
                </Show>
                <Show when={action()}>
                  {(label) => (
                    <ButtonV2
                      size="small"
                      disabled={busy() || request.isPending}
                      onClick={() => api && request.mutate(() => api.installForge(item.config.id))}
                    >
                      {busy() ? language.t("wsl.server.updating") : label()}
                    </ButtonV2>
                  )}
                </Show>
                <MenuV2 gutter={4} modal={false} placement="bottom-end">
                  <MenuV2.Trigger
                    as={IconButtonV2}
                    variant="ghost-muted"
                    size="small"
                    icon={<IconV2 name="outline-dots" />}
                    aria-label={language.t("common.moreOptions")}
                  />
                  <MenuV2.Portal>
                    <MenuV2.Content>
                      <MenuV2.Group>
                        <MenuV2.GroupLabel>{language.t("ssh.server.menu.label")}</MenuV2.GroupLabel>
                        <Show when={sshRuntimeRetryable(item.runtime)}>
                          <MenuV2.Item onSelect={() => api && request.mutate(() => api.startServer(key))}>
                            {language.t("ssh.server.retryStart")}
                          </MenuV2.Item>
                        </Show>
                        <Show when={item.runtime.kind === "ready"}>
                          <MenuV2.Item onSelect={() => api && request.mutate(() => api.stopRemote(item.config.id))}>
                            {language.t("ssh.server.stopRemote")}
                          </MenuV2.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() !== key}>
                          <MenuV2.Item onSelect={() => props.controller.setDefault(key)}>
                            {language.t("dialog.server.menu.default")}
                          </MenuV2.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                          <MenuV2.Item onSelect={() => props.controller.setDefault(null)}>
                            {language.t("dialog.server.menu.defaultRemove")}
                          </MenuV2.Item>
                        </Show>
                        <MenuV2.Separator />
                        <MenuV2.Item onSelect={() => remove(key)}>
                          {language.t("dialog.server.menu.delete")}
                        </MenuV2.Item>
                      </MenuV2.Group>
                    </MenuV2.Content>
                  </MenuV2.Portal>
                </MenuV2>
              </div>
            </div>
          )
        }}
      </For>
    </Show>
  )
}
