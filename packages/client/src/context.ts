// How full a model's context window is, measured the same way in the desktop app and the terminal
// client. Occupancy belongs to one provider request: every assistant message records the usage of
// one request, so the newest one describes the window as it stands now. Summing messages would
// count cached tokens once per round trip and could never fall after compaction. Keep this file
// framework-free; inputs are typed structurally so the SDK and client message types both fit.

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

/** The whole prompt of one request: uncached input plus what was read from or written to the cache. */
export const promptTokens = (tokens: Tokens) => tokens.input + tokens.cache.read + tokens.cache.write

/** Context-window occupancy of one request: its prompt plus the response appended to it. */
export const contextTokens = (tokens: Tokens) => promptTokens(tokens) + tokens.output + tokens.reasoning

/** Whole percent of the window in use, or null when the model publishes no limit to divide by. */
export const usagePercent = (total: number, limit: number | undefined) =>
  limit ? Math.round((total / limit) * 100) : null
