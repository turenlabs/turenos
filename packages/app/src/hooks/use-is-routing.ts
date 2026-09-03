import { useTransition } from "solid-js"

export function useIsRouting() {
  const [routing] = useTransition()
  return routing
}
