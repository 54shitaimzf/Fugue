// Developer-only restoration and owned-root cleanup share one failure-preserving owner.
import { settleBenchmarkCleanups } from './benchmark-cleanup.js'
export async function cleanupProfileBenchmark(restore, cleanups, outcome) {
  return settleBenchmarkCleanups([restore, ...cleanups], outcome)
}
