import { Database } from "@turenlabs/core/database/database"

const filename = process.argv[2]
const startAt = Number(process.argv[3])
if (!filename || !Number.isFinite(startAt)) throw new Error("Database filename and start time are required")

// Spin to the shared start time so every worker enters the lock setup together.
while (Date.now() < startAt);
const result = await Database.acquireOwnerLock(filename).then(
  () => "acquired",
  (error: Error) => error.message,
)
console.log(result)
// An acquired lock is held until exit, long enough for every other worker to finish.
await Bun.sleep(1500)
process.exit(0)
