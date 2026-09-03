import { splitProps, type ComponentProps } from "solid-js"
import "./status-indicator-v2.css"

export type StatusIndicatorV2Tone = "neutral" | "info" | "success" | "warning" | "danger"

export interface StatusIndicatorV2Props extends ComponentProps<"span"> {
  tone?: StatusIndicatorV2Tone
  shape?: "dot" | "bar"
  live?: boolean
}

export function StatusIndicatorV2(props: StatusIndicatorV2Props) {
  const [local, rest] = splitProps(props, ["tone", "shape", "live", "class", "classList"])

  return (
    <span
      {...rest}
      data-component="status-indicator-v2"
      data-tone={local.tone ?? "neutral"}
      data-shape={local.shape ?? "dot"}
      role={local.live ? "status" : rest.role}
      aria-live={local.live ? "polite" : rest["aria-live"]}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    />
  )
}
