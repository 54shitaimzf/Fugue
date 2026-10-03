// Benchmark-owned handles: every close is observed, even after constructor/close failure.
export async function withCohortBenchmarkHandles(open, run) {
  const owned = {}
  let result, failure, failed = false
  try { result = await run(await open(owned)) }
  catch (error) { failed = true; failure = error }
  for (const name of ['index', 'store', 'log', 'truth']) {
    try { await owned[name]?.close() }
    catch (error) { if (!failed) { failed = true; failure = error } }
  }
  if (failed) throw failure
  return result
}
