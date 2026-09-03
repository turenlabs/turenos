import { A, useLocation } from "@solidjs/router"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { createEffect, For, Show, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useCommandPalette } from "@/context/command"
import { useLanguage } from "@/context/language"
import { PageHeader } from "@/components/page-header"
import { Persist, persisted } from "@/utils/persist"
import { analysisDestinationFromPathname, type AnalysisDestination } from "./analysis-state"

type AnalysisLastTabState = { destination?: AnalysisDestination }

// Remembers which Workbench tab (AppSec / Pentest) was last
// active, the way tabs.recent remembers the last active session tab (see
// context/tabs.tsx). Global, not per-workspace/session: unlike session tabs,
// Workbench's sub-navigation isn't tied to any particular directory or
// session, so it follows the same scope nav.rail.v1 already uses for shell
// chrome state (packages/app/src/components/nav-rail.tsx).
export function useAnalysisLastTab() {
  const [state, setState, , ready] = persisted(
    Persist.global("analysis.last-tab"),
    createStore<AnalysisLastTabState>({}),
  )
  const get = () =>
    state.destination === "appsec" || state.destination === "pen-testing" ? state.destination : undefined
  return {
    ready,
    get,
    remember: (destination: AnalysisDestination) => {
      if (state.destination !== destination) setState("destination", destination)
    },
  }
}

const NAV_ITEM =
  "flex h-8 shrink-0 items-center rounded-[7px] px-3 text-[13px] text-v2-text-text-muted [font-weight:520] outline-none transition-[background-color,color,box-shadow] hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-focus)]"
const NAV_ITEM_ACTIVE =
  "bg-v2-background-bg-layer-02 text-v2-text-text-base [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
const PAGE_CONTENT = "mx-auto flex min-h-full w-full max-w-[1180px] flex-col px-5 py-6 sm:px-8 sm:py-8"

export function AnalysisShell(props: ParentProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const location = useLocation()
  const lastTab = useAnalysisLastTab()
  const destination = () => analysisDestinationFromPathname(location.pathname)

  // Every real visit to a Workbench tab remembers itself as "last active", so
  // the Workbench entry point (AnalysisIndexRedirect in app.tsx) can restore
  // it instead of always landing on AppSec.
  createEffect(() => {
    const current = destination()
    if (current) lastTab.remember(current)
  })

  const items = () =>
    [
      {
        id: "appsec",
        href: "/analysis/appsec",
        label: language.t("analysis.navigation.appSec"),
      },
      {
        id: "pen-testing",
        href: "/analysis/pen-testing",
        label: language.t("analysis.navigation.penTesting"),
      },
    ] satisfies Array<{ id: AnalysisDestination; href: string; label: string }>

  useCommandPalette(() => {
    void import("@/components/dialog-command-palette-v2").then(({ DialogCommandOnlyPaletteV2 }) => {
      void dialog.show(() => <DialogCommandOnlyPaletteV2 />)
    })
  })

  return (
    <section data-component="analysis" class="flex h-full min-h-0 w-full min-w-0 flex-col bg-v2-background-bg-base">
      <header
        data-component="analysis-navigation"
        class="flex h-[52px] w-full shrink-0 items-center gap-3 border-b border-v2-border-border-subtle bg-v2-background-bg-base px-3 sm:px-5"
      >
        <span class="hidden shrink-0 text-[13px] text-v2-text-text-base [font-weight:620] sm:block">
          {language.t("analysis.title")}
        </span>
        <span aria-hidden="true" class="hidden h-4 w-px shrink-0 bg-v2-border-border-subtle sm:block" />
        <nav
          aria-label={language.t("analysis.navigation.label")}
          class="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div class="flex min-w-max items-center gap-1">
            <For each={items()}>
              {(item) => (
                <A
                  href={item.href}
                  class={NAV_ITEM}
                  classList={{ [NAV_ITEM_ACTIVE]: destination() === item.id }}
                  aria-current={destination() === item.id ? "page" : undefined}
                >
                  {item.label}
                </A>
              )}
            </For>
          </div>
        </nav>
      </header>
      <div class="min-h-0 min-w-0 flex-1">{props.children}</div>
    </section>
  )
}

export function AnalysisPage(
  props: ParentProps<{
    component: "analysis-placeholder" | "pentest"
    destination?: AnalysisDestination
  }>,
) {
  return (
    <section
      data-component={props.component}
      data-destination={props.destination}
      data-analysis-layout="page"
      class="h-full w-full overflow-y-auto bg-v2-background-bg-base"
    >
      <div data-component="analysis-page-content" data-layout-contract="analysis-page-v1" class={PAGE_CONTENT}>
        {props.children}
      </div>
    </section>
  )
}

export function AnalysisPageHeader(props: {
  eyebrow: string
  title: string
  description: string
  actions?: JSX.Element
}) {
  return (
    <PageHeader eyebrow={props.eyebrow} title={props.title} description={props.description} actions={props.actions} />
  )
}

export function AppSecPage() {
  const language = useLanguage()
  return (
    <AnalysisPlaceholder
      destination="appsec"
      title={language.t("analysis.appSec.title")}
      description={language.t("analysis.appSec.description")}
    />
  )
}

function AnalysisPlaceholder(props: { destination: AnalysisDestination; title: string; description: string }) {
  const language = useLanguage()
  return (
    <AnalysisPage component="analysis-placeholder" destination={props.destination}>
      <AnalysisPageHeader
        eyebrow={language.t("analysis.placeholder.eyebrow")}
        title={props.title}
        description={props.description}
      />
      <div data-component="analysis-page-body" class="py-6">
        <div class="max-w-2xl rounded-[10px] border border-v2-border-border-subtle bg-v2-background-bg-layer-01 p-5">
          <div class="flex items-center justify-between gap-4">
            <strong class="text-[13px] text-v2-text-text-base [font-weight:580]">
              {language.t("analysis.placeholder.status.label")}
            </strong>
            <span
              role="status"
              class="rounded-full border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2.5 py-1 text-[11px] text-v2-text-text-muted [font-weight:600]"
            >
              {language.t("analysis.placeholder.status.planned")}
            </span>
          </div>
          <p class="mt-3 text-[13px] leading-5 text-v2-text-text-muted">
            {language.t("analysis.placeholder.status.description")}
          </p>
        </div>
      </div>
    </AnalysisPage>
  )
}
