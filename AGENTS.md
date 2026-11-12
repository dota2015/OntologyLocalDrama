# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

LocalMiniDrama (本地短剧助手) — an AI-powered local short drama creation tool. Single product, three sub-projects sharing one repo (no monorepo tooling).

### Services

| Service | Directory | Port | Start Command |
|---------|-----------|------|---------------|
| Backend (Express + SQLite) | `backend-node/` | 5679 | `npm run dev` |
| Frontend (Vite + Vue 3) | `frontweb/` | 3013 | `npm run dev` |

Frontend proxies `/api` and `/static` to backend via Vite config. REST API routes are under `/api/v1/` (e.g. `GET /api/v1/dramas`); health check is `GET /health` on the backend (port 5679).

### Running Tests

```bash
# Backend tests (Node.js built-in test runner)
cd backend-node && node --test test/*.test.js

# Frontend tests (ESM, Node.js built-in test runner)
cd frontweb && node --test test/*.test.js
```

No ESLint or other lint tool is configured in this codebase.

### Building

```bash
cd frontweb && npm run build
```

### Key Development Notes

- Pure JavaScript (no TypeScript) throughout.
- Backend uses `node --watch` for hot reloading in dev mode (`npm run dev`).
- Database is SQLite (embedded via `better-sqlite3`), auto-created in `backend-node/data/`.
- Migrations run automatically on backend startup (`ensureColumns()`); explicit `npm run migrate` only needed for first-time setup or after adding new migration SQL files.
- Config file at `backend-node/configs/config.yaml` already exists in the repo — no need to copy from example.
- AI content generation requires external API keys (configured via the app's "AI 配置" page), but the app fully functions without them for development/testing purposes.
- The backend also serves the built frontend from `frontweb/dist/` at port 5679 when the dist folder exists; during development, use the Vite dev server at port 3013 instead.
- Video merge / tail-frame features require `ffmpeg` on PATH (or in `backend-node/tools/ffmpeg/`); UI and CRUD work without it.

### Collaboration Rules (工作协同铁律)

- **分级确认机制**：
  - **日常细节直接动手**：对于界面样式微调、排版对齐、控件尺寸/行数调整、已知轻量级 Bug 修复等日常细节改动，**直接修改、打包验证并测试后生效**，无需打扰用户提前确认。
  - **重大改动先确认后动手**：只有涉及**核心架构调整、主业务流程变更、破坏性数据/接口改动或关键功能设计**时，才必须先深入分析技术影响与根因，列出清晰方案与用户确认达成共识后方可改动代码。
- **杜绝打补丁与双架构分裂**：重构或新增逻辑时，必须向核心架构收敛，严禁随意保留或新增平行的重复入口与分裂代码。

### Architecture & Design Rules (架构与设计铁律)

- **门禁只认结构化语义**：本体门禁与不变量的判定依据必须是结构化字段（ID、枚举、槽位关系）；**坚决禁止**对自由文本（action、dialogue、result 等）做关键字/正则匹配来推断在场、身份、参与方式、意图等语义事实。语义事实必须由 Agent 在结构化槽位中显式声明，门禁只校验声明之间的一致性。自由文本仅允许确定性度量与原文一致性比对（字数、逐字覆盖、时长估算）。报错分类（如修复权限判定）优先使用违规自带的结构化字段（rule、conflict_slots），文本匹配只许作兜底，且兜底方向只能放宽、不能收窄。
- **平台代码零内容**：本产品是通用短剧平台，**坚决禁止**在规则、服务与提示词的规范部分写死任何具体剧目的剧情、角色名/ID、道具名、场景名与题材设定；一切内容必须来自剧目语义包与目录数据。提示词中的具体例子必须标注为示例，不得构成规则。媒介与模型能力的通用约束（单镜人数、参考图上限、时长范围等）应集中定义为可配置常量，不得散落硬编码。测试可用真实剧目作回归样本，但须注明是样本而非规范。
- 代码禁止背负背历史包袱！！！大的改动可以迁移修复数据，而不是代码兼容！

