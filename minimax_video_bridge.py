"""LocalMiniDrama ComfyUI adapter: H3 or Wan2.2, selected by bridge config."""

import asyncio
import base64
import binascii
import hashlib
import io
import json
import logging
import math
import os
import re
import time
from pathlib import Path
from uuid import UUID

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from h3_audio_reference import audio_inputs, upload_audio

PROJECT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get(
    "MINIMAX_BRIDGE_CONFIG", PROJECT_DIR / "configs/minimax_video_bridge.json"
))
if not CONFIG_PATH.is_absolute():
    CONFIG_PATH = PROJECT_DIR / CONFIG_PATH
with CONFIG_PATH.open(encoding="utf-8") as config_file:
    CONFIG = json.load(config_file)


def project_path(value):
    path = Path(value)
    return path if path.is_absolute() else PROJECT_DIR / path


COMFY_URL = CONFIG.get("comfy_url", "").rstrip("/")
COMFY_URLS = [
    url.rstrip("/")
    for url in (
        CONFIG.get("comfy_urls")
        or ([CONFIG["comfy_url"]] if "comfy_url" in CONFIG else [])
    )
]
if not COMFY_URLS:
    raise RuntimeError("No comfy_url or comfy_urls defined in configuration")
if not COMFY_URL:
    COMFY_URL = COMFY_URLS[0]
WORKFLOW_PATH = project_path(CONFIG["workflow_path"])
CONTINUUM_WORKFLOW_PATH = project_path(CONFIG["continuum_workflow_path"]) if CONFIG.get("continuum_workflow_path") else None
CONTINUUM_NODES = CONFIG.get("continuum_nodes") or {}
STORAGE_DIR = project_path(CONFIG["storage_dir"])
PUBLIC_BASE_URL = CONFIG["public_base_url"].rstrip("/")
ENGINE = CONFIG.get("engine", "minimax_h3")
MODEL_LABEL = "Wan2.2" if ENGINE == "wan22" else "MiniMax-H3"
FPS = 16 if ENGINE == "wan22" else 24
DEFAULT_DURATION = 5
DEFAULT_H3_STEPS = 23
MAX_DURATION = 30
SINGLE_MAX_DURATION = 8
CONTINUUM_MIN_DURATION = 9
MAX_IMAGE_BYTES = 20 * 1024 * 1024
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
TASKS_DB_FILE = STORAGE_DIR / "bridge_tasks.json"

log = logging.getLogger("uvicorn.error")
app = FastAPI(title=f"LocalMiniDrama {MODEL_LABEL} ComfyUI Video Adapter")
app.mount("/static", StaticFiles(directory=str(STORAGE_DIR)), name="static")
tasks_db = {}
download_locks = {}


def _load_tasks():
    if TASKS_DB_FILE.is_file():
        try:
            with TASKS_DB_FILE.open("r", encoding="utf-8") as f:
                saved = json.load(f)
                if isinstance(saved, dict):
                    tasks_db.update(saved)
        except Exception as e:
            log.warning("Could not load bridge tasks: %s", e)


def _save_task(task_id, task_data):
    try:
        tasks_db[task_id] = task_data
        tmp = TASKS_DB_FILE.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(tasks_db, f)
        tmp.replace(TASKS_DB_FILE)
    except Exception as e:
        log.warning("Could not save bridge task %s: %s", task_id, e)


_load_tasks()


async def get_instance_load(client: httpx.AsyncClient, base_url: str):
    """Query queue length on a ComfyUI instance. Returns (running + pending, base_url)."""
    try:
        resp = await client.get(f"{base_url}/queue", timeout=3.0)
        resp.raise_for_status()
        data = resp.json()
        running = len(data.get("queue_running", []))
        pending = len(data.get("queue_pending", []))
        return (running + pending, base_url)
    except Exception as exc:
        log.warning("Failed to query queue from %s: %s", base_url, exc)
        return (float("inf"), base_url)


async def select_best_comfy_instance(client: httpx.AsyncClient) -> str:
    """Select the ComfyUI instance with the least load (running + pending)."""
    if len(COMFY_URLS) == 1:
        return COMFY_URLS[0]
    results = await asyncio.gather(*(get_instance_load(client, url) for url in COMFY_URLS))
    best_load, best_url = min(results, key=lambda x: x[0])
    if math.isinf(best_load):
        log.error("All ComfyUI instances failed to report queue; falling back to %s", COMFY_URLS[0])
        return COMFY_URLS[0]
    log.info("Selected ComfyUI instance %s (current load: %s)", best_url, best_load)
    return best_url


