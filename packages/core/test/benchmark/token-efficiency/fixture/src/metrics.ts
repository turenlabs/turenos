/**
 * Counters for the Bramblewick service.
 *
 * Deliberately free of tenant handling — this module is the negative control
 * for the benchmark's cross-file symbol search task.
 */

export type CounterName = "requests" | "cache_hits" | "cache_misses" | "errors"

export class Counters {
  private readonly values = new Map<CounterName, number>()

  increment(name: CounterName, by = 1): number {
    const next = (this.values.get(name) ?? 0) + by
    this.values.set(name, next)
    return next
  }

  read(name: CounterName): number {
    return this.values.get(name) ?? 0
  }

  snapshot(): Readonly<Partial<Record<CounterName, number>>> {
    return Object.fromEntries(this.values) as Partial<Record<CounterName, number>>
  }
}
