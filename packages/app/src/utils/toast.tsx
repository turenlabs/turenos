import { Icon, type IconProps } from "@turenlabs/ui/icon"
import { Toast, showToast as showLegacyToast, type ToastOptions, type ToastVariant } from "@turenlabs/ui/toast"
import { ToastV2, showToastV2 } from "@turenlabs/ui/v2/toast-v2"

let v2 = false

export function setV2Toast(value: boolean) {
  v2 = value
}

export function ToastRegion(props: { v2: boolean }) {
  if (props.v2) return <ToastV2.Region />
  return <Toast.Region />
}

export function showToast(options: ToastOptions | string) {
  if (!v2) return showLegacyToast(options)
  if (typeof options === "string") return showToastV2(options)

  return showToastV2({
    ...options,
    icon: resolveIcon(options.icon, options.variant),
    actions: options.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

function resolveIcon(icon: IconProps["name"] | undefined, variant: ToastVariant | undefined) {
  const name = icon ?? (variant === "success" ? "check" : undefined)
  if (!name) return
  // `showToast` is a plain function call, so building the element here would create computations
  // outside any root and Solid would never dispose them. A thunk is a valid `JSX.Element`, and the
  // toast region resolves it via `children()` inside its own root.
  return () => <Icon name={name} />
}
