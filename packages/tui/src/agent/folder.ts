import { FolderNotFound, resolveFolder } from "../working-folders"
import { clean, type Run } from "./context"
import { checkDirectory } from "../response-validation"
import { usage } from "./errors"

/**
 * The folder a listing shows, with its project. A `--dir` the server cannot read fails; the folder the command
 * runs in is dropped instead, with a note on stderr, and every folder is listed.
 */
export async function listingFolder(run: Run) {
  const folder = run.folder
  if (!folder) return undefined
  if (folder.explicit) validDirectory(folder.directory)
  return resolveFolder(run.connection.client, folder.directory).catch((error: unknown) => {
    if (folder.explicit || !(error instanceof FolderNotFound)) throw error
    run.io.stderr(`turen-tui: ${clean(folder.directory, 1000)} is not readable on this server; listing every folder.\n`)
    return undefined
  })
}

export function validDirectory(directory: string) {
  try {
    checkDirectory(directory)
  } catch {
    throw usage("--dir must be an absolute directory on the server.")
  }
}
