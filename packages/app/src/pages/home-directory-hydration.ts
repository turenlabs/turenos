export function directoryHydrationKey(server: string, directories: Iterable<string>) {
  return `${server}\0${[...new Set(directories)].sort().join("\0")}`
}

export function directoryHydrationPlan(input: {
  focus: ReadonlyArray<string>
  pinned: ReadonlyArray<string>
  recent: ReadonlyArray<string>
}) {
  return [...new Set([...input.focus, ...input.pinned])].sort()
}
