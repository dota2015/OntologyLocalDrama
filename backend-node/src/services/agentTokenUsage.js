const { AsyncLocalStorage } = require('node:async_hooks');
const trace = require('./directorTrace');

// Isolated per background task, including nested agent runs and ReAct retries.
const context = new AsyncLocalStorage();
const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

function emptyUsage() {
  return { requests: 0, reported_requests: 0, unreported_requests: 0,
    input_tokens: 0, output_tokens: 0, total_tokens: 0,
    cached_input_tokens: 0, reasoning_tokens: 0, stages: [] };
}

function recordUsage(raw, { agent, model }) {
  const scope = context.getStore();
  if (!scope) return;
  const total = scope.usage;
  let stage = total.stages.find((entry) => entry.agent === agent && entry.model === model);
  if (!stage) {
    const { stages, ...counters } = emptyUsage();
    stage = { agent, model, ...counters };
    total.stages.push(stage);
  }
  const reported = Number.isFinite(raw?.prompt_tokens) && Number.isFinite(raw?.completion_tokens);
  for (const entry of [total, stage]) {
    entry.requests++;
    if (!reported) { entry.unreported_requests++; continue; }
    entry.reported_requests++;
    entry.input_tokens += count(raw.prompt_tokens);
    entry.output_tokens += count(raw.completion_tokens);
    entry.total_tokens += Number.isFinite(raw.total_tokens)
      ? count(raw.total_tokens) : count(raw.prompt_tokens) + count(raw.completion_tokens);
    // These are subsets of input/output, not additional tokens.
    entry.cached_input_tokens += count(raw.prompt_tokens_details?.cached_tokens);
    entry.reasoning_tokens += count(raw.completion_tokens_details?.reasoning_tokens);
  }
  scope.onUpdate?.(structuredClone(total));
}

function instrumentClient(client, metadata, log) {
  if (!context.getStore() && !trace.active()) return;
  const create = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = (...args) => {
    const callId = trace.observeRequest(args[0], metadata);
    const pending = create(...args);
    // Observe the original SDK promise without changing its withResponse API.
    // Capture before SDK output parsing, so invalid JSON still counts.
    if (!args[0]?.stream) {
      return pending.then(
        (response) => {
          trace.observeResponse(callId, response);
          recordUsage(response?.usage, metadata);
          return response;
        },
        (error) => {
          if (callId) trace.record('model_request_failed', { call_id: callId, error: error.message });
          recordUsage(null, metadata);
          throw error;
        },
      );
    }
    return pending;
  };
}

async function withTokenUsage(work, onUpdate) {
  const scope = { usage: emptyUsage(), onUpdate };
  return context.run(scope, async () => {
    onUpdate?.(structuredClone(scope.usage));
    try {
      const result = await work();
      return { ...result, token_usage: structuredClone(scope.usage) };
    } catch (error) {
      error.token_usage = structuredClone(scope.usage);
      throw error;
    }
  });
}

function withTaskTokenUsage(db, taskId, work) {
  return withTokenUsage(work, (usage) => {
    const row = db.prepare('SELECT result FROM async_tasks WHERE id = ?').get(taskId);
    const result = row?.result ? JSON.parse(row.result) : {};
    db.prepare('UPDATE async_tasks SET result = ? WHERE id = ?')
      .run(JSON.stringify({ ...result, token_usage: usage }), taskId);
  });
}

module.exports = { instrumentClient, withTokenUsage, withTaskTokenUsage };
