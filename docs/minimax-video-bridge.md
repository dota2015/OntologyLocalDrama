# MiniMax-H3 本地视频桥接

LocalMiniDrama 独立维护桥接脚本、工作流、配置和 Python 环境，无需安装其他视频项目。模型权重仍由远程 ComfyUI 加载。

## 文件与配置

- `minimax_video_bridge.py`：兼容创建和查询视频的 HTTP 接口。
- `configs/minimax_video_bridge.json`：ComfyUI 地址、工作流位置、输出目录、对外下载地址和监听端口。
- `workflows/selfhost/video_minimax_h3.json`：MiniMax-H3 Q6_K 工作流；模型文件名在节点 1–4。
- `.venv-video-bridge/`：本项目独立的 Python 环境。
- `generated_videos/`：下载缓存，不提交 Git。

配置中的相对路径均以仓库根目录解析，与启动时的工作目录无关。可以用环境变量 `MINIMAX_BRIDGE_CONFIG` 指定另一份配置。`public_base_url` 必须能从 Node 后端访问。

## 安装与运行

在仓库根目录执行（Python 3.10+）：

```bash
python3 -m venv .venv-video-bridge
.venv-video-bridge/bin/python -m pip install -r requirements-video-bridge.txt
./scripts/start_minimax_video_bridge.sh
```

也可用 `uv venv .venv-video-bridge` 和 `uv pip install --python .venv-video-bridge/bin/python -r requirements-video-bridge.txt` 安装。

检查服务：`curl http://127.0.0.1:5688/health`。

在「AI 配置 · 视频」中设置：

- 模型：`minimax_h3`；接口规范：`minimax_h3`。
- Base URL：`http://127.0.0.1:5688`。
- 创建路径：`/v1/videos`；查询路径：`/v1/videos/{taskId}`。

工作流要求 ComfyUI 安装 MiniMax-H3（含 `MiniMaxH3ReferenceToVideo`、`MiniMaxH3AddGuide`）、GGUF 加载节点，以及标准的 `LoadImage`、`ImageFromBatch`、`TrimAudioDuration`、`CreateVideo` 和 `SaveVideo` 节点。输出经 ComfyUI `/view` 下载，无需 SSH 或远程输出目录配置。

仓库原有 H3 客户端调用 HTTP API，并不加载本地模型。本桥接将该客户端的请求转换成 ComfyUI 工作流。仓库另有 [通用 ComfyUI 代理教程](comfyui配置.md)；教程链接的代理示例工作流不是 H3，不能仅替换模型权重就认为参数已适配。

## 图片与模型选择

- 经典分镜：保留明确的首尾帧字段，使用 FL2VA Q6；经典请求同时附带的参考图列表不覆盖首尾帧角色。
- 全能分镜：使用 Ref2VA Q6，按请求顺序连接场景、人物、道具参考图。`@图片N` / `<IMAGE_N>` 转换为 H3 的 `<Picture N>`，最多 9 张；超限或引用不存在的槽位会报错。
- 图片先经桥接读取、解码，再上传至 ComfyUI `/upload/image`，连接 `LoadImage` 节点。支持 HTTP(S) 和 base64 图片；无效图片会明确失败，不降级为纯文字。
- 无图片请求仍可文生视频。混用帧角色与参考角色的桥接请求会报错。

ComfyUI 的 `models/diffusion_models/` 必须能找到 `minimax_h3_fl2va_pruned-Q6_K.gguf` 和 `minimax_h3_ref2va_pruned-Q6_K.gguf`；可以链接已有缓存，无需重复下载。参考模型文件名可通过桥接配置 `reference_model` 覆盖。两种模型按任务使用，仍由当前 ComfyUI 所选显卡运行，不会借用 Windows Qwen-Image 的显卡。

工作流的像素预算为 768×432；带图或指定画幅时，宽高按 H3 图片约束要求对齐到 32 的倍数，并保持相近画幅且不增加像素预算。例如 16:9 约为 736×416，9:16 为 416×736。页面分辨率不会直接提升 ComfyUI 原生生成尺寸；Node 后端下载后仍执行既有的分辨率归一化。人物一致性依赖输入图和生成过程，接通参考约束不保证所有镜头完全一致。

## 时长规则与验证

后端传入的 `duration`（兼容 `seconds`）控制时长；省略时默认 5 秒。桥接接受 1–15 秒，Node 的 MiniMax-H3 协议按现有规则归一到 4–15 秒，超范围的桥接请求返回 422。

H3 以 24 fps、`17k+5` 帧生成，因此 5 秒先生成 124 帧，再取前 120 帧，并同步裁剪音频到 5 秒。6 秒先生成 158 帧，再取 144 帧。小数秒向上取整到一帧。不会通过降低帧率延长视频。

有尾帧时，额外通过 `MiniMaxH3AddGuide` 将它约束到裁剪后保留的最后一帧，避免尾帧仅锚定在被裁掉的帧上。

```bash
.venv-video-bridge/bin/python -m unittest discover -s tests -p 'test_*.py' -v
ffprobe -v error -show_entries stream=codec_type,r_frame_rate,nb_frames,duration -of json generated_videos/<任务ID>.mp4
```

修改 Python 或连接配置后重启桥接服务；工作流每次提交时重新读取。已生成的旧视频保留原时长，需要重新生成。

## 部署验证（2026-10-21）

早期纯文字验证：通过 Node `videoClient.callVideoApi` 提交 5 秒任务，完成生成、HTTP 下载与 `ffprobe` 检查：768×432、24 fps、120 帧，视频和音频均为 5.000 秒。任务 ID：`6490bb56-1de3-4990-b2d3-f99e0bed6853`。总耗时 287.58 秒，12 步采样约 74 秒。该次不代表图片约束已验证。

远端 Windows 主机的物理 GPU 0 留给 Unsloth Desktop 的 Qwen-Image；WSL ComfyUI 保持 `--cuda-device 1 --highvram`。每 2 秒采样监测，GPU 1 最高占用 23,881 MiB；本次未发生 OOM，但余量很小，不能推广到更高原生分辨率或更长时长。GPU 0 全程维持 21,930 MiB。

图片接入验证（均通过 Node 客户端提交，不写入分镜记录）：

| 路径 | ComfyUI 任务 ID | 成片 | ComfyUI 耗时 |
| --- | --- | --- | --- |
| FL2VA，首尾帧与裁剪末帧引导 | `8710783b-48f5-4cb5-a7f3-53cff471982c` | 736×416，24 fps，120 帧，音视频均 5 秒 | 191.60 秒 |
| Ref2VA，场景与人物两张参考图 | `2f893c4f-d163-4793-aad9-1ab59995133e` | 768×432，24 fps，120 帧，音视频均 5 秒 | 200.00 秒 |

Ref2VA 样片使用的是对齐策略修正前的画布；当前带图画布统一按 32 对齐。经典首尾帧实测曾在 768×432 下触发 keyframe latent reshape 错误，对齐后完成生成。以上为少量功能验证，不是质量或性能基准；未验证 9 图、15 秒或更高原生分辨率的显存需求。

回归检查：桥接 Python 单测、后端与前端 Node 单测均通过，前端生产构建通过。生成视频在 `generated_videos/`，通过 `ffprobe` 检查时长与帧数；抽查经典样片首帧、末帧贴近输入图，全能样片为连续单画幅，没有复刻参考图拼图布局。输入图自身存在服装、面部外观差异时，不能用本次样片证明身份已统一。

Wan2.2 后台下载独立于本桥接；本次未切换到 Wan，也未进行两模型画质或速度对比。
