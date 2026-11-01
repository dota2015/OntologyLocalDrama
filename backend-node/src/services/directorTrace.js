const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const context = new AsyncLocalStorage();
function active() { return !!context.getStore(); }
function record(event, details = {}) {
  const scope = context.getStore();
  if (!scope) return;
  const entry = { timestamp: new Date().toISOString(), task_id: scope.taskId,
    sequence: ++scope.sequence, event, ...details };
  // Append before accepting a candidate; a failed write must not silently lose evidence.
  fs.appendFileSync(scope.file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function withTaskTrace(db, taskId, work) {
  if (!db?.name || db.name === ':memory:') return work();
  const directory = path.join(path.dirname(path.resolve(db.name)), 'director-traces');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('Invalid director trace task ID');
  const file = path.join(directory, taskId + '.jsonl');
  const traceFile = 'director-traces/' + taskId + '.jsonl';
  return context.run({ taskId, file, sequence: 0 }, async () => {
    record('task_started');
    try {
      const result = await work();
      record('task_completed', { result });
      return { ...result, trace_file: traceFile };
    } catch (error) {
      record('task_failed', { error: error.message, violations: error.violations || [] });
      error.trace_file = traceFile;
      throw error;
    }
  });
}

function observeRequest(request, metadata) {
  if (!active()) return null;
  const callId = randomUUID();
  // Explicit allowlist: no API keys, headers or connection configuration.
  record('model_request', { call_id: callId, ...metadata, messages: request.messages,
    response_format: request.response_format, max_tokens: request.max_tokens ?? request.max_completion_tokens });
  return callId;
}
function observeResponse(callId, response) {
  if (callId) record('model_response', { call_id: callId, response_id: response?.id,
    choices: response?.choices, usage: response?.usage });
}

module.exports = { active, record, withTaskTrace, observeRequest, observeResponse };
