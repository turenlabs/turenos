import { pathKey } from "@turenlabs/client/path-key"
export { createWorkingFolders } from "@turenlabs/client/working-folders"

export function folderContains(folder: string, directory: string) {
  const root = pathKey(folder)
  const path = pathKey(directory)
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
}
