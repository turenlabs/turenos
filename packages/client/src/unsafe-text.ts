/**
 * Control characters and bidirectional controls: text holding one could clear, recolour or reorder what a terminal
 * or view shows, so names, paths and labels that carry one are refused or stripped. Shared by the desktop and TUI.
 */
// oxlint-disable-next-line no-control-regex -- the control range is the point of this check
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
