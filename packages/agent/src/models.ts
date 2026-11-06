import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { optional, required } from '@sentinel/config';

export function primaryModel(): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'meta',
    baseURL: optional('MODEL_API_BASE', 'https://api.meta.ai/v1'),
    apiKey: required('MODEL_API_KEY'),
  });
  return provider.chatModel(optional('MODEL_ID', 'muse-spark-1.3'));
}

/** Null when no fallback is configured — primary failures then surface. */
export function fallbackModel(): LanguageModel | null {
  const baseURL = process.env.FALLBACK_API_BASE;
  const apiKey = process.env.FALLBACK_API_KEY;
  const modelId = process.env.FALLBACK_MODEL_ID;
  if (!baseURL || !apiKey || !modelId) return null;
  return createOpenAICompatible({ name: 'fallback', baseURL, apiKey }).chatModel(modelId);
}

export function modelIdOf(model: LanguageModel): string {
  return (model as { modelId?: string }).modelId ?? 'unknown';
}

function statusOf(err: unknown): number | null {
  const s = (err as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' ? s : null;
}

/** Retryable: rate limits, server errors, timeouts, network failures. */
export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== null && status >= 500) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ECONN|ENOTFOUND|fetch failed|429|5\d\d|overloaded|unavailable/i.test(msg);
}

export async function generateWithFailover<T>(
  primary: LanguageModel,
  fallback: LanguageModel | null,
  fn: (model: LanguageModel) => Promise<T>,
): Promise<{ result: T; modelId: string; failedOver: boolean }> {
  try {
    return { result: await fn(primary), modelId: modelIdOf(primary), failedOver: false };
  } catch (err) {
    if (!fallback || !isRetryable(err)) throw err;
    return { result: await fn(fallback), modelId: modelIdOf(fallback), failedOver: true };
  }
}