def prepare_workflow(body):
    """Generate on H3's 17k+5 frame grid, then trim both streams at 24 fps."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="Request body must be an object")
    if ENGINE == "wan22":
        from wan22_workflow import prepare_workflow as prepare_wan
        return prepare_wan(body, WORKFLOW_PATH)
    raw_duration = body.get("duration")
    if raw_duration is None:
        raw_duration = body.get("seconds", DEFAULT_DURATION)
    try:
        if isinstance(raw_duration, bool):
            raise ValueError
        duration = float(raw_duration)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="duration/seconds must be a number")
    backend = str(body.get("execution_backend") or ("h3_continuum" if duration >= CONTINUUM_MIN_DURATION else "h3_single")).strip().lower()
    if not math.isfinite(duration) or not 4 <= duration <= MAX_DURATION or duration != round(duration):
        raise HTTPException(status_code=422, detail=f"duration/seconds must be an integer between 4 and {MAX_DURATION}")
    if backend not in ("h3_single", "h3_continuum"):
        raise HTTPException(status_code=422, detail="execution_backend must be h3_single or h3_continuum")
    if backend == "h3_single" and duration > SINGLE_MAX_DURATION:
        raise HTTPException(status_code=422, detail="普通 H3 只支持 4–8 秒；9–30 秒必须使用已配置的 Continuum workflow")
    if backend == "h3_continuum" and duration < CONTINUUM_MIN_DURATION:
        raise HTTPException(status_code=422, detail="Continuum 只支持 9–30 秒逻辑分镜")
    # Persist the normalized routing decision for conditioning and task
    # metadata even when a direct API caller omitted execution_backend.
    body["execution_backend"] = backend

    if backend == "h3_continuum":
        if not CONTINUUM_WORKFLOW_PATH or not CONTINUUM_WORKFLOW_PATH.is_file():
            raise HTTPException(status_code=503, detail="H3 Continuum workflow 尚未配置；请在 bridge 配置中设置 continuum_workflow_path，禁止降级为普通 H3")
        return prepare_continuum_workflow(body, duration)

    output_frames = math.ceil(duration * FPS)
    generation_frames = output_frames + (5 - output_frames) % 17
    output_duration = output_frames / FPS
    prompt_text = body.get("prompt", "")
    content = body.get("content", [])
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                prompt_text = item.get("text", prompt_text)
    prompt_text = str(prompt_text or "Cinematic video shot, high quality, realistic")

    with WORKFLOW_PATH.open(encoding="utf-8") as workflow_file:
        workflow = json.load(workflow_file)
    workflow["8"]["inputs"]["steps"] = DEFAULT_H3_STEPS
    workflow["5"]["inputs"]["prompt"] = prompt_text
    workflow["5"]["inputs"]["length"] = generation_frames
    workflow["9"]["inputs"]["noise_seed"] = int(time.time() * 1000) % 1000000
    workflow["13"]["inputs"]["fps"] = FPS
    workflow["15"]["inputs"]["length"] = output_frames
    workflow["16"]["inputs"]["duration"] = output_duration
    return workflow, prompt_text, output_duration, generation_frames


def _continuum_node(workflow, key):
    node_id = CONTINUUM_NODES.get(key)
    if node_id is None:
        return None
    node = workflow.get(str(node_id)) or workflow.get(node_id)
    return node if isinstance(node, dict) else None


def prepare_continuum_workflow(body, duration):
    """Load the separately exported Continuum API graph.

    The custom node package exposes a graph rather than a REST duration knob.
    Node IDs are deliberately configured instead of guessed from a graph, so a
    mismatched workflow fails before it reaches ComfyUI.
    """
    try:
        with CONTINUUM_WORKFLOW_PATH.open(encoding="utf-8") as workflow_file:
            workflow = json.load(workflow_file)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"无法读取 H3 Continuum workflow: {exc}")
    if not isinstance(workflow, dict) or not workflow:
        raise HTTPException(status_code=503, detail="H3 Continuum workflow 为空或不是 API 格式")
    prompt_text = body.get("prompt", "")
    for item in body.get("content", []) if isinstance(body.get("content"), list) else []:
        if isinstance(item, dict) and item.get("type") == "text":
            prompt_text = item.get("text", prompt_text)
    # V3.9 keeps fixed reference slots as @R1…@R9 and resolves them to the
    # chunk-local <Picture N> order internally.  Business prompts use H3's
    # normal <Picture N> syntax, so adapt only the tag spelling here.
    prompt_text = re.sub(r"<Picture\s+([1-9])>", lambda match: f"@R{match.group(1)}", str(prompt_text or ""), flags=re.IGNORECASE)
    prompt_node = _continuum_node(workflow, "prompt")
    sampler_node = _continuum_node(workflow, "sampler")
    if not prompt_node or not sampler_node:
        raise HTTPException(status_code=503, detail="H3 Continuum workflow 缺少 bridge continuum_nodes.prompt/sampler 映射")
    prompt_node.setdefault("inputs", {})[CONTINUUM_NODES.get("prompt_input", "prompt")] = str(prompt_text or "Cinematic continuous shot")
    chunk_plan = body.get("continuum_plan") or {}
    chunks = chunk_plan.get("chunks")
    chunk_seconds = chunk_plan.get("chunk_seconds")
    if chunks is None and chunk_seconds is None:
        chunks = max(2, math.ceil(duration / 10))
        chunk_seconds = duration / chunks
    try:
        if isinstance(chunks, bool) or isinstance(chunk_seconds, bool):
            raise ValueError
        chunks = int(chunks)
        chunk_seconds = float(chunk_seconds)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="Continuum chunks/chunk_seconds 必须是数字")
    if not 1 <= chunks <= 16 or not 4 <= chunk_seconds <= 15:
        raise HTTPException(status_code=422, detail="Continuum 物理片段必须为 1～16 段，每段 4～15 秒")
    if not math.isclose(chunks * chunk_seconds, duration, abs_tol=1e-6):
        raise HTTPException(status_code=422, detail=f"Continuum 物理片段合计 {chunks * chunk_seconds:g} 秒，与逻辑分镜 {duration:g} 秒不一致")
    sampler_inputs = sampler_node.setdefault("inputs", {})
    sampler_inputs[CONTINUUM_NODES.get("chunks_input", "chunks")] = chunks
    sampler_inputs[CONTINUUM_NODES.get("chunk_seconds_input", "chunk_seconds")] = chunk_seconds
    sampler_inputs[CONTINUUM_NODES.get("seed_input", "base_seed")] = int(time.time() * 1000) % 1000000000

    native = body.get("h3_native")
    scheduler_node = _continuum_node(workflow, "scheduler")
    if native is not None:
        if not isinstance(native, dict):
            raise HTTPException(422, "h3_native must be an object")
        width, height, steps = native.get("width"), native.get("height"), native.get("steps", DEFAULT_H3_STEPS)
        if (type(width) is not int or type(height) is not int or type(steps) is not int
                or min(width, height) < 32 or max(width, height) > 4096
                or width % 32 or height % 32 or width * height > 1344 * 768
                or not 20 <= steps <= 50):
            raise HTTPException(422, "Invalid H3 native canvas or step count")
        sampler_inputs[CONTINUUM_NODES.get("width_input", "width")] = width
        sampler_inputs[CONTINUUM_NODES.get("height_input", "height")] = height
        sampler_inputs[CONTINUUM_NODES.get("size_source_input", "size_source")] = "Manual"
        if scheduler_node:
            scheduler_node.setdefault("inputs", {})[CONTINUUM_NODES.get("steps_input", "steps")] = steps
    return workflow, str(prompt_text or "Cinematic continuous shot"), float(duration), None


def execution_snapshot(workflow, prompt_id):
    """Report the executed sampler values, not estimated request defaults."""
    def inputs(node):
        return workflow.get(node, {}).get("inputs", {})
    if workflow.get("10", {}).get("class_type") == "H3ContinuumSamplerV39":
        sampler = inputs("10")
        return {
            "prompt_id": prompt_id,
            "model": inputs("1").get("unet_name"),
            "mode": "ref2va_continuum",
            "text_encoder": inputs("2").get("clip_name"),
            "video_vae": inputs("3").get("vae_name"),
            "audio_vae": inputs("4").get("vae_name"),
            "width": sampler.get("width"),
            "height": sampler.get("height"),
            "generation_frames": None,
            "output_frames": None,
            "output_duration": sampler.get("chunks", 0) * sampler.get("chunk_seconds", 0),
            "fps": FPS,
            "steps": inputs("5").get("steps"),
            "scheduler": inputs("5").get("scheduler"),
            "sampler": inputs("7").get("sampler_name"),
            "seed": sampler.get("base_seed"),
            "seed_source": "executed_workflow",
            "chunks": sampler.get("chunks"),
            "chunk_seconds": sampler.get("chunk_seconds"),
        }
    return {
        "prompt_id": prompt_id,
        "model": inputs("1").get("unet_name"),
        "mode": "ref2va" if workflow.get("5", {}).get("class_type") == "MiniMaxH3ReferenceToVideo" else "fl2va",
        "text_encoder": inputs("2").get("clip_name"),
        "video_vae": inputs("3").get("vae_name"),
        "audio_vae": inputs("4").get("vae_name"),
        "width": inputs("5").get("width"),
        "height": inputs("5").get("height"),
        "generation_frames": inputs("5").get("length"),
        "output_frames": inputs("15").get("length"),
        "output_duration": inputs("16").get("duration"),
        "fps": inputs("13").get("fps"),
        "steps": inputs("8").get("steps"),
        "scheduler": inputs("8").get("scheduler"),
        "sampler": inputs("7").get("sampler_name"),
        "seed": inputs("9").get("noise_seed"),
        "seed_source": "executed_workflow",
    }


def image_inputs(body):
    """Preserve explicit frame/reference roles; never silently drop supplied images."""
    content = body.get("content", [])
    if not isinstance(content, list):
        raise HTTPException(422, "content must be an array")
    images = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") not in ("text", "image_url", "audio_url"):
            raise HTTPException(422, "Only text, image_url and audio_url content is supported")
        if item["type"] in ("text", "audio_url"):
            continue
        role = item.get("role")
        value = item.get("image_url")
        url = value.get("url") if isinstance(value, dict) else value
        if role not in ("first_frame", "last_frame", "reference_image") or not isinstance(url, str) or not url.strip():
            raise HTTPException(422, "Each image needs a URL and first_frame, last_frame or reference_image role")
        images.append((role, url.strip()))
    roles = [role for role, _ in images]
    if roles.count("reference_image") > 9:
        raise HTTPException(422, "Use up to 9 reference images")
    frame_roles = [role for role in roles if role != "reference_image"]
    if len(set(frame_roles)) != len(frame_roles):
        raise HTTPException(422, "Only one image per frame role is supported")
    return images


async def upload_image(client, url, comfy_url=None):
    """Copy an HTTP/base64 image to ComfyUI's input directory as a validated PNG."""
    target_comfy = (comfy_url or COMFY_URL).rstrip("/")
    if url.startswith("data:"):
        header, separator, encoded = url.partition(",")
        if not separator or not header.startswith("data:image/") or not header.endswith(";base64"):
            raise HTTPException(422, "Image data URLs must contain base64 image data")
        if len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 4:
            raise HTTPException(422, "Image exceeds 20 MiB")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(422, "Invalid image base64")
    elif url.startswith(("http://", "https://")):
        data = bytearray()
        async with client.stream("GET", url, follow_redirects=True) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_IMAGE_BYTES:
                    raise HTTPException(422, "Image exceeds 20 MiB")
    else:
        raise HTTPException(422, "Images must use HTTP(S) or base64 data URLs")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 40_000_000:
                raise HTTPException(422, "Image exceeds 40 megapixels")
            image = ImageOps.exif_transpose(image).convert("RGB")
            size = image.size
            output = io.BytesIO()
            image.save(output, format="PNG")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, "Image could not be decoded")
    png = output.getvalue()
    filename = hashlib.sha256(png).hexdigest() + ".png"
    response = await client.post(f"{target_comfy}/upload/image", files={"image": (filename, png, "image/png")},
                                 data={"subfolder": "localminidrama", "type": "input", "overwrite": "true"})
    response.raise_for_status()
    uploaded = response.json()
    name = uploaded.get("name", "")
    folder = uploaded.get("subfolder", "")
    parts = (folder + "/" + name).split("/")
    if not name or "/" in name or "\\" in name or folder.startswith("/") or ".." in parts or uploaded.get("type", "input") != "input":
        raise ValueError("Invalid ComfyUI image upload response")
    return (f"{folder}/{name}" if folder else name) + " [input]", size


