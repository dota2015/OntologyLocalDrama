# H3 Continuum integration

LocalMiniDrama treats Continuum as a separate ComfyUI workflow. A logical
storyboard is routed as follows:

* 4–8 integer seconds: `execution_backend: h3_single`, the existing H3 graph.
* 9–30 integer seconds: `execution_backend: h3_continuum`, with a
  `continuum_plan` and a timeline prompt.
* More than 30 seconds: rejected before submission and returned to the Director
  Agent for a semantic split.

Continuum is not enabled by changing the ordinary H3 `length` or `duration`
input. Install the `ComfyUI-H3-Continuum` custom node and export an **API
format** workflow that contains the Continuum Join/Finish/Assemble path. Put
the workflow outside source control or configure it locally with:

```json
{
  "continuum_workflow_path": "workflows/selfhost/video_minimax_h3_continuum_api.json",
  "continuum_nodes": {
    "prompt": "<text-conditioning-node-id>",
    "duration": "<initial-join-or-duration-node-id>",
    "chunks": "<chunk-controller-node-id>",
    "chunk_seconds": "<chunk-duration-node-id>",
    "reference_image_nodes": ["<load-image-node-id>"],
    "audio_nodes": ["<load-audio-node-id>"],
    "prompt_input": "prompt",
    "duration_input": "duration",
    "chunks_input": "chunks",
    "chunk_seconds_input": "chunk_seconds",
    "image_input": "image",
    "audio_input": "audio"
  }
}
```

The bridge refuses a 9–30 second request when this workflow is missing. It
never silently submits a long request to the ordinary H3 graph. The bridge
persists the parent task's plan and per-chunk status so a page refresh can show
the execution contract. Chunk-level retry/resume requires a Continuum graph
with Run Storage/Join state wired in; the application does not fake a chunk by
submitting independent H3 clips.
