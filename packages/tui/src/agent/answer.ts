import type { QuestionsListOutput } from "@turenlabs/client"
import { clean, emit, waitLine, type Run } from "./context"
import { AgentError, usage } from "./errors"
import { maxMessageLength } from "../requests/context"
import { takes } from "./options"
import { distance } from "./words"
import { idArgument, sessionGone } from "./state"

type Question = QuestionsListOutput[number]["questions"][number]

export async function answer(run: Run) {
  const names = takes("answer", run.positionals, ["session", "question-id"])
  const sessionID = idArgument(names[0], "ses_", "The session")
  const requestID = idArgument(names[1], "", "The question ID")
  const modes = [!!run.values.choice?.length, run.values.answers !== undefined, !!run.values.reject]
  if (modes.filter(Boolean).length !== 1)
    throw usage("Give exactly one of --choice <label>, --answers <json> or --reject.")
  const client = run.connection.client
  const request = (await client.questions.list({ sessionID }).catch(sessionGone(sessionID))).find(
    (item) => item.id === requestID,
  )
  if (!request)
    throw new AgentError(
      `Question ${requestID} is not pending for session ${sessionID}; it may already be resolved. Check: turen-tui pending ${sessionID}${run.flags}`,
    )
  if (run.values.reject) {
    await client.questions.reject({ sessionID, requestID })
    return emit(
      run,
      { ok: true, session: sessionID, sessionID, question: requestID, rejected: true },
      `rejected ${requestID}\n${waitLine(run, sessionID)}`,
    )
  }
  const answers =
    run.values.answers !== undefined
      ? fromJSON(run, run.values.answers, request.questions)
      : fromChoices(run, request.questions)
  await client.questions.reply({ sessionID, requestID, answers })
  return emit(
    run,
    { ok: true, session: sessionID, sessionID, question: requestID, answers },
    `answered ${requestID}\n${waitLine(run, sessionID)}`,
  )
}

function fromChoices(run: Run, questions: readonly Question[]) {
  if (questions.length !== 1)
    throw usage(`This request has ${questions.length} questions. Use --answers with one array of labels per question.`)
  return [checked(run, questions[0]!, run.values.choice ?? [], 1)]
}

function fromJSON(run: Run, text: string, questions: readonly Question[]) {
  const value = parseJSON(text)
  if (
    !Array.isArray(value) ||
    value.length !== questions.length ||
    !value.every((item) => Array.isArray(item) && item.every((label) => typeof label === "string"))
  )
    throw usage(`--answers must be a JSON array of ${questions.length} arrays of labels, one per question.`)
  return questions.map((question, index) => checked(run, question, value[index] as string[], index + 1))
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw usage("--answers must be valid JSON, for example '[[\"Red\"]]'.")
  }
}

/** Checks each label against the question's options, mapping the printed label back to the exact one. */
function checked(run: Run, question: Question, labels: readonly string[], number: number) {
  if (!labels.length) throw usage(`Choose at least one answer for question ${number}.`)
  if (labels.length > 1 && !question.multiple) throw usage(`Question ${number} takes one answer.`)
  const choices = question.options.map((item) => clean(item.label, 200)).join(" | ")
  return labels.map((label) => {
    // An exact label wins over one that only matches once its controls are removed.
    const option =
      question.options.find((item) => item.label === label) ??
      question.options.find((item) => clean(item.label, 200) === label)
    if (option) return option.label
    if (!label.trim() || label.length > maxMessageLength)
      throw usage(`Question ${number} needs an answer of 1 to 32,000 characters.`)
    if (question.custom === false)
      throw usage(
        `${JSON.stringify(clean(label, 80))} is not an option for question ${number}. Valid choices: ${choices}.`,
      )
    // --custom is the caller saying the label is meant as typed.
    if (run.values.custom) return label
    const near = nearOption(question, label)
    if (near)
      throw usage(
        `Did you mean ${JSON.stringify(near)}? Add --custom to send ${JSON.stringify(clean(label, 80))} as typed.`,
      )
    // Said out loud: a typo in a label would otherwise become a custom answer without anyone noticing.
    run.io.stderr(
      `turen-tui: ${JSON.stringify(clean(label, 80))} is not one of question ${number}'s options (${choices}); sent as a custom answer.\n`,
    )
    return label
  })
}

/** The option a label differs from by one edit, ignoring case: more likely a typo than a different answer. */
function nearOption(question: Question, label: string) {
  return question.options
    .map((item) => clean(item.label, 200))
    .find((option) => distance(option.toLowerCase(), label.toLowerCase()) <= 1)
}