async def condition_continuum_workflow(client, body, workflow, comfy_url):
    """Bind media to the explicitly mapped Continuum API graph."""
    images = image_inputs(body)
    audios = audio_inputs(body)
    if any(role != "reference_image" for role, _ in images):
        raise HTTPException(422, "Continuum 使用 Ref2VA，只接收 reference_image；请勿提交首帧或尾帧")
    image_bundle = _continuum_node(workflow, "reference_images")
    audio_bundle = _continuum_node(workflow, "reference_audios")
    if images and not image_bundle:
        raise HTTPException(503, "Continuum workflow 缺少 reference_images 映射")
    if audios and not audio_bundle:
        raise HTTPException(503, "Continuum workflow 缺少 reference_audios 映射")
    uploaded_images = {}
    for index, (role, url) in enumerate(images):
        if url not in uploaded_images:
            uploaded_images[url] = await upload_image(client, url, comfy_url)
        node_id = str(200 + index)
        workflow[node_id] = {"class_type": "LoadImage", "inputs": {
            CONTINUUM_NODES.get("image_input", "image"): uploaded_images[url][0],
        }}
        image_bundle.setdefault("inputs", {})[f"{CONTINUUM_NODES.get('reference_image_prefix', 'reference_image_')}{index + 1}"] = [node_id, 0]
    for index, url in enumerate(audios):
        uploaded = await upload_audio(client, comfy_url, url)
        node_id = str(300 + index)
        workflow[node_id] = {"class_type": "LoadAudio", "inputs": {
            CONTINUUM_NODES.get("audio_input", "audio"): uploaded,
        }}
        audio_bundle.setdefault("inputs", {})[f"{CONTINUUM_NODES.get('reference_audio_prefix', 'reference_audio_')}{index + 1}"] = [node_id, 0]
    return workflow


