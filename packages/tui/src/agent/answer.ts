import type { QuestionsListOutput } from "@turenlabs/client"
import { clean, emit, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { takes } from "./options"
import { idArgument } from "./state"

type Question = QuestionsListOutput[number]["questions"][number]

export async function answer(run: Run) {
  const names = takes("answer", run.positionals, ["session", "question-id"])
  const sessionID = idArgument(names[0], "ses_", "The session")
  const requestID = idArgument(names[1], "", "The question ID")
  const modes = [!!run.values.choice?.length, run.values.answers !== undefined, !!run.values.reject]
  if (modes.filter(Boolean).length !== 1)
    throw usage("Give exactly one of --choice <label>, --answers <json> or --reject.")
  const client = run.connection.client
  const request = (await client.questions.list({ sessionID })).find((item) => item.id === requestID)
  if (!request)
    throw new AgentError(
      `Question ${requestID} is not pending for session ${sessionID}; it may already be resolved. Check: turen-tui pending ${sessionID}${run.flags}`,
    )
  if (run.values.reject) {
    await client.questions.reject({ sessionID, requestID })
    return emit(run, { ok: true, session: sessionID, question: requestID, rejected: true }, `rejected ${requestID}`)
  }
  const answers =
    run.values.answers !== undefined
      ? fromJSON(run.values.answers, request.questions)
      : fromChoices(run, request.questions)
  await client.questions.reply({ sessionID, requestID, answers })
  return emit(run, { ok: true, session: sessionID, question: requestID, answers }, `answered ${requestID}`)
}

function fromChoices(run: Run, questions: readonly Question[]) {
  if (questions.length !== 1)
    throw usage(`This request has ${questions.length} questions. Use --answers with one array of labels per question.`)
  return [checked(questions[0]!, run.values.choice ?? [], 1)]
}

function fromJSON(text: string, questions: readonly Question[]) {
  const value = parseJSON(text)
  if (
    !Array.isArray(value) ||
    value.length !== questions.length ||
    !value.every((item) => Array.isArray(item) && item.every((label) => typeof label === "string"))
  )
    throw usage(`--answers must be a JSON array of ${questions.length} arrays of labels, one per question.`)
  return questions.map((question, index) => checked(question, value[index] as string[], index + 1))
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw usage("--answers must be valid JSON, for example '[[\"Red\"]]'.")
  }
}

/** Checks each label against the question's options, mapping the printed label back to the exact one. */
function checked(question: Question, labels: readonly string[], number: number) {
  if (!labels.length) throw usage(`Choose at least one answer for question ${number}.`)
  if (labels.length > 1 && !question.multiple) throw usage(`Question ${number} takes one answer.`)
  return labels.map((label) => {
    const option = question.options.find((item) => item.label === label || clean(item.label, 200) === label)
    if (option) return option.label
    if (question.custom !== false) return label
    throw usage(
      `${JSON.stringify(clean(label, 80))} is not an option for question ${number}. Valid choices: ${question.options.map((item) => clean(item.label, 200)).join(" | ")}.`,
    )
  })
}
