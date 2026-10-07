/** Characters one row of a panel's list column holds after its marker: the 34% share (at least 24) `openPanel` gives it. */
export function listChars(panelWidth: number) {
  return Math.max(24, Math.floor(panelWidth * 0.34)) - 4
}
