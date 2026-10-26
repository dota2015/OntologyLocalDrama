import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { Agent, Runner, OpenAIChatCompletionsModel, tool } from '@openai/agents';
import { default as OpenAI } from 'openai';
import { dramaThreadId } from './context.mjs';
import { resolveTextModel } from './model.mjs';
import { listSkillDirectories } from './skills.mjs';
import { guardDeleteApproval, toAgentSseEvent } from './sse.mjs';
import * as tools from './tools.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let ready = false;
let appDb;
let appLog;
let appConfig;

function warn(message, err) {
  const error = err && err.message ? err.message : String(err || '');
  if (appLog && appLog.warn) appLog.warn(message, { error });
  else console.warn(message, error);
}

function readScope(runContext) {
  const ctx = (runContext && runContext.context) || runContext || {};
  return {
    dramaId: Number(ctx.dramaId || ctx.drama_id),
    episodeId: ctx.episodeId == null && ctx.episode_id == null ? null : Number(ctx.episodeId ?? ctx.episode_id),
  };
}

function validateSkillMarkdown(markdown) {
  const fence = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return { valid: false };
  return { valid: /^name:\s*\S+/m.test(fence[1]) };
}

function loadService(name) {
  return require(`../services/${name}`);
}

function generationDeps() {
  return {
    startStoryGeneration: loadService('storyGenerationService.js').startStoryGeneration,
    generateCharacters: loadService('characterGenerationService.js').generateCharacters,
    extractBackgroundsForEpisode: loadService('backgroundExtractionService.js').extractBackgroundsForEpisode,
    generateStoryboard: loadService('episodeStoryboardService.js').generateStoryboard,
    generateCharacterFourViewImage: loadService('characterLibraryService.js').generateCharacterFourViewImage,
    generateSceneSingleImage: loadService('sceneService.js').generateSceneSingleImage,
    generateSceneFourViewImage: loadService('sceneService.js').generateSceneFourViewImage,
    updateStoryboard: loadService('storyboardService.js').updateStoryboard,
    createImage: loadService('imageService.js').create,
  };
}

