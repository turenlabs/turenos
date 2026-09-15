import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames, type IconName } from "./provider-icons/types"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

// Provider IDs without their own sprite glyph resolve to the closest brand mark.
const aliases: Record<string, IconName> = {
  "claude-code": "anthropic",
  ollama: "ollama-cloud",
  "llama-cpp": "llama",
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(
    () => aliases[local.id] ?? (iconNames.includes(local.id as IconName) ? (local.id as IconName) : "synthetic"),
  )
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`${sprite}#${resolved()}`} />
    </svg>
  )
}
