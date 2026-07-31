import { readEnv } from './config/env.js';
import { LocalRuntimeDaemon } from './runtime/daemon.js';
import { createTriLCApp } from './server/app.js';

// ── Tool registration (CC-equivalent tools) ──
// Register before daemon starts accepting agent traffic.
import { registerReadTool } from './tools/file-read.js';
import { registerWriteTool } from './tools/file-write.js';
import { registerEditTool } from './tools/file-edit.js';
import { registerGlobTool } from './tools/file-glob.js';
import { registerGrepTool } from './tools/file-grep.js';
// P2-Batch1-#2: TodoWrite tool + TaskCreate/TaskList/TaskUpdate
import { registerTodoWriteTool, registerTaskTools } from './tools/todo-write.js';
// P1: SendMessageTool (teammate messaging)
import { registerSendMessageTool } from './tools/send-message.js';
// P1: AgentTool (sub-agent capability leap)
import { registerAgentTool } from './tools/agent-tool.js';
// P2-Batch1-#7: LS tool
import { registerLSTool } from './tools/file-ls.js';
// P2 #1: SkillTool (skills loading and execution)
import { registerSkillTool, registerSkillForTool, getRegisteredSkillNames } from './tools/skill-tool.js';
// P2 #2: AskUserQuestionTool (user interaction)
import { registerAskUserQuestionTool } from './tools/ask-user-question-tool.js';
// P2 #1: skills directory loader (fills SkillTool registry)
import { loadSkills, initBundledSkills, getBundledSkills } from './skills/index.js';

async function main(): Promise<void> {
  const env = readEnv();

  // Register CC-equivalent tools (globally via agent-core)
  registerReadTool();
  registerWriteTool();
  registerEditTool();
  registerGlobTool();
  registerGrepTool();
  // P2-Batch1-#2: TodoWrite + Task tools
  registerTodoWriteTool();
  registerTaskTools();
  // P1: SendMessageTool (teammate messaging)
  registerSendMessageTool();
  // P1: AgentTool (sub-agent capability leap)
  registerAgentTool();
  // P2-Batch1-#7: LS tool
  registerLSTool();
  // P2 #1: SkillTool (skills loading and execution)
  registerSkillTool();
  // Load skills from .claude/skills and register them so SkillTool calls resolve
  // (without this, the registry stays empty and every skill call returns Unknown).
  try {
    const loadedSkills = await loadSkills(env.cwd);
    for (const skill of loadedSkills) {
      registerSkillForTool(skill.name, {
        getPromptForCommand: skill.getPromptForCommand,
        description: skill.description,
        allowedTools: skill.allowedTools,
        model: skill.model,
      });
    }
    console.log(`[trilc] skills: ${loadedSkills.length} loaded into SkillTool registry`);
  } catch (err) {
    console.warn('[trilc] skills load failed (continuing):', (err as Error).message);
  }
  // P3: bundled skills (absorbed from CC src/skills/bundled) — always available
  try {
    initBundledSkills();
    const bundled = getBundledSkills();
    for (const skill of bundled) {
      // Directory-loaded skills take precedence over bundled defaults
      if (getRegisteredSkillNames().includes(skill.name)) continue;
      registerSkillForTool(skill.name, {
        getPromptForCommand: skill.getPromptForCommand,
        description: skill.description,
        allowedTools: skill.allowedTools ?? [],
        model: skill.model,
      });
    }
    console.log(`[trilc] bundled skills: ${bundled.map((s) => s.name).join(', ')}`);
  } catch (err) {
    console.warn('[trilc] bundled skills init failed (continuing):', (err as Error).message);
  }
  // P2 #2: AskUserQuestionTool (user interaction)
  registerAskUserQuestionTool();
  console.log('[trilc] registered 14 CC-equivalent tools: Read, Write, Edit, Glob, Grep, LS, TodoWrite, TaskCreate, TaskList, TaskUpdate, SendMessage, AgentTool, SkillTool, AskUserQuestionTool');

  // P6: Plan mode tools (EnterPlanMode + ExitPlanMode)
  import('./tools/plan-mode.js').then(
    ({ registerPlanModeTools }) => {
      registerPlanModeTools();
      console.log('[trilc] P6: plan mode tools registered (EnterPlanMode, ExitPlanMode)');
    },
    (err) => console.warn('[trilc] plan mode tools registration failed:', (err as Error).message),
  );

  // P6: Load persisted permission rules before daemon starts accepting requests
  try {
    const { initPermissionStore } = await import('./server/interactions.js');
    initPermissionStore();
  } catch (err) {
    console.warn('[trilc] permission store init failed (continuing):', (err as Error).message);
  }

  // Start local runtime daemon (heartbeat, node registration)
  const daemon = new LocalRuntimeDaemon(env);
  await daemon.start();

  // Start HTTP server for TriPilot/TriCode connectivity
  // P6: MCP init
  try {
    const { McpClientManager } = await import('./mcp/mcp-client.js');
    const { loadMCPServerConfigs } = await import('./mcp/mcp-config.js');
    const { setMcpClientManager, registerMCPTool } = await import('./tools/mcp-tool.js');
    const mcpConfigs = loadMCPServerConfigs(env.cwd);
    if (mcpConfigs.length > 0) {
      const mcp = new McpClientManager();
      await mcp.connectAll(mcpConfigs);
      setMcpClientManager(mcp);
      registerMCPTool();
      console.log(`[trilc] P6: MCP ready (${mcp.totalToolCount()} tools)`);
    }
  } catch (e) { console.warn('[trilc] MCP init failed:', (e as Error).message); }

  const app = createTriLCApp(env);
  await app.start();

  console.log(`[trilc] ready — node=${env.nodeId} port=${app.port}`);

  // ── Graceful shutdown (Windows + Linux compatible) ──
  // On Windows, SIGTERM from process.kill() maps to TerminateProcess.
  // On Linux, SIGTERM is a standard graceful shutdown signal.
  // The /shutdown POST endpoint provides an alternative for Windows.
  const shutdown = async (signal: string) => {
    console.log(`[trilc] received ${signal}, shutting down gracefully...`);
    try {
      await app.stop();
      await daemon.stop();
      console.log('[trilc] shutdown complete');
    } catch (err) {
      console.error('[trilc] shutdown error:', err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  await main();
} catch (error) {
  console.error('[trilc] failed to start', error);
  throw error;
}