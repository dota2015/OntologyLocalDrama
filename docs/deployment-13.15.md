# 13.15 部署与数据迁移

LocalMiniDrama 已于 2026-10-21 迁入 `nvidia@10.10.13.15` 的 WSL。

- 网页与 API：<http://10.10.13.15:5679>
- 项目目录：`/home/nvidia/LocalMiniDrama`
- H3 桥接：`http://127.0.0.1:5688`，连接同机 ComfyUI `http://127.0.0.1:8188`
- 图片服务：继续使用 Windows 上的 Qwen-Image 服务 `http://10.10.13.15:8888/v1`

后端直接提供已构建的前端，无需启动 Vite。Node 位于 `.runtime/node/`；桥接与 Edge TTS 共用项目内的 `.venv-video-bridge/`，不依赖 Pixelle-Video 的 Python 环境。运行依赖记录在 `requirements-local-runtime.txt`。

## 服务管理

SSH 登录后使用用户级 systemd，无需 sudo：

```bash
systemctl --user status localminidrama localminidrama-h3
systemctl --user restart localminidrama localminidrama-h3
journalctl --user -u localminidrama -u localminidrama-h3 -n 100
curl http://127.0.0.1:5679/health
curl http://127.0.0.1:5688/health
```

两个服务已启用自动启动与故障重启，用户已启用 linger，退出 SSH 后继续运行。自动启动发生在 WSL 启动时；此配置不会主动启动已关闭的 WSL，也不管理已有 ComfyUI 或 Windows 图片服务。

## 已迁移数据

迁移包括 `backend-node/data/`、`generated_videos/`、AI 配置，以及三个 SQLite 数据库。最终切换时先停止旧服务，再通过 SQLite backup API 制作快照，避免遗漏 WAL 中的数据。

校验结果：2 个作品、5 集、52 个分镜、4 个人物、90 条图片生成记录、59 条视频生成记录、200 条异步任务及 6 条 AI 服务配置。生成记录包含历史失败记录，保持原样。

全部数据库通过完整性检查，所有表记录数一致；224 个素材和缓存文件通过 SHA-256 校验，224 个素材 HTTP 链接均返回 200。数据库内旧地址 `10.10.10.205` 已替换为新服务地址。

最终数据库快照和校验清单位于远端 `.migration/`。旧机器上的项目与数据保留作为备份，5679、5688、3013 上的 LocalMiniDrama 服务已停止。恢复旧备份前应先停止远端写入，避免两套数据分叉。

若再次更换主机，可在停服并备份后运行 `scripts/relocate_storage_urls.py` 更新数据库中的存储地址；同时更新后端 `storage.base_url` 和桥接 `public_base_url`。不要用旧配置覆盖本次远端地址。
