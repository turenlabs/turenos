import { load, wireTokens } from "./lib"
const SESSIONS = [
  "ses_0556315fcffeHvjtgPFxsBHx0o",
  "ses_049daee7dffeJTiQoU6MdKewtB",
  "ses_050b609adffezXIJGkMV4KeSDM",
  "ses_03f74452cffduLwSn4VRoNaG1L",
  "ses_041679e13ffdiPterDp0sHrwF5",
  "ses_04797a900ffe9w2drITJ0OtdBi",
  "ses_050344a2cffe66piKLHcymP9sn",
  "ses_05108d761ffe56ZB8U33Zwpja5",
]
const sizes: number[] = []
for (const id of SESSIONS) for (const e of load(id)) sizes.push(wireTokens(e.message))
sizes.sort((a, b) => a - b)
const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))]
const over = (n: number) => sizes.filter((v) => v > n).length
console.log(
  JSON.stringify({
    n: sizes.length,
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: sizes[sizes.length - 1],
    over: { "2k": over(2000), "8k": over(8000), "16k": over(16000), "32k": over(32000), "64k": over(64000) },
    pctOver8k: +((100 * over(8000)) / sizes.length).toFixed(1),
    pctOver32k: +((100 * over(32000)) / sizes.length).toFixed(1),
    // Cumulative coverage: tokens needed for a tail of the newest K messages
    meanTokens: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
  }),
)