function buildTools() {
  const empty = z.object({});
  return {
    get_current_project: tool({
      name: 'get_current_project',
      description: '读取当前短剧、分集、角色、场景和分镜',
      parameters: empty,
      execute: async (_input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGetCurrentProject(appDb, scope.dramaId, scope.episodeId);
      },
    }),
    generate_story: tool({
      name: 'generate_story',
      description: '为当前短剧生成剧本',
      parameters: empty,
      execute: async (_input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGenerateStory(appDb, appLog, scope.dramaId, generationDeps());
      },
    }),
    save_episode_script: tool({
      name: 'save_episode_script',
      description: '保存当前集的剧本',
      parameters: z.object({
        title: z.string().optional(),
        script: z.string(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeSaveEpisodeScript(appDb, scope.dramaId, scope.episodeId, {
          title: input.title,
          scriptContent: input.script,
        });
      },
    }),
    generate_characters: tool({
      name: 'generate_characters',
      description: '为当前集生成角色',
      parameters: empty,
      execute: async (_input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGenerateCharacters(appDb, appConfig, appLog, scope.dramaId, scope.episodeId, generationDeps());
      },
    }),
    update_character: tool({
      name: 'update_character',
      description: '新建或修改当前剧的角色',
      parameters: z.object({
        id: z.number().optional(),
        name: z.string().optional(),
        role: z.string().optional(),
        appearance: z.string().optional(),
        personality: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeUpdateCharacter(appDb, appLog, scope.dramaId, scope.episodeId, input);
      },
    }),
    generate_scenes: tool({
      name: 'generate_scenes',
      description: '从当前集剧本提取场景',
      parameters: empty,
      execute: async (_input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGenerateScenes(appDb, appConfig, appLog, scope.dramaId, scope.episodeId, generationDeps());
      },
    }),
    update_scene: tool({
      name: 'update_scene',
      description: '新建或修改当前剧的场景',
      parameters: z.object({
        id: z.number().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        prompt: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeUpdateScene(appDb, appLog, scope.dramaId, scope.episodeId, input);
      },
    }),
    update_prop: tool({
      name: 'update_prop',
      description: '新建或修改当前剧的道具（支持物理真实尺度与描述）',
      parameters: z.object({
        id: z.number().optional(),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
        physical_scale: z.string().optional(),
        image_prompt: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeUpdateProp(appDb, appLog, scope.dramaId, scope.episodeId, input);
      },
    }),
    generate_storyboards: tool({
      name: 'generate_storyboards',
      description: '为当前集生成分镜',
      parameters: z.object({
        storyboardCount: z.number().optional(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGenerateStoryboards(appDb, appLog, scope.dramaId, scope.episodeId, input, generationDeps());
      },
    }),
    update_storyboard: tool({
      name: 'update_storyboard',
      description: '修改当前剧的一条分镜',
      parameters: z.object({
        id: z.number(),
        dialogue: z.string().optional(),
        action: z.string().optional(),
        description: z.string().optional(),
        imagePrompt: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeUpdateStoryboard(appDb, appLog, scope.dramaId, input);
      },
    }),
    director_refine_storyboard: tool({
      name: 'director_refine_storyboard',
      description: '调用导演智能体对分镜进行专业定向微调（携带世界观本体契约、机位运镜推演与连戏快照）',
      parameters: z.object({
        id: z.number(),
        instruction: z.string().describe('修改意见或微调指令'),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeDirectorRefineStoryboard(appDb, appLog, scope.dramaId, input);
      },
    }),
    generate_image: tool({
      name: 'generate_image',
      description: '为角色、场景或分镜出图',
      parameters: z.object({
        type: z.enum(['character', 'scene', 'storyboard']),
        id: z.number(),
        view: z.enum(['single', 'four']).optional(),
        prompt: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGenerateImage(appDb, appLog, appConfig, scope.dramaId, input, generationDeps());
      },
    }),
    get_task: tool({
      name: 'get_task',
      description: '查询当前剧的一个生成任务',
      parameters: z.object({
        taskId: z.string(),
      }),
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        return tools.executeGetTask(appDb, scope.dramaId, input);
      },
    }),
    delete_item: tool({
      name: 'delete_item',
      description: '删除当前剧的角色、场景、道具或分镜，必须等用户允许',
      parameters: z.object({
        type: z.enum(['character', 'scene', 'prop', 'storyboard']),
        id: z.number(),
      }),
      needsApproval: async () => true,
      execute: async (input, ctx) => {
        const scope = readScope(ctx);
        const guard = guardDeleteApproval(appDb, scope.dramaId, input);
        if (guard.action === 'decline') return { ok: false, error: guard.error };
        return tools.executeDeleteItem(appDb, appLog, scope.dramaId, input);
      },
    }),
  };
}

function ensureAgentTables(db) {
  if (!db) return;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_pending_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      item_type TEXT,
      target_id INTEGER,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )`);
  } catch (_) {}
}

export function isAgentReady() {
  return ready;
}

export async function initAgent({ db, log, config }) {
  ready = false;
  appDb = db;
  appLog = log;
  appConfig = config || {};
  try {
    ensureAgentTables(appDb);
    ready = true;
  } catch (err) {
    ready = false;
    warn('OpenAI Agents 助手初始化失败', err);
  }
}

export async function streamChat({ dramaId, episodeId, message, focusedTarget, writeEvent }) {
  if (!ready) throw new Error('助手未就绪');
  const did = Number(dramaId);
  const eid = episodeId == null ? null : Number(episodeId);

  // 1. 持久化记录用户输入
  try {
    appDb.prepare(`INSERT INTO agent_chat_messages (drama_id, role, content, created_at) VALUES (?, 'user', ?, ?)`).run(did, message, new Date().toISOString());
  } catch (_) {}

  // 2. 动态读取当前配置的文本大模型
  const resolved = resolveTextModel(appDb);
  if (!resolved.ok) throw new Error(resolved.error);

  const modelName = resolved.model.id.replace(/^custom\//, '');
  const client = new OpenAI({
    apiKey: resolved.model.apiKey || 'local',
    baseURL: resolved.model.url,
  });
  const model = new OpenAIChatCompletionsModel(client, modelName);

  const toolsMap = buildTools();
  const agent = new Agent({
    name: 'drama-assistant',
    instructions: '你是本地短剧助手。只操作当前打开的短剧。删除必须调用 delete_item 并等待用户允许。没有出视频、导入导出、新建或删除整部剧的工具。你支持维护角色、场景、道具及分镜，并可调用 director_refine_storyboard 进行导演级微调推演。',
    model,
    tools: Object.values(toolsMap),
  });

  const runner = new Runner({ tracingDisabled: true });
  const runId = uuidv4();
  let fullAssistantText = '';

  let promptWithContext = message;
  if (focusedTarget && focusedTarget.type === 'storyboard' && (focusedTarget.number != null || focusedTarget.id != null)) {
    const shotLabel = focusedTarget.number != null ? `第 ${focusedTarget.number} 镜` : `分镜ID: ${focusedTarget.id}`;
    const titleStr = focusedTarget.title ? `，标题: "${focusedTarget.title}"` : '';
    promptWithContext = `[用户屏幕当前正聚焦于分镜：${shotLabel} (ID: ${focusedTarget.id}${titleStr})。若用户的输入是修改提示词、微调镜头、调整光影动作等指令，请优先针对该分镜操作，可优先调用 director_refine_storyboard 进行导演级精细微调推演]\n\n${message}`;
  }

  try {
    const result = await runner.run(agent, promptWithContext, {
      stream: true,
      context: { dramaId: did, episodeId: eid },
    });

    for await (const event of result.toStream()) {
      if (event.type === 'raw_model_stream_event') {
        const delta = event.event?.choices?.[0]?.delta;
        if (delta?.content) {
          fullAssistantText += delta.content;
          writeEvent({ type: 'text-delta', text: delta.content });
        }
      } else if (event.type === 'run_item_stream_event') {
        const item = event.item;
        if (item?.type === 'tool_call_item') {
          const raw = item.rawItem || {};
          writeEvent({ type: 'tool-call', toolName: raw.name });
        } else if (item?.type === 'tool_call_output_item') {
          const raw = item.rawItem || {};
          let outObj = {};
          try { outObj = typeof item.output === 'string' ? JSON.parse(item.output) : (item.output || {}); } catch (_) {}
          writeEvent({
            type: 'tool-result',
            toolName: raw.name,
            ok: outObj.ok !== false,
            summary: outObj.summary || outObj.error || '',
            taskId: outObj.taskId,
            imageUrl: outObj.imageUrl,
            localPath: outObj.localPath,
          });
        } else if (item?.type === 'tool_approval_item') {
          const raw = item.rawItem || {};
          const toolCallId = raw.callId || raw.id || uuidv4();
          let args = {};
          try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments || {}); } catch (_) {}
          const guard = guardDeleteApproval(appDb, did, args);
          try {
            appDb.prepare(
              `INSERT INTO agent_pending_approvals (drama_id, run_id, tool_call_id, tool_name, item_type, target_id, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
            ).run(did, runId, toolCallId, item.name, args.type, args.id, guard.label || '', new Date().toISOString());
          } catch (_) {}

          writeEvent({
            type: 'tool-call-approval',
            runId,
            toolCallId,
            toolName: item.name,
            itemType: args.type,
            id: args.id,
            label: guard.action === 'ask' ? guard.label : '',
          });
        }
      }
    }
  } catch (err) {
    writeEvent({ type: 'error', message: err.message || '对话生成异常' });
  }

  // 3. 持久化记录助手回复
  if (fullAssistantText) {
    try {
      appDb.prepare(`INSERT INTO agent_chat_messages (drama_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)`).run(did, fullAssistantText, new Date().toISOString());
    } catch (_) {}
  }

  writeEvent({ type: 'done' });
}

export async function resumeApproval({ dramaId, runId, toolCallId, approved, writeEvent }) {
  if (!ready) throw new Error('助手未就绪');
  const did = Number(dramaId);
  try {
    const pending = appDb.prepare(
      `SELECT * FROM agent_pending_approvals WHERE drama_id = ? AND run_id = ? AND tool_call_id = ? AND status = 'pending'`
    ).get(did, runId, toolCallId);

    if (!pending) {
      writeEvent({ type: 'error', message: '找不到这次确认或已被处理' });
      writeEvent({ type: 'done' });
      return;
    }

    if (approved) {
      const result = tools.executeDeleteItem(appDb, appLog, did, { type: pending.item_type, id: pending.target_id });
      appDb.prepare(`UPDATE agent_pending_approvals SET status = 'approved' WHERE id = ?`).run(pending.id);
      writeEvent({ type: 'tool-result', toolName: pending.tool_name, ok: result.ok !== false, summary: result.summary || '' });
      writeEvent({ type: 'text-delta', text: `已完成删除${pending.label || ''}。` });
    } else {
      appDb.prepare(`UPDATE agent_pending_approvals SET status = 'declined' WHERE id = ?`).run(pending.id);
      writeEvent({ type: 'text-delta', text: `已取消删除操作。` });
    }
  } catch (err) {
    writeEvent({ type: 'error', message: err.message || '确认执行失败' });
  }
  writeEvent({ type: 'done' });
}

export async function getHistory(dramaId) {
  const did = Number(dramaId);
  const messages = [];
  const pendingApprovals = [];
  if (appDb) {
    try {
      const msgRows = appDb.prepare(
        `SELECT role, content FROM agent_chat_messages WHERE drama_id = ? ORDER BY id ASC LIMIT 50`
      ).all(did);
      for (const m of msgRows) {
        messages.push({ role: m.role, text: m.content });
      }
      const appRows = appDb.prepare(
        `SELECT run_id, tool_call_id, tool_name, item_type, target_id, label FROM agent_pending_approvals WHERE drama_id = ? AND status = 'pending'`
      ).all(did);
      for (const a of appRows) {
        pendingApprovals.push({
          runId: a.run_id,
          toolCallId: a.tool_call_id,
          toolName: a.tool_name,
          type: a.item_type,
          id: a.target_id,
          label: a.label || '',
        });
      }
    } catch (_) {}
  }
  return { messages, pendingApprovals };
}
