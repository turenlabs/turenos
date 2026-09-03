export * as File from "./file"

import { Revert } from "@turenlabs/schema/revert"

export const Diff = Revert.FileDiff
export type Diff = typeof Diff.Type
