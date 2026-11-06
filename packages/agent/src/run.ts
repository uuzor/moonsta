import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { optional } from '@sentinel/config';
import { fallbackModel, generateWithFailover, primaryModel } from './models';
import { SYSTEM_PROMPT } from './prompt';
import { ToolContext, buildTools } from './tools';

/** Generous enough for real multi-tool investigations; still bounded against runaway loops. */
export function maxToolSteps(): number {
  return Number(optional('AGENT_MAX_TOOL_STEPS', '30'));
}

export function maxOutputTokens(): number {
  return Number(optional('AGENT_MAX_OUTPUT_TOKENS', '8000'));
}

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnResult {
  text: string;
  modelId: string;
  failedOver: boolean;
  inputTokens: number;
  outputTokens: number;
  toolNames: string[];
}

function tokenCount(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof (v as { total?: unknown }).total === 'number') {
    return (v as { total: number }).total;
  }
  return 0;
}

/**
 * One conversational turn: model + tools, capped steps and output.
 * History persistence and budgets live in the concurrency layer; the caller
 * passes the message list and records the returned usage.
 */
export async function runTurn(
  ctx: ToolContext,
  messages: TurnMessage[],
  system: string = SYSTEM_PROMPT,
): Promise<TurnResult> {
  const toolNames: string[] = [];
  const tools = buildTools(ctx, (name) => toolNames.push(name));
  const modelMessages: ModelMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const { result, modelId, failedOver } = await generateWithFailover(
    primaryModel(),
    fallbackModel(),
    (model) =>
      generateText({
        model,
        system,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(maxToolSteps()),
        maxOutputTokens: maxOutputTokens(),
      }),
  );
  const usage = result.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  return {
    text: result.text,
    modelId,
    failedOver,
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    toolNames,
  };
}
