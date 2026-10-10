import type { SessionMessage } from "./message"
import type { SecretOutput } from "../secret-output"

export function predictionConversation(messages: SessionMessage.Message[], guard: SecretOutput.Snapshot) {
  return messages
    .flatMap((message) => {
      if (message.type === "user" && (!message.source || message.source === "user")) {
        return [{ role: "user", text: guard.text(message.text).slice(0, 2000) }]
      }
      if (message.type === "assistant") {
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        return text ? [{ role: "assistant", text: guard.text(text).slice(-4000) }] : []
      }
      return []
    })
    .slice(-12)
}

export function cleanPrediction(text: string) {
  const value = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
  if (!value || value.length > 500 || value.includes("<think>")) return ""
  return value.replace(/^"([\s\S]*)"$/, "$1").trim()
}
