import { For, Show, onMount } from "solid-js"
import { Dialog } from "@turenlabs/ui/dialog"
import { Button } from "@turenlabs/ui/button"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { releaseNotesUrl, type ReleaseNote } from "@/release-notes"

export function DialogReleaseNotes(props: { releases: readonly ReleaseNote[]; onShown?: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const current = props.releases[0]
  if (!current) return null

  onMount(() => props.onShown?.())

  return (
    <Dialog
      title={language.t("dialog.releaseNotes.title", { version: current.version })}
      description={language.t("dialog.releaseNotes.description")}
      size="large"
      fit
    >
      <div data-component="release-notes" class="flex flex-col min-h-0">
        <div class="flex flex-col gap-6 px-6 py-4 overflow-y-auto max-h-[55vh]">
          <For each={props.releases}>
            {(release) => (
              <section class="flex flex-col gap-4">
                <Show when={props.releases.length > 1}>
                  <h2 class="text-14-medium text-text-strong">{release.version}</h2>
                </Show>
                <p class="text-14-regular text-text-base">{release.summary}</p>
                <For each={["new", "improved", "fixed"] as const}>
                  {(category) => (
                    <Show when={release.changes[category].length > 0}>
                      <div class="flex flex-col gap-2">
                        <h3 class="text-12-medium text-text-strong">
                          {language.t(`dialog.releaseNotes.category.${category}`)}
                        </h3>
                        <ul class="list-disc pl-5 flex flex-col gap-2 text-14-regular text-text-base">
                          <For each={release.changes[category]}>{(change) => <li>{change}</li>}</For>
                        </ul>
                      </div>
                    </Show>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border-weak-base px-6 py-4">
          <Button variant="ghost" onClick={() => platform.openLink(releaseNotesUrl(current.version))}>
            {language.t("dialog.releaseNotes.action.fullNotes")}
          </Button>
          <Button variant="primary" autofocus onClick={() => dialog.close()}>
            {language.t("dialog.releaseNotes.action.close")}
          </Button>
          <Button
            variant="ghost"
            size="small"
            class="w-full"
            onClick={() => {
              settings.general.setReleaseNotes(false)
              dialog.close()
            }}
          >
            {language.t("dialog.releaseNotes.action.hideFuture")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
