/**
 * TTS 语音合成服务
 * 支持多种 TTS 接口：minimax、edge-tts（本地）、通用 HTTP
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');

async function synthesizeWithEdgeTts(text, voice, speed) {
  const tmpFile = path.join('/tmp', `edge_${randomUUID().slice(0, 8)}.mp3`);
  const ratePct = Math.round(((speed || 1.0) - 1.0) * 100);
  const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;
  const voiceName = voice || 'zh-CN-YunjianNeural';
  return new Promise((resolve, reject) => {
    execFile('edge-tts', ['--voice', voiceName, '--rate', rateStr, '--text', text, '--write-media', tmpFile], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }, (err) => {
      if (err) { try { fs.unlinkSync(tmpFile); } catch (_) {} return reject(err); }
      try {
        const buf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        resolve(buf);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * 使用 MiniMax T2A v2 合成语音
 */
async function synthesizeWithMinimax(text, voiceId, apiKey, groupId, model, speed) {
  const body = JSON.stringify({
    model: model || 'speech-02-hd',
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId || 'female-shaonv',
      speed: speed || 1.0,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  });
  const url = `https://api.minimax.chat/v1/t2a_v2?GroupId=${groupId}`;
  return new Promise((resolve, reject) => {
    const reqOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.request(urlObj, reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`MiniMax TTS HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
          return;
        }
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.base_resp?.status_code !== 0) {
          reject(new Error(`MiniMax TTS error: ${data.base_resp?.status_msg || 'unknown'}`));
          return;
        }
        const audioHex = data.data?.audio;
        if (!audioHex) { reject(new Error('MiniMax TTS 未返回音频')); return; }
        resolve(Buffer.from(audioHex, 'hex'));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 使用 IndexTTS 2.5 Gradio API 合成语音（部署于 10.10.13.15:7860 等 GPU 实例）
 * 支持参考音色复刻克隆与 duration_factor 语速控制
 */
async function synthesizeWithIndexTts(text, voiceRef, baseUrl, speed, storageBase) {
  const origin = (baseUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '');

  // 1. 准备参考音频（prompt audio）
  let promptFileData = null;
  let resolvedRefPath = null;
  const sampleName = voiceRef ? path.basename(voiceRef) : 'voice_03.wav';

  if (voiceRef) {
    if (path.isAbsolute(voiceRef) && fs.existsSync(voiceRef)) {
      resolvedRefPath = voiceRef;
    } else if (storageBase && fs.existsSync(path.join(storageBase, voiceRef))) {
      resolvedRefPath = path.join(storageBase, voiceRef);
    }
  }

  // 若尚未找到，寻找内置预设音频
  if (!resolvedRefPath || !fs.existsSync(resolvedRefPath)) {
    const candidates = [
      path.join(__dirname, '../assets/indextts', sampleName),
      path.join(__dirname, '../assets/indextts', 'voice_03.wav'),
      path.join('/home/nvidia/IndexTTS2/examples', sampleName),
      path.join('/home/nvidia/IndexTTS2/examples', 'voice_03.wav'),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        resolvedRefPath = cand;
        break;
      }
    }
  }

  if (resolvedRefPath && fs.existsSync(resolvedRefPath)) {
    try {
      const form = new FormData();
      const buf = fs.readFileSync(resolvedRefPath);
      form.append('files', new Blob([buf]), path.basename(resolvedRefPath));
      const upRes = await fetch(`${origin}/gradio_api/upload`, { method: 'POST', body: form });
      if (upRes.ok) {
        const [remotePath] = await upRes.json();
        promptFileData = { path: remotePath, orig_name: path.basename(resolvedRefPath), meta: { _type: 'gradio.FileData' } };
      } else {
        const errText = await upRes.text();
        console.warn('[IndexTTS] 上传参考音频失败:', upRes.status, errText);
      }
    } catch (e) {
      console.warn('[IndexTTS] 上传参考音频异常:', e.message);
    }
  }

  if (!promptFileData) {
    throw new Error('IndexTTS 无法准备参考音频文件，请上传样音或选择预设音色');
  }

  // 2. 语速映射：系统 speed > 1 变快，IndexTTS duration_factor < 1 变快变短
  const s = Number(speed) > 0 ? Number(speed) : 1.0;
  const durationFactor = Math.max(0.5, Math.min(2.0, Number((1.0 / s).toFixed(2))));

  // 3. 提交合成任务到 Gradio 5 /gen_single
  const postRes = await fetch(`${origin}/gradio_api/call/gen_single`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [
        'Same as the voice reference', // 0 emo_control_method
        promptFileData,                // 1 prompt
        text,                          // 2 text
        'ZH',                          // 3 lang_choice
        null,                          // 4 emo_ref_path
        0.65,                          // 5 emo_weight
        0, 0, 0, 0, 0, 0, 0, 0,        // 6-13 emotion vectors
        '',                            // 14 emo_text
        false,                         // 15 emo_random
        120,                           // 16 max_text_tokens_per_segment
        durationFactor,                // 17 duration_factor
        true, 0.8, 30, 0.8, 0, 3, 10, 1500
      ]
    })
  });
  if (!postRes.ok) {
    const errText = await postRes.text();
    throw new Error(`IndexTTS 请求失败 HTTP ${postRes.status}: ${errText.slice(0, 300)}`);
  }
  const { event_id } = await postRes.json();
  if (!event_id) throw new Error('IndexTTS 未返回 event_id');

  // 4. 获取 SSE 结果流
  const sseRes = await fetch(`${origin}/gradio_api/call/gen_single/${event_id}`);
  const sseText = await sseRes.text();
  if (sseText.includes('event: error')) {
    throw new Error('IndexTTS 生成异常: ' + sseText.slice(0, 300));
  }
  const match = sseText.match(/data:\s*(\[[\s\S]*?\])\s*(?:\n|$)/);
  if (!match) throw new Error('IndexTTS 未返回合法数据流');
  const resultData = JSON.parse(match[1]);
  const audioInfo = resultData[0]?.value;
  const audioUrl = audioInfo?.url || (audioInfo?.path ? `${origin}/gradio_api/file=${audioInfo.path}` : null);
  if (!audioUrl) throw new Error('IndexTTS 返回结果中缺少音频 URL');

  // 5. 下载音频流
  const dlRes = await fetch(audioUrl);
  if (!dlRes.ok) throw new Error(`IndexTTS 音频下载失败 HTTP ${dlRes.status}`);
  return Buffer.from(await dlRes.arrayBuffer());
}

/**
 * 使用 OpenAI TTS API 合成语音（兼容所有 OpenAI 格式的代理）
 * POST {base_url}/audio/speech  body: { model, input, voice, response_format, speed }
 */
async function synthesizeWithOpenai(text, voice, apiKey, baseUrl, model, speed) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/speech';
  const body = JSON.stringify({
    model: model || 'tts-1',
    input: text,
    voice: voice || 'alloy',
    response_format: 'mp3',
    speed: speed || 1.0,
  });
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    };
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenAI TTS HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`));
          return;
        }
        resolve(buf);
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('OpenAI TTS 请求超时')); }, 120000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

