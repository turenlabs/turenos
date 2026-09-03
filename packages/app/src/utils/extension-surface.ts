import type { ExtensionItem } from "@turenlabs/sdk/v2/client"

export const YOLK_EXTENSION_ID = "turenlabs/yolk"

export function yolkExtension(items: ReadonlyArray<ExtensionItem>) {
  return items.find((item) => item.manifest.id === YOLK_EXTENSION_ID)
}

export function settingsOwnedExtension(item: ExtensionItem) {
  return item.manifest.id === YOLK_EXTENSION_ID
}
