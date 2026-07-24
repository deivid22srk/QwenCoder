const modelContextWindows: Record<string, number> = {
  "qwen3.8-max-preview": 1000000,
  "qwen3.7-plus": 1000000,
  "qwen3.7-max": 1000000,
  "qwen3.6-plus": 1000000,
  "qwen3.6-plus-preview": 1000000,
  "qwen3.6-max-preview": 262144,
  "qwen3.6-27b": 262144,
  "qwen3.6-35b-a3b": 262144,
  "qwen3.5-plus": 1000000,
  "qwen3.5-flash": 1000000,
  "qwen3.5-omni-plus": 262144,
  "qwen3.5-omni-flash": 262144,
  "qwen3.5-max-2026-03-08": 262144,
  "qwen3.5-397b-a17b": 262144,
  "qwen3.5-122b-a10b": 262144,
  "qwen3.5-27b": 262144,
  "qwen3.5-35b-a3b": 262144,
  "qwen3-max-2026-01-23": 262144,
  "qwen3-coder-plus": 1048576,
  "qwen3-vl-plus": 262144,
  "qwen3-omni-flash-2025-12-01": 65536,
  "qwen-plus-2025-07-28": 131072,
  "qwen-latest-series-invite-beta-v24": 262144,
  "qwen-latest-series-invite-beta-v16": 1000000,
};

const modelTokenDivisors: Record<string, number> = {
  "qwen3.8-max-preview": 2.2,
  "qwen3.7-max": 2.2,
  "qwen3.6-max-preview": 2.2,
  "qwen3.5-max-2026-03-08": 2.2,
  "qwen3-max-2026-01-23": 2.2,
  "qwen-latest-series-invite-beta-v24": 2.2,
  "qwen3.7-plus": 2.0,
  "qwen3.6-plus": 2.0,
  "qwen3.6-plus-preview": 2.0,
  "qwen3.5-plus": 2.0,
  "qwen-plus-2025-07-28": 2.0,
  "qwen-latest-series-invite-beta-v16": 2.0,
  "qwen3.5-flash": 1.8,
  "qwen3.5-omni-plus": 1.8,
  "qwen3.5-omni-flash": 1.7,
  "qwen3-omni-flash-2025-12-01": 1.7,
  "qwen3.5-397b-a17b": 1.9,
  "qwen3.5-122b-a10b": 1.9,
  "qwen3.6-35b-a3b": 1.9,
  "qwen3.5-35b-a3b": 1.9,
  "qwen3.6-27b": 1.9,
  "qwen3.5-27b": 1.9,
  "qwen3-coder-plus": 2.3,
  "qwen3-vl-plus": 2.1,
};

/** Models that always run with thinking ON (no Fast / -no-thinking variant). */
const ALWAYS_THINKING_MODELS = new Set<string>(["qwen3.8-max-preview"]);

/**
 * Synthetic catalog entries injected when Qwen /api/models omits a model
 * we already support (e.g. early preview ids).
 */
export const SYNTHETIC_CATALOG_MODELS: Array<{
  id: string;
  name: string;
  context_window: number;
  owned_by?: string;
}> = [
  {
    id: "qwen3.8-max-preview",
    name: "Qwen3.8 Max Preview",
    context_window: 1000000,
    owned_by: "qwen",
  },
];

export function stripNoThinkingSuffix(modelId: string): string {
  return modelId.replace(/-no-thinking$/, "");
}

export function isAlwaysThinkingModel(modelId: string): boolean {
  return ALWAYS_THINKING_MODELS.has(stripNoThinkingSuffix(modelId));
}

/**
 * Resolve Qwen feature_config thinking flags from model id + optional effort.
 * - Always-thinking models (qwen3.8-max-preview): always Thinking / enabled
 * - Others: -no-thinking or low/fast effort → Fast / disabled; else Thinking
 */
export function resolveThinkingConfig(
  modelId: string,
  enableThinkingHint?: boolean,
): {
  enableThinking: boolean;
  thinkingMode: "Thinking" | "Fast";
  thinkingFormat: "summary" | undefined;
} {
  const base = stripNoThinkingSuffix(modelId);
  if (isAlwaysThinkingModel(base)) {
    return {
      enableThinking: true,
      thinkingMode: "Thinking",
      thinkingFormat: "summary",
    };
  }
  const enableThinking =
    enableThinkingHint !== undefined
      ? enableThinkingHint
      : !modelId.endsWith("-no-thinking");
  if (enableThinking) {
    return {
      enableThinking: true,
      thinkingMode: "Thinking",
      thinkingFormat: "summary",
    };
  }
  return {
    enableThinking: false,
    thinkingMode: "Fast",
    thinkingFormat: undefined,
  };
}

const defaultContextWindow = 131072;
const defaultTokenDivisor = 2.0;
export const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;

export function setModelContextWindow(
  modelId: string,
  contextWindow: number,
): void {
  modelContextWindows[modelId] = contextWindow;
}

export function getModelContextWindow(modelId: string): number {
  const baseId = stripNoThinkingSuffix(modelId);
  return modelContextWindows[baseId] ?? defaultContextWindow;
}

export function getModelTokenDivisor(modelId: string): number {
  const baseId = stripNoThinkingSuffix(modelId);
  return modelTokenDivisors[baseId] ?? defaultTokenDivisor;
}

export function syncModelContextWindows(
  models: Array<{ id: string; context_window?: number }>,
): void {
  for (const m of models) {
    if (m.context_window) {
      modelContextWindows[m.id] = m.context_window;
    }
  }
}
