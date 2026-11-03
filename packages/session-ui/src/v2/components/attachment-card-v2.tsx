import type { JSX } from "solid-js"
import "./attachment-card-v2.css"

/** Shared 160px two-line card used by v2 file and comment attachments in the composer and timeline. */
export function AttachmentCardV2(props: {
  title: string
  active?: boolean
  clickable?: boolean
  wide?: boolean
  surface?: "base"
  /** native title attribute */
  hover?: string
  titleRef?: (element: HTMLSpanElement) => void
  onClick?: () => void
  children: JSX.Element
}) {
  const interactive = () => !!props.clickable && !!props.onClick
  return (
    <div
      data-component="attachment-card-v2"
      data-active={props.active ? "true" : undefined}
      data-clickable={props.clickable ? "true" : undefined}
      data-wide={props.wide ? "true" : undefined}
      data-surface={props.surface}
      title={props.hover}
      role={interactive() ? "button" : undefined}
      tabIndex={interactive() ? 0 : undefined}
      onClick={() => {
        if (interactive()) props.onClick?.()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !interactive()) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        if (event.key === "Enter" && !event.repeat) event.currentTarget.click()
      }}
      onKeyUp={(event) => {
        if (event.target !== event.currentTarget || !interactive() || event.key !== " ") return
        event.preventDefault()
        event.currentTarget.click()
      }}
    >
      <span ref={(element) => props.titleRef?.(element)} data-slot="attachment-card-v2-title">
        {props.title}
      </span>
      <span data-slot="attachment-card-v2-subtitle">{props.children}</span>
    </div>
  )
}
