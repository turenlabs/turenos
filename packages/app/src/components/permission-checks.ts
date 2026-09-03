export function createPermissionChecksUpdater(input: {
  current: () => boolean | undefined
  mutate: (value: boolean) => void
  read: () => Promise<boolean>
  update: (value: boolean) => Promise<boolean>
}) {
  let revision = 0
  let pending = 0
  let confirmed = input.current()
  let writes = Promise.resolve()

  return (value: boolean) => {
    if (pending === 0 && input.current() !== undefined) confirmed = input.current()
    const currentRevision = ++revision
    pending++
    input.mutate(value)
    const write = writes.then(async () => {
      confirmed = await input.update(value).catch(() => input.read().catch(() => confirmed))
      if (revision !== currentRevision) return
      confirmed = await input.read().catch(() => confirmed)
      input.mutate(confirmed ?? value)
    })
    writes = write
      .catch(() => undefined)
      .finally(() => {
        pending--
      })
    return write
  }
}
