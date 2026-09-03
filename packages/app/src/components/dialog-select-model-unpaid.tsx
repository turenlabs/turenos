import { Button } from "@turenlabs/ui/button"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { Dialog } from "@turenlabs/ui/dialog"
import { List, type ListRef } from "@turenlabs/ui/list"
import { Tag } from "@turenlabs/ui/tag"
import { Tooltip } from "@turenlabs/ui/tooltip"
import { type Component, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useLocal } from "@/context/local"
import { isRemovedProvider } from "@/hooks/use-providers"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"

type ModelState = ReturnType<typeof useLocal>["model"]

export const DialogSelectModelUnpaid: Component<{ model?: ModelState }> = (props) => {
  const local = useLocal()
  const model = props.model ?? local.model
  const dialog = useDialog()
  const navigate = useNavigate()
  const language = useLanguage()

  const openProviders = () => {
    dialog.close()
    navigate("/extend/catalog?kind=provider")
  }

  let listRef: ListRef | undefined
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="overflow-y-auto [&_[data-slot=dialog-body]]:overflow-visible [&_[data-slot=dialog-body]]:flex-none"
    >
      <div class="flex flex-col gap-3 px-2.5" onKeyDown={handleKeyDown}>
        <div class="text-14-medium text-text-base px-2.5">{language.t("dialog.model.select.title")}</div>
        <List
          class="px-3 [&_[data-slot=list-scroll]]:overflow-visible"
          ref={(ref) => (listRef = ref)}
          items={() => model.list().filter((item) => !isRemovedProvider(item.provider.id))}
          current={model.current()}
          key={(x) => `${x.provider.id}:${x.id}`}
          itemWrapper={(item, node) => (
            <Tooltip
              class="w-full"
              placement="right-start"
              gutter={12}
              value={<ModelTooltip model={item} latest={item.latest} />}
            >
              {node}
            </Tooltip>
          )}
          onSelect={(x) => {
            model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
              recent: true,
            })
            dialog.close()
          }}
        >
          {(i) => (
            <div class="w-full flex items-center gap-x-2.5">
              <span>{i.name}</span>
              <Show when={i.latest}>
                <Tag>{language.t("model.tag.latest")}</Tag>
              </Show>
            </div>
          )}
        </List>
      </div>
      <div class="px-1.5 pb-1.5">
        <div class="w-full rounded-sm border border-border-weak-base bg-surface-raised-base">
          <div class="w-full flex flex-col items-start gap-4 px-1.5 pt-4 pb-4">
            <div class="px-2 text-14-medium text-text-base">{language.t("dialog.model.unpaid.addMore.title")}</div>
            <Button
              variant="ghost"
              class="w-full justify-start px-[11px] py-3.5 gap-4.5 text-14-medium"
              icon="dot-grid"
              onClick={openProviders}
            >
              {language.t("dialog.provider.viewAll")}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
