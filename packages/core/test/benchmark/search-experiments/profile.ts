export function transform(source: string) {
  const marker = "      built = true\n"
  if (!source.includes(marker)) throw new Error("Missing build marker")
  return source.replace(
    marker,
    `
      Bun.gc(true)
      const indexStats = (ix: LexIndex) => ({
        files: ix.fileDocs.size,
        docs: ix.n,
        vocabulary: ix.inverted.size,
        postings: [...ix.inverted.values()].reduce((sum, rows) => sum + rows.length / 2, 0),
        fileTerms: [...ix.fileTerms.values()].reduce((sum, rows) => sum + rows.size, 0),
      })
      const { heapStats } = yield* Effect.promise(() => import("bun:jsc"))
      const stats = heapStats()
      console.error(JSON.stringify({
        profile: true,
        chunk: indexStats(chunkLex), symbol: indexStats(symLex), path: indexStats(pathLex),
        graph: {
          adjacencyNodes: adj.size,
          adjacencyEdges: [...adj.values()].reduce((n, set) => n + set.size, 0),
          callerNodes: callers.size,
          callerEdges: [...callers.values()].reduce((n, set) => n + set.size, 0),
          pendingEdges: [...pendingEdges.values()].reduce((n, edges) => n + edges.length, 0),
          resolvedEdges: [...fileEdges.values()].reduce((n, edges) => n + edges.length, 0),
        },
        memory: process.memoryUsage(),
        heap: { heapSize: stats.heapSize, heapCapacity: stats.heapCapacity, objectCount: stats.objectCount,
          topTypes: Object.entries(stats.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15) },
      }))
      built = true
`,
  )
}