async def condition_workflow(client, body, workflow, comfy_url=None):
    target_comfy = (comfy_url or COMFY_URL).rstrip("/")
    if str(body.get("execution_backend") or "").lower() == "h3_continuum":
        return await condition_continuum_workflow(client, body, workflow, target_comfy)
    audios = audio_inputs(body)
    if ENGINE == "wan22" and audios:
        raise HTTPException(422, "Wan2.2 does not support reference audio")
    if ENGINE == "wan22":
        from wan22_workflow import condition_workflow as condition_wan
        return await condition_wan(client, body, workflow, image_inputs, lambda c, u: upload_image(c, u, target_comfy))
    images = image_inputs(body)
    references = any(role == "reference_image" for role, _ in images)
    inputs = workflow["5"]["inputs"]
    native = body.get("h3_native")
    if native is not None:
        if not isinstance(native, dict):
            raise HTTPException(422, "h3_native must be an object")
        width, height, steps = native.get("width"), native.get("height"), native.get("steps", DEFAULT_H3_STEPS)
        if (type(width) is not int or type(height) is not int or type(steps) is not int
                or min(width, height) < 32 or max(width, height) > 4096
                or width % 32 or height % 32 or width * height > 1344 * 768
                or not 20 <= steps <= 50):
            raise HTTPException(422, "Invalid H3 native canvas or step count")
        inputs["width"], inputs["height"] = width, height
        workflow["8"]["inputs"]["steps"] = steps
    first_size = None
    use_ref_model = references or bool(audios)
    if use_ref_model:
        workflow["1"]["inputs"]["unet_name"] = CONFIG.get("reference_model", "minimax_h3_ref2va_pruned-Q6_K.gguf")
        workflow["5"]["class_type"] = "MiniMaxH3ReferenceToVideo"
        inputs["ref_image_size"] = "match"
    if audios:
        inputs["audio_vae"] = ["4", 0]
        # Audio references preserve the requested sampler step count.
        for index, url in enumerate(audios):
            uploaded = await upload_audio(client, target_comfy, url)
            node_id = str(60 + index)
            workflow[node_id] = {"class_type": "LoadAudio", "inputs": {"audio": uploaded}}
            inputs[f"ref_audios.ref_audio_{index}"] = [node_id, 0]
    if references:
        def reference_tag(match):
            index = int(match.group(1) or match.group(2))
            if not 1 <= index <= sum(role == "reference_image" for role, _ in images):
                raise HTTPException(422, f"Reference slot {index} has no supplied image")
            return f"<Picture {index}>"
        inputs["prompt"] = re.sub(r"@图片(\d+)|<IMAGE_(\d+)>", reference_tag, inputs["prompt"])
    reference_index = 0
    uploaded_images = {}
    for index, (role, url) in enumerate(images):
        if url not in uploaded_images:
            uploaded_images[url] = await upload_image(client, url, target_comfy)
        uploaded, size = uploaded_images[url]
        node_id = str(20 + index)
        workflow[node_id] = {"class_type": "LoadImage", "inputs": {"image": uploaded}}
        if role == "reference_image":
            inputs[f"ref_images.ref_image_{reference_index}"] = [node_id, 0]
            reference_index += 1
        else:
            if use_ref_model:
                # R2V has no first/last input sockets: retain explicit anchors with AddGuide.
                guide_id = str(40 + index)
                workflow[guide_id] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                    "positive": workflow["6"]["inputs"]["conditioning"], "latent": ["5", 1],
                    "vae": ["3", 0], "image": [node_id, 0],
                    "frame_idx": 0 if role == "first_frame" else workflow["15"]["inputs"]["length"] - 1,
                }}
                workflow["6"]["inputs"]["conditioning"] = [guide_id, 0]
            else:
                inputs[role] = [node_id, 0]
            if role == "first_frame" and body.get("ratio", "adaptive") == "adaptive":
                first_size = size
            if not use_ref_model and role == "last_frame" and inputs["length"] != workflow["15"]["inputs"]["length"]:
                # The model's final frame is trimmed off; also anchor the retained final frame.
                workflow["17"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {
                    "positive": ["5", 0], "latent": ["5", 1], "vae": ["3", 0],
                    "image": [node_id, 0], "frame_idx": workflow["15"]["inputs"]["length"] - 1,
                }}
                workflow["6"]["inputs"]["conditioning"] = ["17", 0]
    ratio = body.get("ratio")
    value = first_size[0] / first_size[1] if first_size else inputs["width"] / inputs["height"]
    if ratio and ratio != "adaptive":
        try:
            w, h = (float(x) for x in ratio.split(":"))
            value = w / h
            if not math.isfinite(value) or not 1 / 4 <= value <= 4:
                raise ValueError
        except (ValueError, TypeError, AttributeError, ZeroDivisionError):
            raise HTTPException(422, "ratio must be a valid aspect ratio between 1:4 and 4:1")
    if native is None and (images or (ratio and ratio != "adaptive")):
        # H3 patches keyframe latents in 2x2 blocks: both canvas axes must be multiples of 32.
        # Match aspect on the long axis while keeping the original pixel budget.
        if not math.isfinite(value) or not 1 / 4 <= value <= 4:
            raise HTTPException(422, "Image aspect must be between 1:4 and 4:1")
        area = inputs["width"] * inputs["height"]
        long_ratio = max(value, 1 / value)
        short = max(32, int(math.sqrt(area / long_ratio) / 32) * 32)
        long = max(32, round(short * long_ratio / 32) * 32)
        while short * long > area and long > 32:
            long -= 32
        inputs["width"], inputs["height"] = (long, short) if value >= 1 else (short, long)


