import { readdir } from "node:fs/promises"

export async function retainedLegacyStoreFiles(userDataPath: string) {
  return (await readdir(userDataPath, { withFileTypes: true }).catch(() => []))
    .filter(
      (entry) => entry.isFile() && /^(?:forge\.(?:draft|workspace)\..+\.dat|forge\.global\.dat)$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
}
