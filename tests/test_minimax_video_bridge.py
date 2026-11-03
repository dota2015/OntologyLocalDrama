import json
import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

import minimax_video_bridge as bridge
from PIL import Image

REAL_ASYNC_CLIENT = httpx.AsyncClient
TASK_ID = "00000000-0000-4000-8000-000000000001"


def comfy_client(handler):
    return patch.object(bridge.httpx, "AsyncClient", side_effect=lambda **kwargs:
                        REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler), **kwargs))


class DurationTests(unittest.TestCase):
    def test_workflow_is_owned_by_this_project(self):
        self.assertTrue(bridge.WORKFLOW_PATH.is_relative_to(bridge.PROJECT_DIR))
        self.assertTrue(bridge.WORKFLOW_PATH.is_file())

    def test_requested_durations_generate_enough_frames_and_trim_both_streams(self):
        for seconds, generation_frames in ((4, 107), (5, 124), (6, 158), (8, 192)):
            with self.subTest(seconds=seconds):
                workflow, _, duration, frames = bridge.prepare_workflow({"duration": seconds, "execution_backend": "h3_single"})
                self.assertEqual(frames, generation_frames)
                self.assertEqual(workflow["5"]["inputs"]["length"], generation_frames)
                self.assertEqual(frames % 17, 5)
                self.assertEqual(duration, seconds)
                self.assertEqual(workflow["13"]["inputs"],
                                 {"images": ["15", 0], "audio": ["16", 0], "fps": 24})
                self.assertEqual(workflow["15"]["inputs"]["image"], ["11", 0])
                self.assertEqual(workflow["15"]["inputs"]["length"], seconds * 24)
                self.assertEqual(workflow["16"]["inputs"]["audio"], ["12", 0])
                self.assertEqual(workflow["16"]["inputs"]["duration"], seconds)

    def test_accepts_seconds_alias_and_content_prompt(self):
        workflow, prompt, duration, _ = bridge.prepare_workflow({
            "seconds": "8", "execution_backend": "h3_single", "content": [{"type": "text", "text": "A forest in the wind"}],
        })
        self.assertEqual(duration, 8)
        self.assertEqual(prompt, "A forest in the wind")
        self.assertEqual(workflow["5"]["inputs"]["prompt"], prompt)

    def test_uses_five_seconds_when_duration_is_omitted(self):
        self.assertEqual(bridge.prepare_workflow({})[2], 5)

    def test_invalid_durations_are_rejected(self):
        for value in (None, True, "bad", "nan", "inf", 0, -1, 8.5, 31):
            with self.subTest(value=value), self.assertRaises(HTTPException) as error:
                bridge.prepare_workflow({"seconds": value})
            self.assertEqual(error.exception.status_code, 422)

    def test_long_duration_never_silently_falls_back_to_single_h3(self):
        with self.assertRaises(HTTPException) as error:
            bridge.prepare_workflow({"duration": 10})
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("Continuum", error.exception.detail)

    def test_configured_continuum_graph_receives_plan_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "continuum.json"
            path.write_text(json.dumps({
                "1": {"class_type": "Text", "inputs": {}},
                "2": {"class_type": "H3ContinuumSamplerV39", "inputs": {}},
            }), encoding="utf-8")
            with patch.object(bridge, "CONTINUUM_WORKFLOW_PATH", path), patch.object(bridge, "CONTINUUM_NODES", {
                "prompt": "1", "sampler": "2",
                "prompt_input": "prompt", "chunks_input": "chunks", "chunk_seconds_input": "chunk_seconds",
            }):
                workflow, prompt, duration, generation_frames = bridge.prepare_workflow({
                    "duration": 10, "execution_backend": "h3_continuum",
                    "prompt": "[0-10s] <Picture 1> performs a continuous action",
                    "continuum_plan": {"chunks": 1, "chunk_seconds": 10},
                })
            self.assertEqual(prompt, "[0-10s] @R1 performs a continuous action")
            self.assertEqual(duration, 10)
            self.assertIsNone(generation_frames)
            self.assertEqual(workflow["1"]["inputs"]["prompt"], prompt)
            self.assertEqual(workflow["2"]["inputs"]["chunks"], 1)
            self.assertEqual(workflow["2"]["inputs"]["chunk_seconds"], 10)

    def test_continuum_rejects_a_chunk_plan_that_does_not_cover_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "continuum.json"
            path.write_text(json.dumps({
                "1": {"class_type": "Text", "inputs": {}},
                "2": {"class_type": "H3ContinuumSamplerV39", "inputs": {}},
            }), encoding="utf-8")
            with patch.object(bridge, "CONTINUUM_WORKFLOW_PATH", path), patch.object(bridge, "CONTINUUM_NODES", {
                "prompt": "1", "sampler": "2",
            }), self.assertRaises(HTTPException) as error:
                bridge.prepare_workflow({
                    "duration": 11, "execution_backend": "h3_continuum",
                    "continuum_plan": {"chunks": 2, "chunk_seconds": 10},
                })
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("合计", error.exception.detail)

    def test_continuum_snapshot_reports_the_real_sampler_contract(self):
        workflow = json.loads((bridge.PROJECT_DIR / "workflows/selfhost/video_minimax_h3_continuum_api.json").read_text())
        snapshot = bridge.execution_snapshot(workflow, TASK_ID)
        self.assertEqual(snapshot["mode"], "ref2va_continuum")
        self.assertEqual(snapshot["output_duration"], 10)
        self.assertEqual(snapshot["chunks"], 2)
        self.assertEqual(snapshot["chunk_seconds"], 5)
        self.assertEqual(snapshot["steps"], 23)
        self.assertEqual(snapshot["width"], 1344)
        self.assertEqual(snapshot["height"], 768)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(bridge.app)
        bridge.tasks_db.clear()
        bridge.download_locks.clear()

    def test_submission_sends_duration_to_comfy(self):
        submitted = {}
        def handler(request):
            self.assertEqual(request.url.path, "/prompt")
            workflow = json.loads(request.content)["prompt"]
            submitted.update(workflow)
            self.assertEqual(workflow["8"]["inputs"]["steps"], 23)
            self.assertEqual(workflow["5"]["inputs"]["length"], 158)
            self.assertEqual(workflow["15"]["inputs"]["length"], 144)
            self.assertEqual(workflow["16"]["inputs"]["duration"], 6)
            return httpx.Response(200, json={"prompt_id": TASK_ID})

        with comfy_client(handler):
            response = self.client.post("/v1/videos", json={"duration": 6})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["duration"], 6)
        self.assertEqual(response.json()["id"], TASK_ID)
        execution = response.json()["execution"]
        self.assertEqual(execution["generation_frames"], 158)
        self.assertEqual(execution["output_frames"], 144)
        self.assertEqual(execution["seed"], submitted["9"]["inputs"]["noise_seed"])
        self.assertEqual(execution["model"], submitted["1"]["inputs"]["unet_name"])
        self.assertEqual(execution["sampler"], submitted["7"]["inputs"]["sampler_name"])
        self.assertEqual(execution["steps"], 23)
        self.assertNotIn("prompt", execution)
        self.assertNotIn("content", execution)

    def test_invalid_payload_does_not_submit_a_job(self):
        with comfy_client(lambda _: self.fail("Invalid input reached ComfyUI")):
            for body in ({"duration": 0}, [], {"duration": "bad"}):
                self.assertEqual(self.client.post("/v1/videos", json=body).status_code, 422)
            self.assertEqual(self.client.post("/v1/videos", content="{").status_code, 400)

    def image_url(self, size=(48, 32)):
        output = io.BytesIO()
        Image.new("RGB", size, "red").save(output, format="PNG")
        return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()

    def test_frame_images_are_uploaded_and_tail_anchor_survives_trimming(self):
        uploads = []
        def handler(request):
            if request.url.path == "/upload/image":
                uploads.append(request.content)
                return httpx.Response(200, json={"name": f"frame{len(uploads)}.png", "subfolder": "localminidrama", "type": "input"})
            self.assertEqual(request.url.path, "/prompt")
            workflow = json.loads(request.content)["prompt"]
            inputs = workflow["5"]["inputs"]
            self.assertEqual(workflow["5"]["class_type"], "MiniMaxH3ImageToVideo")
            self.assertEqual(workflow["1"]["inputs"]["unet_name"], "minimax_h3_fl2va_pruned-Q6_K.gguf")
            self.assertEqual(inputs["first_frame"], ["20", 0])
            self.assertEqual(inputs["last_frame"], ["21", 0])
            self.assertEqual((inputs["width"], inputs["height"]), (672, 448))
            self.assertEqual(inputs["width"] % 32, 0)
            self.assertEqual(inputs["height"] % 32, 0)
            self.assertEqual(workflow["20"]["inputs"]["image"], "localminidrama/frame1.png [input]")
            self.assertEqual(workflow["17"]["inputs"]["frame_idx"], 119)
            self.assertEqual(workflow["17"]["inputs"]["image"], ["21", 0])
            self.assertEqual(workflow["6"]["inputs"]["conditioning"], ["17", 0])
            self.assertEqual(workflow["15"]["inputs"]["length"], 120)
            return httpx.Response(200, json={"prompt_id": TASK_ID})
        with comfy_client(handler):
            response = self.client.post("/v1/videos", json={"duration": 5, "content": [
                {"type": "image_url", "role": role, "image_url": {"url": self.image_url()}}
                for role in ("first_frame", "last_frame")
            ]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(uploads), 1)  # identical frame bytes upload once; both timeline roles remain
        self.assertTrue(all(b"image/png" in upload for upload in uploads))

    def test_references_select_ref2va_and_preserve_picture_slots(self):
        def handler(request):
            if request.url.path == "/upload/image":
                return httpx.Response(200, json={"name": "reference.png", "subfolder": "localminidrama"})
            workflow = json.loads(request.content)["prompt"]
            inputs = workflow["5"]["inputs"]
            self.assertEqual(workflow["1"]["inputs"]["unet_name"], "minimax_h3_ref2va_pruned-Q6_K.gguf")
            self.assertEqual(workflow["5"]["class_type"], "MiniMaxH3ReferenceToVideo")
            self.assertEqual(inputs["prompt"], "<Picture 2> walks in <Picture 1>")
            self.assertEqual(inputs["ref_images.ref_image_0"], ["20", 0])
            self.assertEqual(inputs["ref_images.ref_image_1"], ["21", 0])
            self.assertEqual(inputs["vae"], ["3", 0])
            self.assertEqual(inputs["ref_image_size"], "match")
            self.assertNotIn("first_frame", inputs)
            return httpx.Response(200, json={"prompt_id": TASK_ID})
        with comfy_client(handler):
            response = self.client.post("/v1/videos", json={"content": [
                {"type": "text", "text": "@图片2 walks in <IMAGE_1>"},
                *[{"type": "image_url", "role": "reference_image", "image_url": {"url": self.image_url()}} for _ in range(2)],
            ]})
        self.assertEqual(response.status_code, 200, response.text)

    def test_bad_images_and_incompatible_roles_never_submit_text_only(self):
        bad = {"type": "image_url", "role": "first_frame", "image_url": {"url": "data:image/png;base64,bm90YW5pbWFnZQ=="}}
        ref = {"type": "image_url", "role": "reference_image", "image_url": {"url": self.image_url()}}
        with comfy_client(lambda _: self.fail("Invalid image reached ComfyUI")):
            for content in ([bad], [bad, ref], [ref] * 10, [{"type": "text", "text": "@图片2"}, ref]):
                response = self.client.post("/v1/videos", json={"content": content})
                self.assertEqual(response.status_code, 422, response.text)

    def test_http_image_failure_is_visible_before_prompt_submission(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://images.example/missing.png")
            return httpx.Response(404)
        with self.assertLogs(bridge.log, level="ERROR"), comfy_client(handler):
            response = self.client.post("/v1/videos", json={"content": [{
                "type": "image_url", "role": "first_frame", "image_url": {"url": "https://images.example/missing.png"},
            }]})
        self.assertEqual(response.status_code, 502)

    def test_portrait_first_frame_keeps_its_aspect_within_existing_pixel_budget(self):
        def handler(request):
            if request.url.path == "/upload/image":
                return httpx.Response(200, json={"name": "portrait.png"})
            inputs = json.loads(request.content)["prompt"]["5"]["inputs"]
            self.assertEqual((inputs["width"], inputs["height"]), (416, 736))
            return httpx.Response(200, json={"prompt_id": TASK_ID})
        with comfy_client(handler):
            response = self.client.post("/v1/videos", json={"ratio": "adaptive", "content": [{
                "type": "image_url", "role": "first_frame", "image_url": {"url": self.image_url((90, 160))},
            }]})
        self.assertEqual(response.status_code, 200, response.text)

    def test_download_uses_comfy_http_and_survives_bridge_restart(self):
        requests = []

        def handler(request):
            requests.append(request.url.path)
            if request.url.path.startswith("/history/"):
                return httpx.Response(200, json={TASK_ID: {
                    "status": {"status_str": "success"},
                    "outputs": {
                        "11": {"images": [{"filename": "preview.png"}]},
                        "14": {"images": [{"filename": "clip.mp4", "subfolder": "video", "type": "output"}]},
                    },
                }})
            self.assertEqual(request.url.path, "/view")
            self.assertEqual(request.url.params["filename"], "clip.mp4")
            self.assertEqual(request.url.params["subfolder"], "video")
            return httpx.Response(200, content=b"video bytes")

        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "STORAGE_DIR", Path(directory)):
            # A failed download from an older bridge must not count as a completed task.
            Path(directory, f"{TASK_ID}.mp4").touch()
            with comfy_client(handler):
                response = self.client.get(f"/v1/videos/{TASK_ID}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "completed")
            self.assertEqual(Path(directory, f"{TASK_ID}.mp4").read_bytes(), b"video bytes")
            self.assertFalse(list(Path(directory).glob("*.part")))
            with comfy_client(lambda _: self.fail("Cached task contacted ComfyUI")):
                cached = self.client.get(f"/v1/videos/{TASK_ID}")
            self.assertEqual(cached.json(), response.json())
        self.assertEqual(requests, [f"/history/{TASK_ID}", "/view"])

    def test_download_errors_are_visible_and_never_marked_completed(self):
        def handler(request):
            if request.url.path.startswith("/history/"):
                return httpx.Response(200, json={TASK_ID: {"outputs": {
                    "14": {"images": [{"filename": "clip.mp4"}]},
                }}})
            return httpx.Response(500)

        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "STORAGE_DIR", Path(directory)):
            with self.assertLogs(bridge.log, level="ERROR"), comfy_client(handler):
                response = self.client.get(f"/v1/videos/{TASK_ID}")
            self.assertEqual(response.status_code, 502)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_multi_instance_routing_picks_least_loaded_instance(self):
        instances = ["http://10.10.13.7:8188", "http://10.10.13.7:8189", "http://10.10.13.7:8191"]
        calls = []

        def handler(request):
            calls.append((request.url.host + ":" + str(request.url.port), request.url.path))
            if request.url.path == "/queue":
                # 8189 is busy (1 running + 2 pending), 8188 is slightly loaded (1 pending), 8191 is idle (0)
                if request.url.port == 8189:
                    return httpx.Response(200, json={"queue_running": [["1", "a"]], "queue_pending": [["2", "b"], ["3", "c"]]})
                if request.url.port == 8188:
                    return httpx.Response(200, json={"queue_running": [], "queue_pending": [["4", "d"]]})
                if request.url.port == 8191:
                    return httpx.Response(200, json={"queue_running": [], "queue_pending": []})
            if request.url.path == "/prompt":
                self.assertEqual(request.url.port, 8191)  # Least busy instance chosen!
                return httpx.Response(200, json={"prompt_id": TASK_ID})
            return httpx.Response(404)

        with patch.object(bridge, "COMFY_URLS", instances), comfy_client(handler):
            response = self.client.post("/v1/videos", json={"duration": 5})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["id"], TASK_ID)
            self.assertEqual(bridge.tasks_db[TASK_ID]["comfy_url"], "http://10.10.13.7:8191")

    def test_multi_instance_polling_locates_task_on_unrecorded_instance_after_restart(self):
        instances = ["http://10.10.13.7:8188", "http://10.10.13.7:8189", "http://10.10.13.7:8191"]
        queries = []

        def handler(request):
            queries.append((request.url.port, request.url.path))
            if request.url.path == f"/history/{TASK_ID}":
                if request.url.port == 8189:
                    return httpx.Response(200, json={TASK_ID: {
                        "status": {"status_str": "success"},
                        "outputs": {
                            "14": {"images": [{"filename": "out_8189.mp4", "subfolder": "", "type": "output"}]},
                        },
                    }})
                return httpx.Response(200, json={})
            if request.url.path == "/view":
                self.assertEqual(request.url.port, 8189)
                self.assertEqual(request.url.params["filename"], "out_8189.mp4")
                return httpx.Response(200, content=b"video from 8189")
            return httpx.Response(404)

        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "STORAGE_DIR", Path(directory)), \
             patch.object(bridge, "COMFY_URLS", instances), comfy_client(handler):
            # Simulate bridge restart: tasks_db is empty
            bridge.tasks_db.clear()
            response = self.client.get(f"/v1/videos/{TASK_ID}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "completed")
            self.assertEqual(Path(directory, f"{TASK_ID}.mp4").read_bytes(), b"video from 8189")
            self.assertEqual(bridge.tasks_db[TASK_ID]["comfy_url"], "http://10.10.13.7:8189")

    def test_multi_instance_polling_locates_pending_task_in_queue_after_restart(self):
        instances = ["http://10.10.13.7:8188", "http://10.10.13.7:8189", "http://10.10.13.7:8191"]

        def handler(request):
            if request.url.path == f"/history/{TASK_ID}":
                return httpx.Response(200, json={})
            if request.url.path == "/queue":
                if request.url.port == 8188:
                    return httpx.Response(200, json={"queue_running": [["1", TASK_ID]], "queue_pending": []})
                return httpx.Response(200, json={"queue_running": [], "queue_pending": []})
            return httpx.Response(404)

        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "STORAGE_DIR", Path(directory)), \
             patch.object(bridge, "COMFY_URLS", instances), comfy_client(handler):
            bridge.tasks_db.clear()
            response = self.client.get(f"/v1/videos/{TASK_ID}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "processing")
            self.assertEqual(bridge.tasks_db[TASK_ID]["comfy_url"], "http://10.10.13.7:8188")

    def test_instances_endpoints(self):
        instances = ["http://10.10.13.7:8188", "http://10.10.13.7:8189"]

        def handler(request):
            if request.url.path == "/queue":
                return httpx.Response(200, json={"queue_running": [["1", "a"]], "queue_pending": []})
            return httpx.Response(404)

        with comfy_client(handler), patch.object(bridge, "COMFY_URLS", instances.copy()):
            # Test GET /v1/instances
            res = self.client.get("/v1/instances")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data["count"], 2)
            self.assertTrue(data["instances"][0]["online"])
            self.assertEqual(data["instances"][0]["queue_running"], 1)

            # Test POST /v1/instances/test
            test_res = self.client.post("/v1/instances/test", json={"url": "http://10.10.13.7:8188"})
            self.assertEqual(test_res.status_code, 200)
            self.assertTrue(test_res.json()["online"])

            # Test PUT /v1/instances with temporary config file
            with tempfile.NamedTemporaryFile("w+", suffix=".json") as tmp_cfg:
                tmp_cfg.write(json.dumps({"comfy_urls": instances}))
                tmp_cfg.flush()
                with patch.object(bridge, "CONFIG_PATH", Path(tmp_cfg.name)):
                    update_res = self.client.put("/v1/instances", json={"instances": ["http://10.10.13.7:8188", "http://10.10.13.7:8189", "http://10.10.13.7:8191"]})
                    self.assertEqual(update_res.status_code, 200)
                    self.assertEqual(update_res.json()["count"], 3)
                    self.assertEqual(len(bridge.COMFY_URLS), 3)


if __name__ == "__main__":
    unittest.main()
