export * as Token from "./token"

const CHARS_PER_TOKEN = 4

// UTF-8 bytes, not UTF-16 length: tokenizers price dense non-ASCII text near or above one token
// per character, and `.length` read CJK at a quarter of that — a 4-8x undercount that let a
// request sail past the compaction gate straight into a provider overflow. Bytes put CJK at
// 0.75 tokens/char, inside the margin the budget already carries.
export const estimate = (input: string) => Math.max(0, Math.round(Buffer.byteLength(input) / CHARS_PER_TOKEN))
