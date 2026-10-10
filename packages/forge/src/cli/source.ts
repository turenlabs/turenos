import { pathToFileURL } from "node:url"

// Bun must start in the Forge package to load its config and relative preloads,
// not executable configuration from the selected project. Switch to the trusted
// caller's workspace before importing CLI modules that capture process.cwd().
const directory = process.argv[2]
const entry = process.argv[3]
if (!directory || !entry) throw new Error("source CLI launch requires a workspace and entrypoint")
process.chdir(directory)
process.argv = [process.argv[0]!, entry, ...process.argv.slice(4)]
await import(pathToFileURL(entry).href)
