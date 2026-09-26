import { writeFile } from "node:fs/promises"
import { Database } from "@turenlabs/core/database/database"

const filename = process.argv[2]
const readyFile = process.argv[3]
if (!filename || !readyFile) throw new Error("Database filename and ready-file path are required")

const release = await Database.acquireOwnerLock(filename)
await writeFile(readyFile, String(process.pid))
await Bun.sleep(750)
release()
