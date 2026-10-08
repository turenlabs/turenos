export type PendingInput = {
  id: string
  text: string
  delivery: "steer" | "queue"
  sending: boolean
}

/**
 * Orders admitted-but-unpromoted inputs the way the runner will deliver them: at each
 * provider-turn boundary every pending steer promotes together, and only when none
 * remain does the oldest queued input promote — one per boundary. Input must already
 * be in admission order (message IDs ascend with admission).
 */
export function orderPendingInputs(items: readonly PendingInput[]) {
  return [
    ...items.filter((item) => item.delivery === "steer").map((item) => ({ ...item, position: undefined })),
    ...items
      .filter((item) => item.delivery === "queue")
      .map((item, index) => ({ ...item, position: index + 1 })),
  ]
}
