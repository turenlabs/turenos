import { display } from "../messages"
import type { ToolPart } from "./tool"

/**
 * A question tool's answers as "<question> → <answer>" lines. The result text is wording for the model,
 * so this reads the questions from the input and the answers from the structured output; undefined when
 * either is missing, which leaves that text in place.
 */
export function answeredQuestions(part: ToolPart) {
  const state = part.state
  if (part.name !== "question" || state.status !== "completed") return undefined
  const questions = state.input?.questions
  const answers = state.structured?.answers
  if (!Array.isArray(questions) || !Array.isArray(answers)) return undefined
  return (
    questions
      .flatMap((question, index) => {
        const text =
          typeof question === "object" && question !== null && "question" in question ? question.question : ""
        const given = answers[index]
        if (typeof text !== "string" || !text.trim() || !Array.isArray(given)) return []
        const answer = given.filter((item): item is string => typeof item === "string" && item.length > 0)
        return [
          `${display(text, 400).replace(/\s+/g, " ").trim()} → ${display(answer.join(", ") || "Unanswered", 400)}`,
        ]
      })
      .join("\n") || undefined
  )
}
