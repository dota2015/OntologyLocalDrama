const { postJSONWithTimeout } = require('./aiClient');
const endpointQueues = new Map();

function serviceRoot(config) {
  return new URL(String(config.base_url || '').replace(/\/$/, '')
    .replace(/\/v1$/, '').replace(/\/api\/inference$/, '') + '/');
}

// A single resident diffusion model must not receive overlapping generations
// from the application's batch workers (or simultaneous single-image clicks).
async function callUnslothImageApi(config, log, opts) {
  let key;
  try { key = serviceRoot(config).href; } catch (_) { return { error: 'Unsloth 服务地址无效' }; }
  const previous = endpointQueues.get(key) || Promise.resolve();
  const work = previous.then(() => generateUnslothImage(config, log, opts));
  const settled = work.then(() => {}, () => {});
  endpointQueues.set(key, settled);
  try { return await work; }
  finally { if (endpointQueues.get(key) === settled) endpointQueues.delete(key); }
}

function smallerMemorySize(detail, body, multiple) {
  // Retry only an explicit pre-generation memory refusal. Runtime OOMs,
  // timeouts and other HTTP failures may follow a started job: never resubmit.
  const need = /needs about ([\d.]+) GB of working memory/i.exec(detail);
  const free = /only about ([\d.]+) GB is usable/i.exec(detail);
  const fixed = /including about ([\d.]+) GB of fixed overhead/i.exec(detail);
  if (!need || !free) return null;
  const needed = Number(need[1]), usable = Number(free[1]), overhead = Number(fixed?.[1] || 0);
  if (!(needed > usable && usable > overhead && needed > overhead)) return null;
  const scale = Math.sqrt(Math.min(0.7, (usable * 0.85 - overhead) / (needed - overhead)));
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = Math.round(body.width * scale / multiple) * multiple;
  const height = Math.round(body.height * scale / multiple) * multiple;
  if (width < 256 || height < 256 || width >= body.width || height >= body.height) return null;
  return { width, height };
}

