// Offline, deterministic fixture export. No API calls or production DB writes.
// node scripts/quality_prompt_comparison.js <baseline-repo> <output-directory>
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const baseline = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const fixtures = require('../backend-node/test/fixtures/qualityShots');
const oldH3 = require(path.join(baseline, 'backend-node/src/services/h3NativeService'));
const newH3 = require('../backend-node/src/services/h3NativeService');
const oldImage = require(path.join(baseline, 'backend-node/src/ontology/visualSlots'));
const newImage = require('../backend-node/src/ontology/visualSlots');
const runs = [];
for (const f of fixtures) {
  const single = [f.segment];
  const cuts = [0, 2, 4].map((start, index) => ({ ...f.segment, duration: 2, shot_number: index + 1, timestamp: index ? `00:0${start}.000` : null }));
  for (const stage of ['baseline', 'rhythm_only', 'simplified']) {
    const compiler = stage === 'simplified' ? newH3 : oldH3;
    const timeline = stage === 'baseline' ? cuts : single;
    const contract = compiler.buildDirectH3TextContract(f.shot, timeline);
    const prompt = compiler.compilePrompt(f.refs, f.speech, contract, {}, { timeline, duration: 6, allowChinese: true });
    runs.push({ case: f.name, kind: 'video', stage, seed: 20261030, prompt, refs: f.refs, audio: f.speech.references, parameters: { width: 1344, height: 768, duration: 6, steps: 23 }, expected_speech: f.speech.lines.map(l => l.text) });
  }
  for (const stage of ['baseline', 'simplified']) {
    const compiler = stage === 'baseline' ? oldImage : newImage;
    const prompt = compiler.compileImagePromptFromSlots(f.shot, f.shot.character_visuals);
    const referenceHeader = f.refs.map((r,i) => `参考图 ${i+1}：${r.character_id ? `角色「${f.shot.character_visuals.find(v=>v.character_id === r.character_id).name}」的身份与服装参考` : '场景环境参考'}`).join('\n');
    runs.push({ case: f.name, kind: 'image', stage, seed: 20261030, prompt: referenceHeader + '\n当前画面：\n' + prompt, refs: f.refs, parameters: { width: 1344, height: 768, steps: 20 } });
  }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ baseline, current: root, limitation: 'Controls deterministic compiler changes; does not measure the removed nondeterministic image-polishing LLM. Single seed is a smoke comparison, not a quality benchmark.', runs }, null, 2));
console.log(`Exported ${runs.length} controlled inputs to ${out}`);
