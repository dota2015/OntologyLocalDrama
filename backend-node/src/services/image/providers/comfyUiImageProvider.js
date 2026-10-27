/**
 * ComfyUI Qwen-Image-2.1 图片生成策略 (ComfyUiImageProvider)
 * 遵循策略模式 (Strategy Pattern)，直接对接 ComfyUI API 执行多参考图、多角色及文生图推理。
 */

const fs = require('fs');
const path = require('path');
const { BaseImageProvider, resolveImageRef, clampAndAlignSize } = require('../baseProvider');

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const client = isHttps ? require('https') : require('http');
    const req = client.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Fetch image failed HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Fetch image timeout')); });
  });
}

function uploadImageToComfy(comfyUrl, buffer, filename = 'ref.png') {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const postData = [];

    postData.push(Buffer.from(`--${boundary}\r\n`));
    postData.push(Buffer.from(`Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`));
    postData.push(Buffer.from('Content-Type: image/png\r\n\r\n'));
    postData.push(buffer);
    postData.push(Buffer.from('\r\n'));

    postData.push(Buffer.from(`--${boundary}\r\n`));
    postData.push(Buffer.from('Content-Disposition: form-data; name="subfolder"\r\n\r\n'));
    postData.push(Buffer.from('localminidrama\r\n'));

    postData.push(Buffer.from(`--${boundary}\r\n`));
    postData.push(Buffer.from('Content-Disposition: form-data; name="overwrite"\r\n\r\n'));
    postData.push(Buffer.from('true\r\n'));
    postData.push(Buffer.from(`--${boundary}--\r\n`));

    const fullBody = Buffer.concat(postData);

    const urlObj = new URL('/upload/image', comfyUrl);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? require('https') : require('http');

    const req = client.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const sub = parsed.subfolder ? `${parsed.subfolder}/` : '';
          resolve(`${sub}${parsed.name}`);
        } catch (e) {
          reject(new Error(`ComfyUI upload response invalid: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ComfyUI upload timeout')); });
    req.write(fullBody);
    req.end();
  });
}

function submitComfyPrompt(comfyUrl, workflow) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ prompt: workflow });
    const urlObj = new URL('/prompt', comfyUrl);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? require('https') : require('http');

    const req = client.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(`ComfyUI error: ${JSON.stringify(parsed.error)}`));
          if (!parsed.prompt_id) return reject(new Error(`ComfyUI no prompt_id: ${raw}`));
          resolve(parsed.prompt_id);
        } catch (e) {
          reject(new Error(`ComfyUI prompt response invalid: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ComfyUI prompt submission timeout')); });
    req.write(payload);
    req.end();
  });
}

async function pollComfyResult(comfyUrl, promptId, maxTimeoutMs = 300000) {
  const startTime = Date.now();
  const pollUrl = `${comfyUrl}/history/${promptId}`;

  while (Date.now() - startTime < maxTimeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const resp = await fetch(pollUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const hist = await resp.json();
        if (hist && hist[promptId]) {
          const entry = hist[promptId];
          const status = entry.status || {};
          if (status.status_str === 'error') {
            const msgs = status.messages ? JSON.stringify(status.messages) : 'Unknown error';
            throw new Error(`ComfyUI execution error: ${msgs}`);
          }
          const outputs = entry.outputs || {};
          for (const nodeId of Object.keys(outputs)) {
            const nodeOut = outputs[nodeId];
            if (nodeOut && Array.isArray(nodeOut.images) && nodeOut.images.length > 0) {
              return nodeOut.images[0];
            }
          }
        }
      }
    } catch (e) {
      if (e.message.includes('ComfyUI execution error')) throw e;
    }
  }
  throw new Error(`ComfyUI prompt ${promptId} timed out after ${maxTimeoutMs / 1000}s`);
}

class ComfyUiImageProvider extends BaseImageProvider {
  constructor() {
    super('comfyui');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return proto === 'comfyui' || proto === 'comfyui_image' || p === 'comfyui' || p === 'comfyui_image';
  }

