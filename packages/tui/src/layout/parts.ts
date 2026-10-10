import type { BoxRenderable, TextRenderable } from "@opentui/core"
import type { createActions } from "./actions"
import type { createFooter } from "./footer"
import type { createMain } from "./main"
import type { createSidebar, createTabButtons } from "./sidebar"
import type { createTopbar } from "./topbar"

/** Every renderable the layout creates, including the ones it does not expose. */
export type LayoutParts = {
  root: BoxRenderable
  body: BoxRenderable
  sizeNotice: BoxRenderable
  sizeText: TextRenderable
  tabButtons: ReturnType<typeof createTabButtons>
} & ReturnType<typeof createTopbar> &
  ReturnType<typeof createSidebar> &
  ReturnType<typeof createMain> &
  ReturnType<typeof createActions> &
  ReturnType<typeof createFooter>
