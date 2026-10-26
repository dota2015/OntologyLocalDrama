"""Validate and upload normalized voice references for the native H3 R2V node."""
import base64
import binascii
import hashlib
import io
import wave

from fastapi import HTTPException

MAX_AUDIO_BYTES = 2 * 1024 * 1024


def audio_inputs(body):
    content = body.get("content", [])
    if not isinstance(content, list):
        raise HTTPException(422, "content must be an array")
    result = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "audio_url":
            continue
        value = item.get("audio_url")
        url = value.get("url") if isinstance(value, dict) else value
        if item.get("role") != "reference_audio" or not isinstance(url, str) or not url:
            raise HTTPException(422, "Each audio needs a URL and reference_audio role")
        result.append(url)
    if len(result) > 3:
        raise HTTPException(422, "H3 supports at most 3 reference voices per clip, including narration")
    return result


async def upload_audio(client, comfy_url, url):
    if url.startswith("data:"):
        header, separator, encoded = url.partition(",")
        if not separator or header not in ("data:audio/wav;base64", "data:audio/x-wav;base64"):
            raise HTTPException(422, "Voice references must be normalized PCM WAV")
        if len(encoded) > MAX_AUDIO_BYTES * 4 // 3 + 4:
            raise HTTPException(422, "Voice reference is too large")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(422, "Invalid voice reference base64")
    elif url.startswith(("http://", "https://")):
        data = bytearray()
        async with client.stream("GET", url, follow_redirects=True) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > MAX_AUDIO_BYTES:
                    raise HTTPException(422, "Voice reference is too large")
        data = bytes(data)
    else:
        raise HTTPException(422, "Voice references must use HTTP(S) or a WAV data URL")
    try:
        with wave.open(io.BytesIO(data)) as audio:
            duration = audio.getnframes() / audio.getframerate()
            valid = (audio.getcomptype() == "NONE" and audio.getnchannels() == 1
                     and audio.getsampwidth() == 2 and audio.getframerate() == 32000
                     and 2 <= duration <= 15.05)
            if not valid:
                raise ValueError("Unsupported WAV")
            if len(audio.readframes(audio.getnframes())) != audio.getnframes() * 2:
                raise ValueError("Truncated WAV")
    except (wave.Error, EOFError, ValueError, ZeroDivisionError):
        raise HTTPException(422, "Voice reference must be 2-15 seconds of mono 32kHz PCM16 WAV")
    filename = hashlib.sha256(data).hexdigest() + ".wav"
    # ComfyUI's generic input uploader uses the image field for all file types.
    response = await client.post(f"{comfy_url}/upload/image",
                                 files={"image": (filename, data, "audio/wav")},
                                 data={"subfolder": "localminidrama/voices", "type": "input", "overwrite": "true"})
    response.raise_for_status()
    uploaded = response.json()
    name, folder = uploaded.get("name", ""), uploaded.get("subfolder", "")
    if (not name or "/" in name or "\\" in name or folder.startswith("/") or "\\" in folder
            or ".." in folder.split("/") or uploaded.get("type", "input") != "input"):
        raise ValueError("Invalid ComfyUI voice upload response")
    return f"{folder}/{name}" if folder else name
