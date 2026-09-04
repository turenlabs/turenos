import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Extension } from "@turenlabs/schema"
import { Vigil } from "../../src/skill/vigil"
import type { Process } from "../../src/util/process"

const manifest = new Extension.Manifest({
  schemaVersion: 1,
  id: Extension.ID.make("community", "evidence-triage"),
  name: "Evidence Triage",
  description: "Triage supplied evidence",
  version: "1.0.0",
  publisher: "Community",
  trust: "community",
  contributions: [
    {
      type: "skill",
      id: Extension.ContributionID.make("evidence-triage"),
      name: "Evidence Triage",
      description: "Triage supplied evidence",
      instructions: "Use defensively.",
      adapter: "skill:evidence-triage",
      secrets: [],
      defaultEnabled: false,
      source: { type: "catalog", content: "Report evidence-supported findings only." },
      requires: ["read"],
    },
  ],
})
const config = { binary: "/vigil", library: "/onnx", model: "/model", metadata: "/metadata" }
const score = (label: "benign" | "malicious", maliciousProbability: number, threshold: number) =>
  Buffer.from(
    JSON.stringify({
      schema_version: "vigil.compact-score.v1",
      label,
      malicious_probability: maliciousProbability,
      threshold,
      whole_package: true,
      model_required: true,
    }),
  )

describe("Vigil skill scanner", () => {
  test("selects only published runtime targets", () => {
    expect(Vigil.target("darwin", "arm64")?.archive).toBe("vigil-compact-darwin-arm64.tar.gz")
    expect(Vigil.target("linux", "x64")?.archive).toBe("vigil-compact-linux-amd64.tar.gz")
    expect(Vigil.target("darwin", "x64")?.archive).toBe("vigil-compact-darwin-amd64.tar.gz")
  })

  test("binds review identity to every model-visible skill field", () => {
    expect(Vigil.skillDigest(new Extension.Manifest({ ...manifest, description: "Changed description" }))).not.toBe(
      Vigil.skillDigest(manifest),
    )
  })

  test("stages the complete prompt package and removes it after a scan", async () => {
    let staging = ""
    const run = (async (command: string[], options: { env?: NodeJS.ProcessEnv | null }) => {
      staging = command.at(-1) ?? ""
      expect(options.env).toEqual(
        process.platform === "linux" ? { LD_LIBRARY_PATH: path.dirname(config.library) } : null,
      )
      expect(await fs.readFile(`${staging}/SKILL.md`, "utf8")).toBe("Report evidence-supported findings only.")
      await expect(fs.stat(`${staging}/extension.json`)).rejects.toThrow()
      return {
        code: 0,
        stdout: score("benign", -0.2, 0.0000019818544387817383),
        stderr: Buffer.alloc(0),
      }
    }) as typeof Process.run
    const result = await Vigil.scanManifest(manifest, {
      ensure: async () => config,
      run,
    })
    expect(result).toMatchObject({ label: "benign", maliciousProbability: -0.2 })
    await expect(fs.stat(staging)).rejects.toThrow()
  })

  test("returns a malicious score for the admission layer to block", async () => {
    const result = await Vigil.scanManifest(manifest, {
      ensure: async () => config,
      run: (async () => ({
        code: 0,
        stdout: score("malicious", 0.9, 0.1),
        stderr: Buffer.alloc(0),
      })) as typeof Process.run,
    })
    expect(result).toEqual({ label: "malicious", maliciousProbability: 0.9, threshold: 0.1, reviewed: false })
    if (!result) throw new Error("Vigil result was missing")
    expect(Vigil.blockReason(result)).toContain("Vigil blocked this skill package")
    expect(Vigil.blockReason({ ...result, reviewed: true })).toBeUndefined()
  })

  test("serializes native scanner processes globally", async () => {
    let active = 0
    let maximum = 0
    const run = (async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await Bun.sleep(20)
      active -= 1
      return { code: 0, stdout: score("benign", -0.2, 0.1), stderr: Buffer.alloc(0) }
    }) as typeof Process.run
    await Promise.all([
      Vigil.scanManifest(manifest, { ensure: async () => config, run }),
      Vigil.scanManifest(manifest, { ensure: async () => config, run }),
    ])
    expect(maximum).toBe(1)
  })
})