@app.get("/health")
async def health():
    return {"status": "ok", "engine": ENGINE, "workflow": str(WORKFLOW_PATH), "fps": FPS,
            "instances": COMFY_URLS,
            "continuum": bool(CONTINUUM_WORKFLOW_PATH and CONTINUUM_WORKFLOW_PATH.is_file()),
            "audio": ENGINE != "wan22",
            "conditioning": ["first_frame", "last_frame"] if ENGINE == "wan22" else ["first_frame", "last_frame", "reference_image", "reference_audio"],
            "max_voice_references": 0 if ENGINE == "wan22" else 3}


async def get_instance_detail(client: httpx.AsyncClient, base_url: str):
    start = time.time()
    try:
        resp = await client.get(f"{base_url}/queue", timeout=3.0)
        latency_ms = round((time.time() - start) * 1000)
        if resp.status_code == 200:
            data = resp.json()
            running = len(data.get("queue_running", []))
            pending = len(data.get("queue_pending", []))
            return {
                "url": base_url,
                "online": True,
                "latency_ms": latency_ms,
                "queue_running": running,
                "queue_pending": pending,
                "load": running + pending,
            }
        return {"url": base_url, "online": False, "latency_ms": latency_ms, "error": f"HTTP {resp.status_code}"}
    except Exception as exc:
        return {"url": base_url, "online": False, "latency_ms": None, "error": str(exc)}


