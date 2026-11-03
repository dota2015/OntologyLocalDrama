# H3 Continuum integration

LocalMiniDrama treats Continuum as a separate ComfyUI workflow. A logical
storyboard is routed as follows:

* 4–8 integer seconds: `execution_backend: h3_single`, the existing H3 graph.
* 9–30 integer seconds: `execution_backend: h3_continuum`, with a
  `continuum_plan` and a timeline prompt.
* More than 30 seconds: rejected before submission and returned to the Director
  Agent for a semantic split.

Continuum is not enabled by changing the ordinary H3 `length` or `duration`
input. The production ComfyUI instances load `ComfyUI-H3-Continuum` 3.10.2
and the bridge submits the checked-in V3.9 API graph. Its sampler, decode
cache, seam assembly and video save path are separate from the ordinary H3
graph. Configure it with:

```json
{
  "continuum_workflow_path": "workflows/selfhost/video_minimax_h3_continuum_api.json",
  "continuum_nodes": {
    "prompt": "6",
    "prompt_input": "value",
    "sampler": "10",
    "scheduler": "5",
    "chunks_input": "chunks",
    "chunk_seconds_input": "chunk_seconds",
    "reference_images": "9",
    "reference_audios": "11"
  }
}
```

V3.9 accepts one shared `chunk_seconds` value. LocalMiniDrama therefore divides
every 9–30 second logical shot into two or more equal 4–15 second physical
chunks. The bridge rejects a plan whose chunk product differs from the logical
duration. Reference images are routed through fixed `@R1`–`@R9` slots for all
chunks; the bridge converts business-level `<Picture N>` tags at submission.

The bridge refuses a 9–30 second request when this workflow is missing. It
never silently submits a long request to the ordinary H3 graph. The bridge
persists the parent task's plan and per-chunk status so a page refresh can show
the execution contract. Chunk-level retry/resume requires a Continuum graph
with Run Storage/Join state wired in; the application does not fake a chunk by
submitting independent H3 clips.
