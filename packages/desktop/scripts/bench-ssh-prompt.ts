import { detectSshPrompt } from "../src/main/ssh/runtime"

const iterations = Number(Bun.argv[2] ?? 200_000)
const output = Array.from({ length: 200 }, (_, index) => `debug output ${index}: waiting for remote...\r\n`).join("")
const tail = (output + "waiting for remote response without a prompt").slice(-4096)
const warmup = Math.min(iterations, 50_000)
const samples = 9

for (let index = 0; index < warmup; index++) detectSshPrompt(tail)

const timings = Array.from({ length: samples }, () => {
  let prompts = 0
  const start = performance.now()
  for (let index = 0; index < iterations; index++) prompts += Number(detectSshPrompt(tail) !== null)
  return { prompts, nsPerCall: ((performance.now() - start) * 1_000_000) / iterations }
}).sort((left, right) => left.nsPerCall - right.nsPerCall)

process.stdout.write(
  `${JSON.stringify({ tailChars: tail.length, iterations, medianNsPerCall: timings[Math.floor(samples / 2)]!.nsPerCall })}\n`,
)
