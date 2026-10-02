// 外部 reference 的 close 故障也不能跳过本基准拥有的 log/Truth 口。
export async function closeIndexBenchmark(index, log, truth) {
  try { await index?.close() }
  finally {
    try { await log?.close() }
    finally { await truth?.close() }
  }
}