  async generateImage({ db, config, log, opts, effectivePrompt, mergedNegativePrompt, model, size }) {
    const clampedSize = clampAndAlignSize(size || '1024x1024', 2048, 256, 32);
    const [wStr, hStr] = clampedSize.split('x');
    const width = parseInt(wStr, 10) || 1024;
    const height = parseInt(hStr, 10) || 1024;

    const comfyBaseUrl = (config.base_url || 'http://10.10.13.7:8188').replace(/\/$/, '');
    log?.info?.('[ComfyUI图生] 开始处理生成请求', { comfyBaseUrl, width, height, model });

    // 1. 上传参考图（如有）
    const { reference_image_urls, files_base_url, storage_local_path } = opts;
    const rawRefs = (reference_image_urls || []).filter(Boolean);
    const uploadedImages = [];

    for (let i = 0; i < rawRefs.length; i++) {
      const ref = rawRefs[i];
      const resolved = resolveImageRef(ref, files_base_url, storage_local_path);
      if (!resolved) continue;

      let buffer = null;
      try {
        if (resolved.startsWith('data:')) {
          const base64Data = resolved.split(',')[1];
          buffer = Buffer.from(base64Data, 'base64');
        } else if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
          buffer = await fetchBuffer(resolved);
        } else if (fs.existsSync(resolved)) {
          buffer = fs.readFileSync(resolved);
        }
      } catch (err) {
        log?.warn?.('[ComfyUI图生] 读取参考图失败，已跳过', { ref, error: err.message });
      }

      if (buffer) {
        try {
          const uploadedName = await uploadImageToComfy(comfyBaseUrl, buffer, `ref_${Date.now()}_${i}.png`);
          if (uploadedName) {
            uploadedImages.push(uploadedName);
          }
        } catch (err) {
          log?.warn?.('[ComfyUI图生] 上传参考图到 ComfyUI 失败', { error: err.message });
        }
      }
    }

    log?.info?.('[ComfyUI图生] 参考图准备就绪', { uploadedCount: uploadedImages.length });

    // 2. 组装 ComfyUI 工作流 Prompt
    const workflow = {
      '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image-2.1-Q8_0.gguf' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'Qwen-Image-2.1-text_encoder-FP8.safetensors', type: 'qwen_image' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
    };

    const textEncodeInputs = {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: effectivePrompt || '',
      negative_prompt: mergedNegativePrompt || 'blurry, ugly, distorted, deformed, extra limbs',
      resolution: 512,
    };

    for (let i = 0; i < uploadedImages.length; i++) {
      const loadNodeId = String(20 + i);
      workflow[loadNodeId] = {
        class_type: 'LoadImage',
        inputs: { image: uploadedImages[i] },
      };
      textEncodeInputs[`images.image_${i + 1}`] = [loadNodeId, 0];
    }

    workflow['4'] = {
      class_type: 'TextEncodeQwenImage21',
      inputs: textEncodeInputs,
    };

    workflow['5'] = {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
    };

    const guidance = opts.guidance != null ? Number(opts.guidance) : 2.0;
    const steps = opts.steps ? Number(opts.steps) : 20;
    const seed = opts.seed != null ? Number(opts.seed) : Math.floor(Math.random() * 10000000000000);

    workflow['6'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['4', 1],
        latent_image: ['5', 0],
        seed,
        steps,
        cfg: guidance,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
      },
    };

    workflow['7'] = {
      class_type: 'VAEDecode',
      inputs: { samples: ['6', 0], vae: ['3', 0] },
    };

    const prefix = `qwen_${opts.storyboard_id ? 'sb_' + opts.storyboard_id : 'gen'}`;
    workflow['8'] = {
      class_type: 'SaveImage',
      inputs: { images: ['7', 0], filename_prefix: prefix },
    };

    // 3. 提交任务并轮询
    try {
      const promptId = await submitComfyPrompt(comfyBaseUrl, workflow);
      log?.info?.('[ComfyUI图生] 任务提交成功，开始轮询', { promptId });
      const imgInfo = await pollComfyResult(comfyBaseUrl, promptId, 300000);

      const filename = typeof imgInfo === 'string' ? imgInfo : imgInfo.filename;
      const sub = (typeof imgInfo === 'object' && imgInfo.subfolder) ? `&subfolder=${encodeURIComponent(imgInfo.subfolder)}` : '';
      const type = (typeof imgInfo === 'object' && imgInfo.type) ? `&type=${encodeURIComponent(imgInfo.type)}` : '&type=output';
      const viewUrl = `${comfyBaseUrl}/view?filename=${encodeURIComponent(filename)}${sub}${type}`;

      const imageBuffer = await fetchBuffer(viewUrl);
      const base64Url = `data:image/png;base64,${imageBuffer.toString('base64')}`;

      log?.info?.('[ComfyUI图生] 图片生成完成并拉回本地', { filename, width, height, sizeBytes: imageBuffer.length });
      return {
        image_url: base64Url,
        size: `${width}x${height}`,
        width,
        height,
      };
    } catch (err) {
      log?.error?.('[ComfyUI图生] 生成失败', { error: err.message });
      return { error: err.message || 'ComfyUI 图片生成失败' };
    }
  }
}

module.exports = {
  ComfyUiImageProvider,
};
