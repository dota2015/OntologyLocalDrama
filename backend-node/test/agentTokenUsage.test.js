const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { instrumentClient, withTokenUsage, withTaskTokenUsage } = require('../src/services/agentTokenUsage');

const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
  prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 10 } };
function clientFor(responses, agent = 'draft') {
  const client = { chat: { completions: { create: async () => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  } } } };
  instrumentClient(client, { agent, model: 'test-model' });
  return () => client.chat.completions.create({ stream: false });
}

test('counts draft and repair, records missing usage, and does not add cached/reasoning twice', async () => {
  const snapshots = [];
  const result = await withTokenUsage(async () => {
    const draft = clientFor([{ usage }, {}]);
    await draft(); await draft();
    await clientFor([{ usage }], 'repair')();
    return { total_shots: 1 };
  }, snapshot => snapshots.push(snapshot));
  const u = result.token_usage;
  assert.equal(u.requests, 3);
  assert.equal(u.unreported_requests, 1);
  assert.equal(u.total_tokens, 280);
  assert.equal(u.cached_input_tokens, 40);
  assert.equal(u.reasoning_tokens, 20);
  assert.equal(u.stages.length, 2);
  assert.equal(snapshots[0].requests, 0);
  assert.equal(snapshots.at(-1).requests, 3);
});

test('parallel tasks are isolated and failures retain already consumed tokens', async () => {
  const [first, second] = await Promise.allSettled([
    withTokenUsage(async () => {
      const run = clientFor([{ usage }, new Error('network failed')]);
      await run(); await run();
    }),
    withTokenUsage(async () => {
      await clientFor([{ usage: { prompt_tokens: 5, completion_tokens: 7 } }])();
      return {};
    }),
  ]);
  assert.equal(first.status, 'rejected');
  assert.equal(first.reason.token_usage.total_tokens, 140);
  assert.equal(first.reason.token_usage.unreported_requests, 1);
  assert.equal(second.value.token_usage.total_tokens, 12);
});

test('live usage persists without marking a running task completed or dropping other result fields', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE async_tasks(id TEXT, status TEXT, result TEXT);
      INSERT INTO async_tasks VALUES('task', 'processing', '{"version":"v1"}');`);
    await withTaskTokenUsage(db, 'task', async () => {
      await clientFor([{ usage }])();
      const row = db.prepare('SELECT * FROM async_tasks').get();
      assert.equal(row.status, 'processing');
      assert.equal(JSON.parse(row.result).version, 'v1');
      assert.equal(JSON.parse(row.result).token_usage.total_tokens, 140);
      return {};
    });
  } finally { db.close(); }
});

test('real Agents SDK records provider usage even when output is empty and rejected', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { withTaskTrace } = require('../src/services/directorTrace');
  const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-director-trace-'));
  t.after(() => fs.rmSync(traceRoot, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'chat-test', object: 'chat.completion', created: 1,
      model: 'test-model', choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: '' } }], usage }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = require('../src/services/aiConfigService');
  t.mock.method(config, 'listConfigs', () => [{ is_active: true, is_default: true,
    model: ['test-model'], base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'test' }]);
  const runtime = require('../src/services/agentsRuntime');
  await assert.rejects(withTaskTrace({ name: path.join(traceRoot, 'db.sqlite') }, 'raw-response-test',
    () => withTokenUsage(() => runtime.runAgent(null, {}, { input: 'test' }))), error => {
    assert.match(error.message, /返回内容为空/);
    assert.equal(error.token_usage.total_tokens, 140);
    assert.equal(error.token_usage.requests, 1);
    return true;
  });
  const trace = fs.readFileSync(path.join(traceRoot, 'director-traces/raw-response-test.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const request = trace.find(event => event.event === 'model_request');
  const response = trace.find(event => event.event === 'model_response');
  assert.equal(response.call_id, request.call_id);
  assert.equal(response.choices[0].message.content, '');
  assert.equal(response.usage.total_tokens, 140);
  assert.equal(trace.at(-1).event, 'task_failed');
  assert.equal(request.api_key, undefined);
});