/**
 * 合成 TTS 并保存到本地文件
 * @returns {{ local_path: string, audio_url: string }}
 */
function isIndexTts(config) {
  return /^(indextts|indextts2|indextts25)$/i.test(config?.provider || '') || /7860/i.test(config?.base_url || '');
}
function defaultSpeed(config) {
  let settings = {};
  try { settings = typeof config?.settings === 'string' ? JSON.parse(config.settings) : (config?.settings || {}); } catch (_) {}
  const configured = Number(settings.speed);
  return Number.isFinite(configured) && configured > 0 ? configured : (isIndexTts(config) ? 1.25 : 1);
}

async function synthesize(db, log, { text, storyboard_id, config, storage_base, voice_id, speed }) {
  if (!text || !text.trim()) throw new Error('text 不能为空');
  const aiConfigService = require('./aiConfigService');
  const ttsConfig = config || (() => {
    const configs = aiConfigService.listConfigs(db, 'tts');
    const active = configs.filter((c) => c.is_active);
    return active.find((c) => c.is_default) || active[0];
  })();
  if (!ttsConfig) throw new Error('未配置 TTS 模型，请在「AI 配置」中添加 service_type=tts 的配置');

  const provider = (ttsConfig.provider || '').toLowerCase();
  let ttsSettings = {};
  try { ttsSettings = JSON.parse(ttsConfig.settings || '{}'); } catch (_) {}
  // 外部传入的 voice_id / speed 优先（海外化场景），否则取配置值
  const voiceId = voice_id || ttsConfig.voice_id || ttsSettings.voice_id || '';
  const groupId = ttsConfig.group_id || ttsSettings.group_id || '';
  const ttsModel = ttsConfig.default_model || (Array.isArray(ttsConfig.model) ? ttsConfig.model[0] : ttsConfig.model) || '';
  const finalSpeed = speed || defaultSpeed(ttsConfig);
  let audioBuffer;

  if (provider === 'indextts' || provider === 'indextts2' || provider === 'indextts25' || (ttsConfig.base_url && /7860/i.test(ttsConfig.base_url))) {
    audioBuffer = await synthesizeWithIndexTts(
      text,
      voiceId,
      ttsConfig.base_url || 'http://127.0.0.1:7860',
      finalSpeed,
      storage_base
    );
  } else if (provider === 'edge-tts' || provider === 'edgetts' || provider === 'edge') {
    audioBuffer = await synthesizeWithEdgeTts(
      text,
      voiceId || 'zh-CN-YunjianNeural',
      finalSpeed
    );
  } else if (provider === 'minimax') {
    audioBuffer = await synthesizeWithMinimax(
      text,
      voiceId || 'female-shaonv',
      ttsConfig.api_key,
      groupId,
      ttsModel || 'speech-02-hd',
      finalSpeed
    );
  } else if (provider === 'openai' || ttsConfig.base_url) {
    audioBuffer = await synthesizeWithOpenai(
      text,
      voiceId || 'alloy',
      ttsConfig.api_key,
      ttsConfig.base_url,
      ttsModel || 'tts-1',
      finalSpeed
    );
  } else {
    // 默认回退到 edge-tts
    audioBuffer = await synthesizeWithEdgeTts(
      text,
      voiceId || 'zh-CN-YunjianNeural',
      finalSpeed
    );
  }

  // 保存到本地
  const audioDir = path.join(storage_base, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
  const filename = `tts_sb${storyboard_id || 'x'}_${randomUUID().slice(0, 8)}.mp3`;
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, audioBuffer);
  const localPath = `audio/${filename}`;
  log.info('[TTS] 合成完成', { storyboard_id, local_path: localPath, provider });
  try { const cs = require('./cloudService'); cs.reportUsage('tts', ttsModel || '', '', 0); } catch (_) {}
  return { local_path: localPath };
}

module.exports = { synthesize, isIndexTts, defaultSpeed };
