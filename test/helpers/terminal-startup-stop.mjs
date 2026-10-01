// Hold only this owned CLI process at its first actual full-screen write.
// The parent queues SIGTERM/SIGHUP while stopped, then SIGCONT: cleanup registration must already exist.
const nativeWrite = process.stdout.write.bind(process.stdout)
let stopped = false
process.stdout.write = function (chunk, ...args) {
  const result = nativeWrite(chunk, ...args)
  if (!stopped && String(chunk).includes('\x1b[?1049h')) {
    stopped = true
    process.kill(process.pid, 'SIGSTOP')
  }
  return result
}
