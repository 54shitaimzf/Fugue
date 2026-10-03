// Attempt every owned cleanup, preserving the original operation failure when present.
export async function settleBenchmarkCleanups(actions, outcome = { failed: false }) {
  let failed = outcome.failed, failure = outcome.error
  for (const action of actions) {
    try { await action() }
    catch (error) { if (!failed) { failed = true; failure = error } }
  }
  if (failed) throw failure
}