// Unsloth's /v1/images/generations silently ignores image inputs. Its native
// reference workflow accepts init_image and reference_images instead.
async function generateUnslothImage(config, log, opts) {
  try {
    const root = serviceRoot(config);
    const endpoint = suffix => new URL('api/inference/images/' + suffix, root).href;
    const auth = { Authorization: 'Bearer ' + (config.api_key || '') };
    const statusResponse = await fetch(endpoint('status'), {
      headers: auth, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!statusResponse.ok) throw new Error('无法读取 Unsloth 模型状态（HTTP ' + statusResponse.status + '）');
    const status = await statusResponse.json();
    if (!status.loaded) throw new Error('Unsloth 尚未加载图片模型，请先在 Unsloth Desktop 中加载');
    const refs = opts.reference_image_urls || [];
    if (refs.length && !(status.workflows || []).includes('reference')) {
      throw new Error('Unsloth 当前模型不支持参考图生成，请加载支持 reference 的图片模型');
    }
    if (refs.length > Number(status.conditioning?.max_condition_images || 1)) {
      throw new Error('参考图数量超过 Unsloth 当前模型上限，请减少参考图');
    }
    // Do not auto-load or switch the resident model on the user's GPU.
    const resident = status.repo_id;
    if (resident && opts.model && resident.toLowerCase() !== opts.model.toLowerCase()) {
      throw new Error('Unsloth 当前加载的图片模型与 AI 配置不一致，请核对模型名称');
    }
    const size = /^(\d+)[x*](\d+)$/.exec(opts.size || '1024x1024');
    if (!size) throw new Error('Unsloth 图片尺寸须为宽x高');
    const multiple = Number(status.conditioning?.dimension_multiple) || 16;
    const width = Math.floor(Number(size[1]) / multiple) * multiple;
    const height = Math.floor(Number(size[2]) / multiple) * multiple;
    if (width < 256 || height < 256 || width > (status.conditioning?.max_output_side || 2752)
        || height > (status.conditioning?.max_output_side || 2752)
        || width * height > (status.conditioning?.max_output_pixels || Infinity)) {
      throw new Error('图片尺寸超过 Unsloth 当前模型支持范围，请降低尺寸');
    }
    const images = [];
    for (const ref of refs) {
      if (/^data:image\//i.test(ref || '')) {
        images.push(ref);
      } else if (/^https?:\/\//i.test(ref || '')) {
        // Never send the Unsloth access token to a reference-image host.
        const response = await fetch(ref, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('参考图下载失败（HTTP ' + response.status + '）');
        const mime = (response.headers.get('content-type') || '').split(';')[0];
        if (!mime.startsWith('image/')) throw new Error('参考图地址未返回图片，请重新上传');
        images.push('data:' + mime + ';base64,' + Buffer.from(await response.arrayBuffer()).toString('base64'));
      } else {
        throw new Error('参考图无法读取，请重新上传并保存，未执行纯文字降级生成');
      }
    }
    const referenceResolutions = (status.conditioning?.reference_resolutions || []).map(Number).filter(Number.isFinite);
    const referenceResolution = referenceResolutions.includes(1024) ? 1024 : referenceResolutions[0];
    const defaultGuidance = Number(status.generation_defaults?.guidance ?? 0);
    const body = {
      prompt: opts.prompt, width, height, batch_size: 1,
      steps: Number(status.generation_defaults?.steps) || 9,
      guidance: Number(opts.guidance ?? defaultGuidance),
      ...(status.supports_negative_prompt && opts.negative_prompt ? { negative_prompt: opts.negative_prompt } : {}),
      ...(images.length ? { workflow: 'reference', init_image: images[0], reference_images: images.slice(1) } : {}),
      ...(images.length && referenceResolution ? { reference_resolution: referenceResolution } : {}),
    };
    let result;
    const maxAttempts = images.length && referenceResolutions.includes(512) ? 4 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      log.info('Unsloth native image request', { reference_count: images.length, reference_resolution: body.reference_resolution, width: body.width, height: body.height, steps: body.steps, attempt: attempt + 1 });
      result = await postJSONWithTimeout(endpoint('generate'), {
        ...auth, 'Content-Type': 'application/json',
      }, body, 600000);
      if (result.statusCode >= 200 && result.statusCode < 300) break;
      let detail = '';
      try { detail = JSON.parse(result.raw).detail; } catch (_) {}
      const isOOM = (result.statusCode === 400 || result.statusCode === 500) &&
        typeof detail === 'string' &&
        (/out of memory/i.test(detail) || /needs about/i.test(detail) || /usable/i.test(detail));
      // Each input is encoded independently of the output canvas. With several
      // references this dominates memory, so shrinking the output alone cannot
      // fit the job. Use the model's advertised reference encoding tier first;
      // keep every original image, its ordering and its identity/wardrobe label.
      if (isOOM && body.reference_resolution > 512 && referenceResolutions.includes(512) && attempt < maxAttempts - 1) {
        log.warn('Unsloth 显存预检或运行时显存不足，降低参考图编码尺寸并保留输出尺寸及全部参考图重试', {
          reference_count: images.length, previous_reference_resolution: body.reference_resolution,
          reference_resolution: 512, size: `${body.width}x${body.height}`, attempt: attempt + 1,
        });
        body.reference_resolution = 512;
        continue;
      }
      const smaller = result.statusCode === 400 && typeof detail === 'string'
        ? smallerMemorySize(detail, body, multiple) : null;
      if (smaller && attempt < maxAttempts - 1) {
        log.warn('Unsloth 显存预检拒绝，保留全部参考图并降低输出尺寸重试', {
          requested_size: `${width}x${height}`, previous_size: `${body.width}x${body.height}`,
          next_size: `${smaller.width}x${smaller.height}`, reference_count: images.length,
        });
        Object.assign(body, smaller);
        continue;
      }
      throw new Error('Unsloth 图片生成失败（HTTP ' + result.statusCode + '）' + (typeof detail === 'string' ? '：' + detail.slice(0, 300) : ''));
    }
    const generated = JSON.parse(result.raw).images?.[0];
    if (!generated?.url) throw new Error('Unsloth 未返回生成的图片');
    const imageUrl = new URL(generated.url, root);
    if (imageUrl.origin !== root.origin) throw new Error('Unsloth 返回的图片地址不属于当前服务');
    const response = await fetch(imageUrl, {
      headers: auth, redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('Unsloth 生成图片读取失败（HTTP ' + response.status + '）');
    const mime = (response.headers.get('content-type') || '').split(';')[0];
    if (!mime.startsWith('image/')) throw new Error('Unsloth 生成结果不是图片');
    return {
      image_url: 'data:' + mime + ';base64,' + Buffer.from(await response.arrayBuffer()).toString('base64'),
      size: `${body.width}x${body.height}`, width: body.width, height: body.height,
    };
  } catch (error) {
    return { error: error.message || 'Unsloth 图片生成失败' };
  }
}

module.exports = { callUnslothImageApi };