@app.get("/v1/instances")
async def list_instances():
    async with httpx.AsyncClient(timeout=3.5) as client:
        results = await asyncio.gather(*(get_instance_detail(client, url) for url in COMFY_URLS))
    return {
        "status": "ok",
        "engine": ENGINE,
        "instances": list(results),
        "count": len(COMFY_URLS),
        "config_path": str(CONFIG_PATH),
    }


@app.put("/v1/instances")
async def update_instances(request: Request):
    global COMFY_URLS, COMFY_URL
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Request body must be JSON")
    new_urls = body.get("instances")
    if not isinstance(new_urls, list) or not new_urls:
        raise HTTPException(status_code=400, detail="instances must be a non-empty list of URLs")
    cleaned = []
    for u in new_urls:
        if not isinstance(u, str):
            continue
        cleaned_url = u.strip().rstrip("/")
        if cleaned_url.startswith(("http://", "https://")) and cleaned_url not in cleaned:
            cleaned.append(cleaned_url)
    if not cleaned:
        raise HTTPException(status_code=400, detail="At least one valid http/https URL is required")

    COMFY_URLS = cleaned
    COMFY_URL = cleaned[0]
    CONFIG["comfy_urls"] = cleaned
    CONFIG["comfy_url"] = cleaned[0]
    try:
        with CONFIG_PATH.open("w", encoding="utf-8") as f:
            json.dump(CONFIG, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        log.warning("Could not persist updated instances to %s: %s", CONFIG_PATH, e)

    log.info("Updated ComfyUI instances pool: %s", COMFY_URLS)
    return await list_instances()


@app.post("/v1/instances/test")
async def test_instance_endpoint(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Request body must be JSON")
    url = (body.get("url") or "").strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Valid URL starting with http:// or https:// required")
    async with httpx.AsyncClient(timeout=4.0) as client:
        return await get_instance_detail(client, url)


@app.post("/v1/videos")
async def create_video(request: Request):
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Request body must be JSON")
    workflow, prompt_text, duration, generation_frames = prepare_workflow(body)
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            target_comfy = await select_best_comfy_instance(client)
            await condition_workflow(client, body, workflow, target_comfy)
            resp = await client.post(f"{target_comfy}/prompt", json={"prompt": workflow})
            resp.raise_for_status()
            prompt_id = resp.json().get("prompt_id")
    except (httpx.HTTPError, ValueError) as exc:
        log.exception("ComfyUI submission failed")
        raise HTTPException(status_code=502, detail=f"ComfyUI submission failed: {exc}")
    if not prompt_id:
        raise HTTPException(status_code=502, detail="ComfyUI did not return a prompt_id")

    execution = execution_snapshot(workflow, prompt_id) if ENGINE == "minimax_h3" else None
    task_data = {
        "id": prompt_id,
        "status": "processing",
        "prompt": prompt_text,
        "created_at": time.time(),
        "duration": duration,
        "execution_backend": body.get("execution_backend", "h3_single"),
        "continuum_plan": body.get("continuum_plan") if body.get("execution_backend") == "h3_continuum" else None,
        "chunk_status": ([{"chunk_index": item.get("chunk_index"), "status": "submitted", "start_seconds": item.get("start_seconds"), "duration_seconds": item.get("duration_seconds")} for item in (body.get("continuum_plan") or {}).get("slices", [])]
                         if body.get("execution_backend") == "h3_continuum" else []),
        "video_url": None,
        "comfy_url": target_comfy,
        "execution": execution,
    }
    _save_task(prompt_id, task_data)
    log.info("%s task=%s on %s duration=%ss generation_frames=%s fps=%s",
             MODEL_LABEL, prompt_id, target_comfy, duration, generation_frames, FPS)
    return {"id": prompt_id, "object": "video", "created": int(time.time()),
            "status": "processing", "duration": duration,
            "execution_backend": body.get("execution_backend", "h3_single"),
            "continuum_plan": body.get("continuum_plan") if body.get("execution_backend") == "h3_continuum" else None,
            "execution": execution}


def completed_response(task_id, video_url):
    return {"id": task_id, "status": "completed", "video_url": video_url,
            "output": {"video_url": video_url}}


@app.get("/v1/videos/{task_id}")
async def get_video(task_id: str):
    # ComfyUI prompt IDs are UUIDs; validate before using them as local filenames.
    try:
        UUID(task_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Unknown task")
    local_dest = STORAGE_DIR / f"{task_id}.mp4"
    video_url = f"{PUBLIC_BASE_URL}/static/{task_id}.mp4"
    if local_dest.is_file() and local_dest.stat().st_size:
        return completed_response(task_id, video_url)

    known_comfy = tasks_db.get(task_id, {}).get("comfy_url")
    candidate_urls = [known_comfy] if known_comfy else list(COMFY_URLS)

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            history = None
            resolved_comfy = None
            for candidate in candidate_urls:
                try:
                    response = await client.get(f"{candidate}/history/{task_id}", timeout=10.0)
                    if response.status_code == 200:
                        hist_data = response.json().get(task_id)
                        if hist_data:
                            history = hist_data
                            resolved_comfy = candidate
                            break
                except Exception:
                    continue

            # If not in history on known candidate, search remaining candidates
            if not history and known_comfy and len(COMFY_URLS) > 1:
                other_candidates = [u for u in COMFY_URLS if u != known_comfy]
                for candidate in other_candidates:
                    try:
                        response = await client.get(f"{candidate}/history/{task_id}", timeout=10.0)
                        if response.status_code == 200:
                            hist_data = response.json().get(task_id)
                            if hist_data:
                                history = hist_data
                                resolved_comfy = candidate
                                break
                    except Exception:
                        continue

            if not history:
                # ComfyUI keeps running/pending prompts in /queue; check candidate instances
                check_queue_urls = [resolved_comfy or known_comfy] if (resolved_comfy or known_comfy) else COMFY_URLS
                found_in_queue = False
                for candidate in check_queue_urls:
                    try:
                        q_resp = await client.get(f"{candidate}/queue", timeout=3.0)
                        if q_resp.status_code == 200:
                            q_data = q_resp.json()
                            in_running = any(item[1] == task_id for item in q_data.get("queue_running", []))
                            in_pending = any(item[1] == task_id for item in q_data.get("queue_pending", []))
                            if in_running or in_pending:
                                found_in_queue = True
                                resolved_comfy = candidate
                                if task_id not in tasks_db:
                                    tasks_db[task_id] = {"id": task_id, "status": "processing", "comfy_url": candidate}
                                else:
                                    tasks_db[task_id]["comfy_url"] = candidate
                                _save_task(task_id, tasks_db[task_id])
                                break
                    except Exception as q_exc:
                        log.warning("ComfyUI queue check failed on %s: %s", candidate, q_exc)
                        continue

                if found_in_queue:
                    meta = tasks_db.get(task_id, {})
                    return {"id": task_id, "status": "processing", "execution_backend": meta.get("execution_backend", "h3_single"),
                            "continuum_plan": meta.get("continuum_plan"), "chunk_status": meta.get("chunk_status", [])}

                task_meta = tasks_db.get(task_id)
                if task_meta and (time.time() - task_meta.get("created_at", 0) < 30):
                    return {"id": task_id, "status": "processing"}

                return {"id": task_id, "status": "failed",
                        "error": "任务在推理服务中不存在或已被终止（服务重启或任务丢失）"}

            status = history.get("status", {})
            if status.get("status_str") == "error":
                messages = status.get("messages", [])
                error = next((m[1].get("exception_message") for m in messages
                              if len(m) > 1 and m[0] == "execution_error" and isinstance(m[1], dict)), None)
                message = str(error or "ComfyUI execution error")[:2000]
                if task_id in tasks_db:
                    tasks_db[task_id]["status"] = "failed"
                    for chunk in tasks_db[task_id].get("chunk_status", []):
                        if chunk.get("status") == "submitted": chunk["status"] = "failed"
                    tasks_db[task_id]["error"] = message
                    _save_task(task_id, tasks_db[task_id])
                return {"id": task_id, "status": "failed", "error": message}

            # Only consume SaveVideo's result, not previews from other nodes.
            output = history.get("outputs", {}).get("14", {})
            files = output.get("images") or output.get("videos") or output.get("gifs") or []
            if not files:
                meta = tasks_db.get(task_id, {})
                return {"id": task_id, "status": "processing", "execution_backend": meta.get("execution_backend", "h3_single"),
                        "continuum_plan": meta.get("continuum_plan"), "chunk_status": meta.get("chunk_status", [])}
            file_info = files[0]
            lock = download_locks.setdefault(task_id, asyncio.Lock())
            async with lock:
                if not (local_dest.is_file() and local_dest.stat().st_size):
                    partial = local_dest.with_suffix(".mp4.part")
                    try:
                        # ComfyUI serves its outputs over HTTP; no SSH environment is needed.
                        download_url = f"{resolved_comfy or COMFY_URL}/view"
                        async with client.stream("GET", download_url, params={
                            "filename": file_info["filename"],
                            "subfolder": file_info.get("subfolder", ""),
                            "type": file_info.get("type", "output"),
                        }) as video_response:
                            video_response.raise_for_status()
                            with partial.open("wb") as video_file:
                                async for chunk in video_response.aiter_bytes():
                                    video_file.write(chunk)
                        if not partial.stat().st_size:
                            raise ValueError("ComfyUI returned an empty video")
                        partial.replace(local_dest)
                    finally:
                        partial.unlink(missing_ok=True)
            if task_id not in tasks_db:
                tasks_db[task_id] = {"id": task_id}
            tasks_db[task_id].update(status="completed", video_url=video_url, comfy_url=resolved_comfy)
            if tasks_db[task_id].get("chunk_status"):
                for chunk in tasks_db[task_id]["chunk_status"]:
                    chunk["status"] = "completed"
            _save_task(task_id, tasks_db[task_id])
            return completed_response(task_id, video_url)
    except (httpx.HTTPError, ValueError, OSError) as exc:
        log.exception("ComfyUI poll/download failed for %s", task_id)
        raise HTTPException(status_code=502, detail=f"ComfyUI poll/download failed: {exc}")


if __name__ == "__main__":
    uvicorn.run(app, host=CONFIG.get("host", "0.0.0.0"), port=int(CONFIG.get("port", 5688)))
