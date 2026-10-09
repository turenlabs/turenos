import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { fixture } from "./fixtures.mjs"

// Stage outside the repository to prevent workspace dependencies from hiding
// missing packaged assets. Run the bundled worker under real Node.
const root = fileURLToPath(new URL("../../../", import.meta.url))
export async function verifyWorker(assets, workerSource) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jwt-audit-worker-"))
  try {
    await cp(assets ?? path.join(root, "packages/jwt-audit-wasm"), directory, { recursive: true })
    if (workerSource) await cp(workerSource, path.join(directory, "jwt-audit-worker.js"))
    if (!assets)
      execFileSync("bun", [
        "build",
        path.join(root, "packages/core/src/tool/jwt-audit-worker.ts"),
        "--target",
        "node",
        "--outfile",
        path.join(directory, "jwt-audit-worker.js"),
      ])
    for (const algorithm of ["RS256", "ES256"]) {
      const f = fixture(algorithm)
      const worker = new Worker(pathToFileURL(path.join(directory, "jwt-audit-worker.js")))
      try {
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("packaged worker test timed out")), 30000)
          worker.once("error", (error) => {
            clearTimeout(timer)
            reject(error)
          })
          worker.once("message", (message) => {
            clearTimeout(timer)
            resolve(message)
          })
          worker.postMessage({
            op: "jwt_verify",
            bytes: f.token(),
            jwk: Buffer.from(JSON.stringify(f.jwk)),
            options: f.policy,
          })
        })
        assert.equal(response.type, "completed", JSON.stringify(response))
        assert.equal(response.result.verified, true)
        assert.equal(response.result.signatureValid, true)
      } finally {
        await worker.terminate()
      }
    }
    console.log("Bundled JWT worker verified under Node from isolated packaged assets for RS256 and ES256")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await verifyWorker(process.argv[2], process.argv[3])
