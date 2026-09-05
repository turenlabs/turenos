import { cp, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"

// Import locally verified WASM builds with the exact sources needed to reproduce them.
const source = path.resolve(process.argv[2] ?? ".wasm-tools-106")
const revision = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"])
if (revision.exitCode !== 0) throw new Error("Unable to identify WASM source revision")
const sourceRevision = revision.stdout.toString().trim()
const rust = Bun.spawnSync(["rustc", "--version"]).stdout.toString().trim()

for (const name of ["email-security", "static-analysis"]) {
  const input = path.join(source, "tools", name)
  const output = path.resolve("packages", `${name}-wasm`)
  const dist = path.join(output, "dist", ...(name === "static-analysis" ? ["extensions"] : []))
  await mkdir(dist, { recursive: true })
  for (const file of await readdir(path.join(input, "pkg"))) {
    if (!file.endsWith(".wasm") && !file.endsWith(".js") && !file.endsWith(".d.ts")) continue
    await cp(path.join(input, "pkg", file), path.join(dist, file))
  }
  for (const file of ["Cargo.toml", "Cargo.lock", "src", "test"]) {
    await cp(path.join(input, file), path.join(output, "source-106", file), { recursive: true })
  }
  const metadata = {
    repository: "https://github.com/turenio/wasm-tools",
    sourceRevision,
    localModifications: "source-106 contains the complete modified crate and locked dependencies",
    rust,
    wasmPack: "0.15.0",
    rustFlags: name === "static-analysis" ? "-C link-arg=--max-memory=268435456" : "",
    network: false,
    filesystem: false,
  }
  await Bun.write(path.join(output, "SOURCE-106.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  if (name === "email-security") {
    const previous = await Bun.file(path.join(output, "SOURCE.json")).json()
    await Bun.write(
      path.join(output, "SOURCE.json"),
      `${JSON.stringify({ ...previous, ...metadata, sourceCommit: sourceRevision, workflowRun: undefined }, null, 2)}\n`,
    )
  }
  if (name === "static-analysis") {
    for (const file of ["Cargo.toml", "LICENSE", "README.md", "src"])
      await cp(path.join(input, "vendor/sevenz-rust", file), path.join(output, "source-106/vendor/sevenz-rust", file), {
        recursive: true,
      })
    const notices = []
    for (const crate of (await readdir(path.join(input, "vendor"))).sort()) {
      const root = path.join(input, "vendor", crate)
      for (const file of (await readdir(root)).filter((file) => /^(LICENSE|NOTICE|COPYING)/i.test(file))) {
        const contents = await readFile(path.join(root, file), "utf8").catch(() => undefined)
        if (contents) notices.push(`\n===== ${crate}/${file} =====\n${contents}`)
      }
    }
    await Bun.write(path.join(output, "THIRD-PARTY-106.txt"), notices.join("\n"))
  }
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: output, onlyFiles: true }))
  const checksums = await Promise.all(
    files
      .filter((file) => file !== "SHA256SUMS")
      .map(async (file) => {
        const hash = new Bun.CryptoHasher("sha256")
          .update(await Bun.file(path.join(output, file)).arrayBuffer())
          .digest("hex")
        return `${hash}  ${file}`
      }),
  )
  await Bun.write(path.join(output, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`)
  console.log(`Imported ${name} with source and checksums`)
}
