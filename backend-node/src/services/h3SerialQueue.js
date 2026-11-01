/**
 * MiniMax H3 must run through one process-wide FIFO at a time.
 *
 * H3 jobs are long lived: the lock is held until the upstream task has
 * completed (or failed), rather than only while the HTTP submit call is in
 * flight.  This prevents multiple ComfyUI instances from consuming GPU
 * memory concurrently and also covers single-shot and restored jobs that do
 * not pass through videoBatchService.
 */
let tail = Promise.resolve();
let active = null;
let queued = 0;

function enqueue(label, fn) {
  if (typeof fn !== 'function') throw new TypeError('H3 serial queue requires a function');
  queued += 1;
  const run = tail.then(async () => {
    queued = Math.max(0, queued - 1);
    active = { label: String(label || ''), started_at: new Date().toISOString() };
    try {
      return await fn();
    } finally {
      active = null;
    }
  });
  // A rejected item must not prevent the FIFO from advancing.
  tail = run.catch(() => {});
  return run;
}

function status() {
  return {
    active: active ? { ...active } : null,
    queued,
    serial: true,
  };
}

function resetForTests() {
  tail = Promise.resolve();
  active = null;
  queued = 0;
}

module.exports = { enqueue, status, resetForTests };
