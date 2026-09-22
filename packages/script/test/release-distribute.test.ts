import { describe, expect, test } from "bun:test"
import { assertNotDowngrade, previousRelease } from "../../../script/release-distribute"

const release = (tag: string, options: { draft?: boolean; prerelease?: boolean } = {}) => ({
  id: 1,
  tag_name: tag,
  draft: false,
  prerelease: false,
  target_commitish: "a".repeat(40),
  assets: [],
  ...options,
})

describe("release publication decisions", () => {
  test("never moves latest behind a newer stable release, even when that release is not marked latest", () => {
    expect(() => assertNotDowngrade("1.0.11", [release("v1.0.12")])).toThrow("Refusing")
    expect(() => assertNotDowngrade("1.0.11", [release("v1.0.11"), release("v1.0.10")])).not.toThrow()
    expect(() =>
      assertNotDowngrade("1.0.11", [release("v1.0.12", { draft: true }), release("v2.0.0-beta", { prerelease: true })]),
    ).not.toThrow()
  })
  test("recovery chooses the previous release rather than its already-published target", () => {
    const old = release("v1.0.10")
    expect(previousRelease("1.0.11", [release("v1.0.11"), release("v1.0.9"), old])).toBe(old)
    expect(previousRelease("1.0.11", [])).toBeUndefined()
    expect(previousRelease("1.10.0", [release("v1.2.0"), release("v1.9.0")])?.tag_name).toBe("v1.9.0")
  })
})

test("GitHub workflow owns the complete release and builds only public source", async () => {
  const text = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
  const workflow = Bun.YAML.parse(text) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } }
    jobs: Record<
      string,
      {
        needs?: unknown
        if?: string
        permissions?: Record<string, string>
        steps: Array<{ name: string; env?: Record<string, string>; with?: Record<string, unknown>; run?: string }>
      }
    >
  }
  expect(workflow.on.workflow_dispatch.inputs.publish_existing).toBeDefined()
  // Builds, signs, and packages public main commits — never private trees.
  const buildJobs = ["build-runtime", "sign-runtime-macos", "sign-runtime-windows", "build-desktop", "publish"]
  for (const name of buildJobs) {
    const checkout = workflow.jobs[name]?.steps.find((step) => String(step.name).includes("Checkout"))
    expect(checkout?.with?.repository).toBe("turenlabs/turenos")
  }
  expect(workflow.jobs.publish?.steps.find((step) => step.run?.includes("release-state.ts"))?.env?.GH_REPO).toBe(
    "turenlabs/turenos",
  )
  expect(workflow.jobs.distribute?.needs).toEqual(["release_context", "publish"])
  expect(workflow.jobs.distribute?.if).toContain("!cancelled()")
  expect(workflow.jobs.distribute?.if).toContain("needs.publish.result == 'success'")
  expect(workflow.jobs.distribute?.permissions).toEqual({ contents: "read" })
  const publish = workflow.jobs.distribute!.steps.find((step) => step.run?.includes("release-distribute.ts"))!
  expect(publish.env?.PUBLIC_RELEASE_TOKEN).toBe("${{ secrets.PUBLIC_RELEASE_TOKEN }}")
  expect(JSON.stringify(workflow.jobs.distribute)).not.toContain("RELEASE_GPG_PRIVATE_KEY")
  expect(workflow.jobs.distribute!.steps[0]?.with?.["persist-credentials"]).toBe(false)
})
