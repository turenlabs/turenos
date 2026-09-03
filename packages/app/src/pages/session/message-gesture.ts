export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }) => {
  if (input.deltaMode === 1) return input.deltaY * 40
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight
  return input.deltaY
}

export const shouldMarkBoundaryGesture = (input: {
  delta: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}) => {
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return true
  if (!input.delta) return false

  if (input.delta < 0) return input.scrollTop + input.delta <= 0

  const remaining = max - input.scrollTop
  return input.delta > remaining
}

/**
 * The virtualizer's end-anchoring well, sized by follow state.
 *
 * With `anchorTo: "end"`, virtual-core re-pins the view to the very end on *every* item
 * resize while the viewport sits within `scrollEndThreshold` of the virtual end
 * (resizeItem's `wasAtEnd` branch). That check is pure geometry — it consults no user
 * intent and runs before the app's `shouldAdjustScrollPositionOnItemSizeChange`
 * override. While a response streams, the growing row resizes continuously, so a fixed
 * 80px well swallowed every upward wheel that had not yet escaped it: the snap landed at
 * distance 0, which the auto-scroll hook reads as "returned to bottom" and used to clear
 * the user's pause — re-arming every follow path and locking the view to the end until a
 * remount.
 *
 * So the well is generous only while the view is actually meant to follow. The moment
 * the user breaks follow it collapses to a hair's width: re-pinning then happens only at
 * the true bottom, which is exactly the point where follow is supposed to re-engage.
 */
export const FOLLOW_SCROLL_END_THRESHOLD = 80

export const followScrollEndThreshold = (anchorBottom: boolean) => (anchorBottom ? FOLLOW_SCROLL_END_THRESHOLD : 1)
