import { Show, type JSX } from "solid-js"
import { useHighlights } from "@/context/highlights"
import { useLanguage } from "@/context/language"

export function SettingsReleaseNotes(props: {
  children: (title: string, description: string, open: () => void) => JSX.Element
}) {
  const highlights = useHighlights()
  const language = useLanguage()

  return (
    <Show when={highlights.available()}>
      {props.children(
        language.t("settings.general.releaseNotes.open"),
        language.t("settings.general.releaseNotes.open.description"),
        () => void highlights.open(),
      )}
    </Show>
  )
}
