import { SafeHtml } from "@turenlabs/schema/safehtml"
import { Option, Schema } from "effect"

export function safeHtmlSpec(metadata: unknown): SafeHtml.Spec | undefined {
  if (typeof metadata !== "object" || metadata === null || !("structured" in metadata)) return
  return Option.getOrUndefined(Schema.decodeUnknownOption(SafeHtml.Spec)(metadata.structured))
}
