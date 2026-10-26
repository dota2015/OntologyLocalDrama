"""Wan2.2 I2V 14B FP8 + official LightX2V four-step workflow parameters."""
import json
import math
import secrets
from fastapi import HTTPException

FPS = 16
MAX_DURATION = 10


def prepare_workflow(body, workflow_path):
    if not isinstance(body, dict):
        raise HTTPException(422, 'Request body must be an object')
    model = body.get('model')
    if model and model != 'Wan2.2-I2V-A14B-FP8-4steps':
        raise HTTPException(422, 'This bridge is running Wan2.2-I2V-A14B-FP8-4steps, not ' + str(model))
    raw = body.get('duration', body.get('seconds', 5))
    try:
        if isinstance(raw, bool):
            raise ValueError
        duration = float(raw)
        if not math.isfinite(duration) or not 1 <= duration <= MAX_DURATION:
            raise ValueError
    except (ValueError, TypeError):
        raise HTTPException(422, 'Wan2.2 duration must be between 1 and 10 seconds')
    # Wan's temporal grid is 4k+1. Keep every frame, including the end anchor,
    # and retime the container slightly to match the requested duration exactly.
    frames = math.ceil(duration * FPS / 4) * 4 + 1
    prompt = body.get('prompt', '')
    content = body.get('content', [])
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                prompt = item.get('text', prompt)
    seed = body.get('seed')
    if seed is None or seed == -1:
        seed = secrets.randbits(53)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**64 - 1:
        raise HTTPException(422, 'seed must be an unsigned integer, -1 or omitted')
    workflow = json.loads(workflow_path.read_text(encoding='utf-8'))
    workflow['6']['inputs']['text'] = str(prompt or 'Cinematic continuous motion, consistent character appearance')
    workflow['67']['inputs']['length'] = frames
    workflow['57']['inputs']['noise_seed'] = seed
    workflow['60']['inputs']['fps'] = frames / duration
    return workflow, workflow['6']['inputs']['text'], duration, frames


async def condition_workflow(client, body, workflow, image_inputs, upload_image):
    images = image_inputs(body)
    if not images or not any(role == 'first_frame' for role, _ in images):
        raise HTTPException(422, 'Wan2.2 I2V requires a first_frame; references alone are unsupported')
    if any(role == 'reference_image' for role, _ in images):
        raise HTTPException(422, 'Wan2.2 I2V supports first/last frames, not reference image lists')
    first_size = None
    inputs = workflow['67']['inputs']
    for i, (role, url) in enumerate(images):
        uploaded, size = await upload_image(client, url)
        node_id = str(20 + i)
        workflow[node_id] = {'class_type': 'LoadImage', 'inputs': {'image': uploaded}}
        inputs['start_image' if role == 'first_frame' else 'end_image'] = [node_id, 0]
        if role == 'first_frame':
            first_size = size
    ratio = body.get('ratio', 'adaptive')
    try:
        if not ratio or ratio == 'adaptive':
            value = first_size[0] / first_size[1]
        else:
            w, h = (float(x) for x in ratio.split(':'))
            value = w / h
        if not math.isfinite(value) or not 1/4 <= value <= 4:
            raise ValueError
    except (ValueError, TypeError, AttributeError, ZeroDivisionError):
        raise HTTPException(422, 'ratio must be between 1:4 and 4:1')
    # Same conservative local canvas budget as H3; 32 alignment also meets Wan's 16.
    area = 768 * 432
    long_ratio = max(value, 1/value)
    short = max(32, int(math.sqrt(area / long_ratio) / 32) * 32)
    long = max(32, round(short * long_ratio / 32) * 32)
    while short * long > area and long > 32:
        long -= 32
    inputs['width'], inputs['height'] = (long, short) if value >= 1 else (short, long)
