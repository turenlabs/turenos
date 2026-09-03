import type { ComponentProps } from "solid-js"
import { Logo } from "../../components/logo"

/**
 * V2 surfaces share the fixed gold TurenOS artwork with the rest of the app.
 */
export function WordmarkV2(props: ComponentProps<"svg">) {
  return <Logo {...props} />
}
