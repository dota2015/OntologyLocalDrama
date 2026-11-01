const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { safeParseAIJSON } = require('../src/utils/safeJson');
const { parseStoryResponse } = require('../src/services/storyGenerationService');

test('safeParseAIJSON handles Chinese dialogue with unescaped quotes', () => {
  const jsonWithDialogue = `[
    {
      "episode": 1,
      "title": "流放西州",
      "content": "押差解开锁链。\\n苏砚："姐姐，这里就是咱们往后住的地方吗？"\\n苏晚看向漏风的窝棚。"
    },
    {
      "episode": 2,
      "title": "灵泉救亲",
      "content": "苏晚："娘，别回头，我来灭火。""
    }
  ]`;

  const parsed = safeParseAIJSON(jsonWithDialogue);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, '流放西州');
  assert.equal(parsed[1].title, '灵泉救亲');
  assert.match(parsed[0].content, /姐姐/);
});

test('safeParseAIJSON accepts logger as second argument without mutating logger object', () => {
  const dummyLog = {
    warn: () => {},
    info: () => {},
    error: () => {},
  };
  const jsonStr = `{"episode": 1, "title": "测试集", "content": "正文内容"}`;
  const parsed = safeParseAIJSON(jsonStr, dummyLog);
  assert.equal(parsed.episode, 1);
  assert.equal(parsed.title, '测试集');
  assert.equal(typeof dummyLog.warn, 'function');
  assert.equal(dummyLog.title, undefined);
  assert.equal(dummyLog.content, undefined);
});

test('safeParseAIJSON detects truncation only when container is truly unclosed', () => {
  const metaClosed = { truncated: false };
  const closedJson = `[{"episode": 1, "title": "完结集", "content": "对白："说完了。""}]`;
  safeParseAIJSON(closedJson, null, null, metaClosed);
  assert.equal(metaClosed.truncated, false);

  const metaTruncated = { truncated: false };
  const truncatedJson = `[{"episode": 1, "title": "第一集", "content": "完整"}, {"episode": 2, "title": "第二集截断`;
  const parsedTrunc = safeParseAIJSON(truncatedJson, null, null, metaTruncated);
  assert.equal(metaTruncated.truncated, true);
  assert.equal(Array.isArray(parsedTrunc), true);
  assert.equal(parsedTrunc.length >= 1, true);
});

test('parseStoryResponse parses multi-episode arrays properly', () => {
  const raw = `[
    {"episode": 1, "title": "第1集 启程", "content": "开始流放"},
    {"episode": 2, "title": "第2集 荒原", "content": "遭遇沙暴"}
  ]`;
  const result = parseStoryResponse(raw, 2);
  assert.equal(result.episodes.length, 2);
  assert.equal(result.episodes[0].episode, 1);
  assert.equal(result.episodes[0].title, '第1集 启程');
  assert.equal(result.episodes[1].episode, 2);
});

test('parseStoryResponse salvages multi-episode JSON via regex if safeParseAIJSON fails', () => {
  // Deliberately corrupted container with multiple valid episode blocks inside
  const semiBroken = `Some prefix text from LLM...
  {"episode": 1, "title": "第1集 边关", "content": "到达边关\\n苏晚：\\"立足\\""}
  {"episode": 2, "title": "第2集 种粮", "content": "开始耕种"}
  Some suffix notes from LLM...`;

  const result = parseStoryResponse(semiBroken, 2);
  assert.equal(result.episodes.length, 2);
  assert.equal(result.episodes[0].title, '第1集 边关');
  assert.equal(result.episodes[1].title, '第2集 种粮');
});

test('parseStoryResponse rejects unparseable broken multi-episode JSON instead of dumping into Episode 1', () => {
  const brokenJson = `[
    {"episode": 1, "title": "第1集", "content":
  `; // Unsalvageable syntax error starting with [
  assert.throws(() => {
    parseStoryResponse(brokenJson, 10);
  }, /无法正确切分多集|剧本被截断未完结/);
});

test('parseStoryResponse accepts genuine plain text as single episode', () => {
  const plainText = `西州边关，风沙漫天。苏晚站在城墙上，看着远处的麦浪。全剧终。`;
  const result = parseStoryResponse(plainText, 1);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].episode, 1);
  assert.equal(result.episodes[0].content, plainText);
});

test('parseStoryResponse rejects truncated multi-episode output to prevent silent episode loss', () => {
  const truncatedJson = `[{"episode": 1, "title": "第1集", "content": "第一集内容"}, {"episode": 2, "title": "第2集截断`;
  assert.throws(() => {
    parseStoryResponse(truncatedJson, 6);
  }, /剧本被截断未完结/);
});

test('parseStoryResponse rejects a clean one-of-six response instead of silently accepting one episode', () => {
  const cleanButIncomplete = JSON.stringify([
    { episode: 1, title: '第1集', content: '只有第一集的完整正文。' },
  ]);
  assert.throws(
    () => parseStoryResponse(cleanButIncomplete, 6),
    (err) => err.code === 'INVARIANT_EPISODE_SET_INCOMPLETE'
      && err.violations.some((v) => v.rule === 'INVARIANT_EPISODE_SET_INCOMPLETE')
  );
});
