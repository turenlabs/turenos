import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "@turenlabs/ui/context"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { DialogReleaseNotes } from "@/components/dialog-release-notes"
import { releaseNotesFor, type ReleaseNote } from "@/release-notes"

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  init: () => {
    const platform = usePlatform()
    const dialog = useDialog()
    const settings = useSettings()
    const notes = platform.releaseNotes
    const current = releaseNotesFor(platform.version ?? "")
    const [state, setState] = createStore({
      attempted: false,
      viewed: false,
      visible: document.visibilityState !== "hidden",
      pending: [] as readonly ReleaseNote[],
    })
    let disposed = false

    const failed = () => console.warn("Could not save release-note state; it will be retried on the next launch.")
    const shown = () => {
      setState({ viewed: true, pending: [] })
      void notes?.shown().catch(failed)
    }

    makeEventListener(document, "visibilitychange", () => setState("visible", document.visibilityState !== "hidden"))
    onCleanup(() => {
      disposed = true
      void notes?.release().catch(failed)
    })

    createEffect(() => {
      if (!notes || !current.length || state.attempted) return
      if (!settings.ready() || !notes.ready() || !state.visible || dialog.active) return
      setState("attempted", true)
      void notes
        .claim(settings.general.releaseNotes())
        .then((claim) => {
          if (disposed || !claim) return
          if (state.viewed) return notes.shown()
          setState("pending", releaseNotesFor(platform.version ?? "", claim.previous))
          if (!state.pending.length) return notes.release()
        })
        .catch(failed)
    })

    createEffect(() => {
      if (!state.pending.length || state.viewed) return
      if (!settings.general.releaseNotes()) {
        setState("pending", [])
        void notes
          ?.release()
          .then(() => notes.claim(false))
          .catch(failed)
        return
      }
      if (!settings.ready() || !notes?.ready() || !state.visible || dialog.active) return
      const releases = state.pending
      void dialog
        .showIfIdle(
          () => <DialogReleaseNotes releases={releases} onShown={shown} />,
          () =>
            !disposed &&
            !state.viewed &&
            state.visible &&
            settings.ready() &&
            notes.ready() &&
            settings.general.releaseNotes(),
        )
        .catch(failed)
    })

    return {
      available: () => current.length > 0,
      open: () => {
        if (!current.length) return
        return dialog.push(() => <DialogReleaseNotes releases={current} onShown={shown} />)
      },
    }
  },
})
