import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
} from "@entelligentsia/pi-coding-agent";
import type { Message } from "@entelligentsia/pi-ai";

export interface WorkerResult {
  responseText: string;
  exitCode: 0 | 1;
  errorMessage?: string;
}

export async function dispatchLlmWorker(opts: {
  compiledPrompt: string;
  cwd: string;
  onEvent?: (event: AgentSessionEvent) => void;
}): Promise<WorkerResult> {
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () =>
      "You are a workflow node worker. Read the user message carefully. "
      + "At the end of your reply, emit a ```json events block per the protocol. "
      + "Outside that block, you may write reasoning prose if helpful — but the engine ignores it.",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();

  const authStorage   = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
  });

  let responseText = "";

  const unsub = session.subscribe((event: AgentSessionEvent) => {
    if (opts.onEvent) opts.onEvent(event);
    if (event.type === "turn_end" && event.message) {
      const msg = event.message as Message;
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text") responseText += part.text;
        }
      }
    }
  });

  try {
    await session.prompt(opts.compiledPrompt);
    unsub();
    session.dispose();
    return { responseText, exitCode: 0 };
  } catch (err: unknown) {
    unsub();
    session.dispose();
    const e = err as { message?: string };
    return { responseText, exitCode: 1, errorMessage: e.message ?? "worker threw" };
  }
}
