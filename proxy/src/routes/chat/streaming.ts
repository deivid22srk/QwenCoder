/*
 * File: streaming.ts
 * Project: QwenBridge
 *
 * Upstream stream consumption: both non-streaming (JSON) and streaming (SSE)
 * response modes. Encapsulates heartbeat, abort handling, reasoning tag
 * sanitization, and incremental tool-call parsing.
 */

import { Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { buildQwenRequestHeaders } from "../../services/qwen-headers.ts";
import {
  updateLogicalThreadParent,
  updateSessionParent,
  QwenUpstreamError,
  RetryableQwenStreamError,
} from "../../services/qwen.ts";
import type { OpenAIRequest, Usage } from "../../utils/types.ts";
import { StreamingToolParser } from "../../tools/parser.ts";
import { StreamingReasoningTagSanitizer } from "../../utils/reasoning-tags.ts";
import {
  getStream,
  removeStream,
  updateStreamSessionId,
  updateStreamTargetResponseId,
} from "../../core/stream-registry.ts";
import { metrics } from "../../core/metrics.js";
import {
  logger,
  isToolcallDebugEnabled,
  upstreamDebugEnabled,
} from "../../core/logger.js";
import { sendOpenAIError, createError } from "../../api/error-helpers.js";
import { classifyError } from "../../api/error-classifier.js";
import type { QwenBridgeStatusCode } from "../../core/errors.js";
import { config } from "../../core/config.js";
import { parseQwenErrorPayload, isQuotaLimitError } from "./errors.ts";
import {
  logTokenEstimationSample,
  type TokenEstimationContext,
} from "../../services/token-estimation-metrics.ts";
import {
  getIncrementalDelta,
  formatThinkingSummaryContent,
  shouldSuppressStreamAbort,
  createUsageAccumulator,
  applyUpstreamUsage,
  buildUsage,
} from "./helpers.ts";
import { resolveThinkingConfig } from "../../core/model-registry.ts";
import { estimateTokenCount } from "../../utils/context-truncation.ts";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function extractChatSessionId(chunk: any): string | null {
  const created = chunk?.["response.created"];
  return firstString(
    chunk?.chat_id,
    chunk?.chatId,
    chunk?.session_id,
    chunk?.conversation_id,
    chunk?.conversationId,
    created?.chat_id,
    created?.chatId,
    created?.session_id,
    created?.conversation_id,
    created?.conversationId,
    created?.chat?.id,
    created?.response?.chat_id,
    created?.response?.chat?.id,
  );
}

export interface AssistantCompleteEvent {
  sessionId: string | null;
  accountId: string;
  chatSessionId: string;
  parentId: string | null;
  responseId: string | null;
  userPrompt: string;
  finalPrompt: string;
  assistantContent: string;
  reasoningContent?: string;
  usage: Usage;
  finishReason: string;
}

export type AssistantCompleteHandler = (
  event: AssistantCompleteEvent,
) => Promise<void> | void;

export interface StreamRetryContext {
  completionId: string;
  activeAccountId: string;
  activeAccountLabel: string;
  uiSessionId: string;
}

export interface StreamRetryResult {
  stream: ReadableStream;
  uiSessionId: string;
  activeAccountId: string;
  activeAccountLabel?: string;
  logicalSessionId: string | null;
  tokenEstimationContext?: TokenEstimationContext;
}

export type StreamRetryHandler = (
  error: RetryableQwenStreamError,
  context: StreamRetryContext,
) => Promise<StreamRetryResult | null>;

export interface StreamProcessingParams {
  c: Context;
  completionId: string;
  stream: ReadableStream;
  uiSessionId: string;
  activeAccountId: string;
  activeAccountLabel?: string;
  logicalSessionId: string | null;
  body: OpenAIRequest & { stream_options?: { include_usage?: boolean } };
  finalPrompt: string;
  userPrompt: string;
  shouldParseToolCalls: boolean;
  declaredTools: any[];
  tokenEstimationContext?: TokenEstimationContext;
  onAssistantComplete?: AssistantCompleteHandler;
  onStreamComplete?: () => void;
  onRetryableStreamError?: StreamRetryHandler;
}

async function prepareStreamReader(
  stream: ReadableStream,
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  initialBuffer: string;
  upstreamError: ReturnType<typeof parseQwenErrorPayload>;
}> {
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let initialBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      initialBuffer += decoder.decode();
      break;
    }

    initialBuffer += decoder.decode(value, { stream: true });
    const trimmedInitialBuffer = initialBuffer.trimStart();
    if (
      trimmedInitialBuffer.startsWith("data: ") ||
      trimmedInitialBuffer.startsWith(":")
    ) {
      break;
    }
  }

  return {
    reader,
    decoder,
    initialBuffer,
    upstreamError: parseQwenErrorPayload(initialBuffer),
  };
}

function scheduleAssistantComplete(
  handler: AssistantCompleteHandler | undefined,
  event: AssistantCompleteEvent,
): void {
  if (!handler) return;
  void Promise.resolve()
    .then(() => handler(event))
    .catch((error) => {
      logger.warn("[chat] assistant completion callback failed", {
        sessionId: event.sessionId,
        chatSessionId: event.chatSessionId,
        responseId: event.responseId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

// ─── Non-streaming (JSON response) ─────────────────────────────────────────────

export async function processNonStreamingResponse(
  params: StreamProcessingParams,
): Promise<Response> {
  const {
    c,
    completionId,
    stream,
    uiSessionId,
    activeAccountId,
    activeAccountLabel = activeAccountId,
    logicalSessionId,
    body,
    finalPrompt,
    userPrompt,
    shouldParseToolCalls,
    declaredTools,
    tokenEstimationContext,
    onAssistantComplete,
    onStreamComplete,
  } = params;

  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let lastThinkingSummary = "";
    let lastThinkingSummaryLength = 0;
    let lastThinkingSummarySuffix = "";
    let reasoningBuffer = "";
    let lastRawContent = "";
    let lastRawContentLength = 0;
    let lastRawContentSuffix = "";
    let finalContent = "";
    let targetResponseId: string | null = null;
    let currentUiSessionId = uiSessionId;
    const toolParser = shouldParseToolCalls
      ? new StreamingToolParser(declaredTools)
      : null;
    // Skip sanitizer for Fast / no-thinking; always-thinking models always keep it
    const enableThinking = resolveThinkingConfig(body.model).enableThinking;
    const reasoningTagSanitizer = enableThinking
      ? new StreamingReasoningTagSanitizer()
      : null;
    const toolCallsOut: any[] = [];
    let loggedThinkTagLeak = false;
    let buffer = "";
    // Seed with model-aware estimate only until real upstream usage arrives
    const usageAccumulator = createUsageAccumulator(
      estimateTokenCount(finalPrompt, body.model),
    );

    const rememberSession = (sessionId: string | null) => {
      if (!sessionId || sessionId === currentUiSessionId) return;
      currentUiSessionId = sessionId;
      updateStreamSessionId(completionId, sessionId);
    };

    const rememberParent = (parentId: string) => {
      if (!currentUiSessionId) return;
      updateSessionParent(currentUiSessionId, parentId, activeAccountId);
      updateLogicalThreadParent(
        logicalSessionId,
        parentId,
        activeAccountId,
        currentUiSessionId,
      );
    };

    const consumeAnswerText = (textChunk: string) => {
      if (!toolParser) {
        finalContent += textChunk;
        return;
      }

      const { text, toolCalls } = toolParser.feed(textChunk);
      if (text) {
        finalContent += text;
      }
      if (isToolcallDebugEnabled() && (text || toolCalls.length > 0)) {
        logger.debug("[chat] non-stream: parser feed result", {
          textLength: text.length,
          textPreview: text.substring(0, 100),
          toolCallsCount: toolCalls.length,
          toolCallNames: toolCalls.map((tc) => tc.name),
        });
      }
      for (const tc of toolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        });

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] non-stream: tool_call collected", {
            id: tc.id,
            name: tc.name,
            argsKeys: Object.keys(tc.arguments),
            totalCollected: toolCallsOut.length,
          });
        }
      }
    };

    const consumeSanitizedAnswerChunk = (textChunk: string) => {
      if (!reasoningTagSanitizer) {
        consumeAnswerText(textChunk);
        return;
      }
      const sanitized = reasoningTagSanitizer.feed(textChunk);
      if (sanitized.detectedThinkTag && !loggedThinkTagLeak) {
        logger.warn(
          "[chat] Detected <think> tags in answer content; sanitizing output",
          {
            completionId,
            mode: "non-stream",
            model: body.model,
            hadMalformedTag: sanitized.hadMalformedTag,
            hadUnclosedTag: sanitized.hadUnclosedTag,
          },
        );
        loggedThinkTagLeak = true;
      }
      if (sanitized.reasoning) {
        reasoningBuffer += sanitized.reasoning;
      }
      if (sanitized.text) {
        consumeAnswerText(sanitized.text);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let lineStart = 0;
      let lineEnd = buffer.indexOf("\n", lineStart);

      for (; lineEnd !== -1; lineEnd = buffer.indexOf("\n", lineStart)) {
        const line = buffer.slice(lineStart, lineEnd);
        lineStart = lineEnd + 1;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") continue;

        if (upstreamDebugEnabled) {
          console.log(`[Upstream] Chunk | ${dataStr.substring(0, 500)}`);
        }

        try {
          const chunk = JSON.parse(dataStr);
          rememberSession(extractChatSessionId(chunk));

          // Check for upstream error in chunk
          if (chunk.error) {
            const errDetails =
              chunk.error.details ||
              chunk.error.message ||
              JSON.stringify(chunk.error);
            const errCode = chunk.error.code || "upstream_error";
            console.error(
              `[Upstream] Error | ${errCode} | ${errDetails.substring(0, 200)}`,
            );

            // Anti-bot: FAIL_SYS_USER_VALIDATE / RGV587_ERROR — retryable
            if (
              errDetails.includes("FAIL_SYS_USER_VALIDATE") ||
              errDetails.includes("RGV587_ERROR") ||
              errDetails.includes("user validate")
            ) {
              throw new RetryableQwenStreamError(
                `Qwen anti-bot: ${errCode}: ${errDetails}`,
                config.antiBot.baseDelayMs,
              );
            }

            // Quota exceeded in SSE chunk — retryable (try other account).
            // Covers `quota_limit`, `quota_exceeded`, `RateLimited`, EN/PT-BR
            // messages like "O serviço está com alta demanda no momento.
            // Tente novamente mais tarde." that the upstream returns under
            // high load. Treating these as retryable allows the orchestrator
            // in routes/chat/index.ts to switch accounts and re-stream.
            if (isQuotaLimitError(errCode, errDetails)) {
              throw new RetryableQwenStreamError(
                `Qwen quota: ${errCode}: ${errDetails.substring(0, 200)}`,
                config.retry.baseDelayMs,
              );
            }

            throw new QwenUpstreamError(
              `Qwen upstream error: ${errCode}: ${errDetails}`,
              errCode,
              502,
            );
          }

          if (
            chunk["response.created"] &&
            chunk["response.created"].response_id
          ) {
            if (!targetResponseId) {
              targetResponseId = chunk["response.created"].response_id;
            }
            rememberParent(chunk["response.created"].response_id);
          } else if (chunk.response_id && !targetResponseId) {
            targetResponseId = chunk.response_id;
            rememberParent(chunk.response_id);
          }

          applyUpstreamUsage(usageAccumulator, chunk.usage);

          let vStr = "";
          let foundStr = false;
          let isThinkingChunk = false;

          if (
            chunk.choices &&
            chunk.choices[0] &&
            chunk.choices[0].delta &&
            (targetResponseId === null ||
              chunk.response_id === targetResponseId)
          ) {
            const delta = chunk.choices[0].delta;

            if (delta.phase === "thinking_summary") {
              isThinkingChunk = true;
              const formattedSummary = formatThinkingSummaryContent(delta);
              if (formattedSummary) {
                const result = getIncrementalDelta(
                  lastThinkingSummary,
                  formattedSummary,
                  lastThinkingSummaryLength,
                  lastThinkingSummarySuffix,
                );
                vStr = result.delta;
                lastThinkingSummary = result.matchedContent;
                lastThinkingSummaryLength = result.contentLength;
                lastThinkingSummarySuffix = result.contentSuffix;
                if (vStr) {
                  foundStr = true;
                }
              }
            } else if (delta.phase === "answer") {
              isThinkingChunk = false;
              if (delta.content !== undefined) {
                const newContent = delta.content || "";
                const result = getIncrementalDelta(
                  lastRawContent,
                  newContent,
                  lastRawContentLength,
                  lastRawContentSuffix,
                );
                vStr = result.delta;
                if (vStr) {
                  lastRawContent = result.matchedContent;
                  lastRawContentLength = result.contentLength;
                  lastRawContentSuffix = result.contentSuffix;
                  foundStr = true;
                }
              }
            }
          }

          if (foundStr && vStr !== "") {
            if (vStr === "FINISHED") continue;
            if (isThinkingChunk) {
              reasoningBuffer += vStr;
            } else {
              consumeSanitizedAnswerChunk(vStr);
            }
          }
        } catch (_e) {
          // Re-throw known errors for retry logic in index.ts
          if (
            _e instanceof RetryableQwenStreamError ||
            _e instanceof QwenUpstreamError
          ) {
            throw _e;
          }
          // Log warning for large chunks that fail to parse
          if (dataStr.length > 10) {
            console.warn(
              `[Chat] SSE parse error for chunk (${dataStr.length} chars):`,
              (_e as Error).message,
            );
          }
        }
      }

      buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      removeStream(completionId);
      return sendOpenAIError(
        c,
        createError(
          upstreamError.status as QwenBridgeStatusCode,
          upstreamError.message,
        ),
      );
    }

    if (reasoningTagSanitizer) {
      const remainingSanitized = reasoningTagSanitizer.flush();
      if (remainingSanitized.detectedThinkTag && !loggedThinkTagLeak) {
        logger.warn(
          "[chat] Detected <think> tags in answer content; sanitizing output",
          {
            completionId,
            mode: "non-stream",
            model: body.model,
            hadMalformedTag: remainingSanitized.hadMalformedTag,
            hadUnclosedTag: remainingSanitized.hadUnclosedTag,
          },
        );
        loggedThinkTagLeak = true;
      }
      if (remainingSanitized.reasoning) {
        reasoningBuffer += remainingSanitized.reasoning;
      }
      if (remainingSanitized.text) {
        consumeAnswerText(remainingSanitized.text);
      }
    }

    const remainingParsed = toolParser
      ? toolParser.flush()
      : { text: "", toolCalls: [] };
    const { text: remainingText, toolCalls: remainingToolCalls } =
      remainingParsed;

    if (toolParser && isToolcallDebugEnabled()) {
      logger.debug("[chat] non-stream: parser flush result", {
        remainingTextLength: remainingText?.length || 0,
        remainingToolCallsCount: remainingToolCalls.length,
        remainingToolCallNames: remainingToolCalls.map((tc) => tc.name),
      });
    }

    if (remainingText) {
      finalContent += remainingText;
    }
    for (const tc of remainingToolCalls) {
      toolCallsOut.push({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      });
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] non-stream: final toolcall summary", {
        totalToolCalls: toolCallsOut.length,
        toolCallNames: toolCallsOut.map((tc: any) => tc.function?.name),
        contentLength: finalContent.length,
        hasReasoning: !!reasoningBuffer,
      });
    }

    const usage = buildUsage(usageAccumulator);
    const message: any = {
      role: "assistant",
      content: toolCallsOut.length ? null : finalContent,
    };
    if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
    if (toolCallsOut.length) {
      toolCallsOut.forEach((tc, idx) => {
        tc.index = idx;
      });
      message.tool_calls = toolCallsOut;
    }

    const finishReason = toolCallsOut.length ? "tool_calls" : "stop";

    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] non-stream: sending response", {
        completionId,
        finishReason,
        totalToolCalls: toolCallsOut.length,
        contentLength: message.content?.length || 0,
        hasReasoning: !!message.reasoning_content,
        usage,
      });
    }

    console.log(
      `[Chat] Response sent | ${activeAccountLabel} | ${usage.prompt_tokens} prompt / ${usage.completion_tokens} completion / ${usage.total_tokens} total tokens`,
    );
    logTokenEstimationSample({
      model: body.model,
      finalPrompt,
      userPrompt,
      assistantContent: finalContent,
      reasoningContent: reasoningBuffer || undefined,
      usage,
      mode: "non-stream",
      context: tokenEstimationContext,
    });

    scheduleAssistantComplete(onAssistantComplete, {
      sessionId: logicalSessionId,
      accountId: activeAccountId,
      chatSessionId: currentUiSessionId,
      parentId: null,
      responseId: targetResponseId,
      userPrompt,
      finalPrompt,
      assistantContent: finalContent,
      reasoningContent: reasoningBuffer || undefined,
      usage,
      finishReason,
    });

    return c.json({
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
      usage,
    });
  } finally {
    if (isToolcallDebugEnabled()) {
      logger.debug("[chat] non-stream: cleanup", { completionId });
    }
    removeStream(completionId);
    if (onStreamComplete) onStreamComplete();
  }
}

// ─── Streaming (SSE) ───────────────────────────────────────────────────────────

export async function processStreamingResponse(
  params: StreamProcessingParams,
): Promise<Response> {
  const {
    c,
    completionId,
    stream,
    uiSessionId,
    activeAccountId,
    activeAccountLabel = activeAccountId,
    logicalSessionId,
    body,
    finalPrompt,
    userPrompt,
    shouldParseToolCalls,
    declaredTools,
    tokenEstimationContext,
    onAssistantComplete,
    onStreamComplete,
    onRetryableStreamError,
  } = params;

  // Pre-read initial bytes to detect upstream error before committing to SSE
  const preparedInitialStream = await prepareStreamReader(stream);
  const upstreamError = preparedInitialStream.upstreamError;
  if (upstreamError) {
    await preparedInitialStream.reader.cancel().catch(() => undefined);
    removeStream(completionId);
    if (onStreamComplete) onStreamComplete();
    return sendOpenAIError(
      c,
      createError(
        upstreamError.status as QwenBridgeStatusCode,
        upstreamError.message,
      ),
    );
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatTimeout: NodeJS.Timeout | undefined;
    let clientDisconnected = false;
    let currentUiSessionId = uiSessionId;

    const abortHandler = async () => {
      if (clientDisconnected) return;
      clientDisconnected = true;

      console.log(
        `[Chat] Client disconnected for ${completionId}, stopping Qwen generation...`,
      );

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: client disconnected", {
          completionId,
          uiSessionId: currentUiSessionId,
        });
      }

      try {
        const streamData = getStream(completionId);
        if (streamData && currentUiSessionId) {
          const targetResponseId = streamData.targetResponseId;
          if (targetResponseId) {
            console.log(
              `[Chat] Calling Qwen stop for session=${currentUiSessionId}, response=${targetResponseId}`,
            );
            await fetch(
              `https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${currentUiSessionId}`,
              {
                method: "POST",
                headers: buildQwenRequestHeaders({
                  cookie: streamData.headers.cookie,
                  userAgent: streamData.headers["user-agent"],
                  bxUa: streamData.headers["bx-ua"],
                  bxUmidtoken: streamData.headers["bx-umidtoken"],
                  bxV: streamData.headers["bx-v"],
                  chatSessionId: currentUiSessionId,
                }),
                body: JSON.stringify({
                  chat_id: currentUiSessionId,
                  response_id: targetResponseId,
                }),
              },
            ).catch((err) => {
              console.error(`[Chat] Error calling Qwen stop: ${err.message}`);
            });
          } else {
            console.log(
              `[Chat] No targetResponseId yet for ${completionId}, skipping Qwen stop`,
            );
          }
        }

        try {
          streamData?.abortController.abort();
        } catch (abortErr: any) {
          if (abortErr.name !== "AbortError") {
            console.error(`[Chat] Error aborting stream: ${abortErr.message}`);
          }
        }
      } catch (err: any) {
        console.error(`[Chat] Error during disconnect cleanup: ${err.message}`);
      }

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }
      removeStream(completionId);
    };

    c.req.raw.signal.addEventListener("abort", abortHandler);

    try {
      await streamWriter.write(": heartbeat\n\n");

      const scheduleHeartbeat = () => {
        heartbeatTimeout = setTimeout(async () => {
          if (clientDisconnected) return;
          try {
            await streamWriter.write(": keep-alive\n\n");
            scheduleHeartbeat();
          } catch (err) {
            logger.debug("[streaming] Heartbeat error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, 15000);
      };

      scheduleHeartbeat();

      const createdTimestamp = Math.floor(Date.now() / 1000);

      // Batch buffer: when non-null, writeEvent accumulates instead of flushing
      let flushBuffer: string[] | null = null;

      const writeEvent = async (data: any) => {
        const serialized = `data: ${JSON.stringify(data)}\n\n`;
        if (Array.isArray(flushBuffer)) {
          flushBuffer.push(serialized);
          return;
        }
        await streamWriter.write(serialized);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason,
      });

      // Initial role chunk
      await writeEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({ role: "assistant", content: "" })],
      });

      let reader = preparedInitialStream.reader;
      let decoder = preparedInitialStream.decoder;

      let lastThinkingSummary = "";
      let lastThinkingSummaryLength = 0;
      let lastThinkingSummarySuffix = "";
      let lastRawContent = "";
      let lastRawContentLength = 0;
      let lastRawContentSuffix = "";
      let finalContent = "";
      let reasoningBuffer = "";
      let targetResponseId: string | null = null;
      let currentActiveAccountId = activeAccountId;
      let currentActiveAccountLabel = activeAccountLabel;
      let currentLogicalSessionId = logicalSessionId;
      let currentTokenEstimationContext = tokenEstimationContext;
      const toolParser = shouldParseToolCalls
        ? new StreamingToolParser(declaredTools, {
            incrementalToolCalls: true,
          })
        : null;
      // Skip sanitizer for Fast / no-thinking; always-thinking models always keep it
      const enableThinking = resolveThinkingConfig(body.model).enableThinking;
      const reasoningTagSanitizer = enableThinking
        ? new StreamingReasoningTagSanitizer()
        : null;
      let loggedThinkTagLeak = false;

      let buffer = preparedInitialStream.initialBuffer;
      let upstreamDone = false;
      // Seed with model-aware estimate only until real upstream usage arrives
      const usageAccumulator = createUsageAccumulator(
        estimateTokenCount(finalPrompt, body.model),
      );
      const rememberSession = (sessionId: string | null) => {
        if (!sessionId || sessionId === currentUiSessionId) return;
        currentUiSessionId = sessionId;
        updateStreamSessionId(completionId, sessionId);
      };

      const rememberParent = (parentId: string) => {
        if (!currentUiSessionId) return;
        updateSessionParent(currentUiSessionId, parentId, currentActiveAccountId);
        updateLogicalThreadParent(
          currentLogicalSessionId,
          parentId,
          currentActiveAccountId,
          currentUiSessionId,
        );
      };

      const switchToRetryStream = async (
        error: RetryableQwenStreamError,
      ): Promise<boolean> => {
        if (!onRetryableStreamError || clientDisconnected) return false;

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: switching upstream after retryable error", {
            completionId,
            activeAccountId: currentActiveAccountId,
            error: error.message,
          });
        }

        await reader.cancel("retrying on another account").catch(() => undefined);

        const replacement = await onRetryableStreamError(error, {
          completionId,
          activeAccountId: currentActiveAccountId,
          activeAccountLabel: currentActiveAccountLabel,
          uiSessionId: currentUiSessionId,
        });

        if (!replacement) return false;

        const preparedReplacement = await prepareStreamReader(
          replacement.stream,
        );
        if (preparedReplacement.upstreamError) {
          await preparedReplacement.reader.cancel().catch(() => undefined);
          throw new QwenUpstreamError(
            preparedReplacement.upstreamError.message,
            "upstream_error",
            preparedReplacement.upstreamError.status,
          );
        }

        reader = preparedReplacement.reader;
        decoder = preparedReplacement.decoder;
        buffer = preparedReplacement.initialBuffer;
        upstreamDone = false;
        targetResponseId = null;
        currentUiSessionId = replacement.uiSessionId;
        currentActiveAccountId = replacement.activeAccountId;
        currentActiveAccountLabel =
          replacement.activeAccountLabel || replacement.activeAccountId;
        currentLogicalSessionId = replacement.logicalSessionId;
        currentTokenEstimationContext =
          replacement.tokenEstimationContext || currentTokenEstimationContext;
        updateStreamSessionId(completionId, currentUiSessionId);

        await streamWriter.write(
          `: upstream switched after retryable error\n\n`,
        );

        return true;
      };

      const emitAnswerText = async (textChunk: string) => {
        if (!toolParser) {
          finalContent += textChunk;
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ content: textChunk })],
          });
          return;
        }

        const { text, toolCalls, toolCallDeltas } = toolParser.feed(textChunk);

        if (
          isToolcallDebugEnabled() &&
          (text || toolCalls.length > 0 || toolCallDeltas.length > 0)
        ) {
          logger.debug("[chat] stream: parser feed result", {
            textLength: text.length,
            textPreview: text.substring(0, 100),
            toolCallsCount: toolCalls.length,
            toolCallNames: toolCalls.map((tc) => tc.name),
            toolCallDeltaCount: toolCallDeltas.length,
          });
        }

        if (text) {
          finalContent += text;
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ content: text })],
          });
        }

        for (const delta of toolCallDeltas) {
          if (isToolcallDebugEnabled()) {
            logger.debug(
              "[chat] stream: emitting incremental tool_call delta",
              {
                index: delta.index,
                id: delta.id,
                name: delta.function.name,
                argumentsChunkLength: delta.function.arguments?.length || 0,
              },
            );
          }

          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [
              makeChoice({
                tool_calls: [
                  {
                    index: delta.index,
                    ...(delta.id ? { id: delta.id } : {}),
                    ...(delta.type ? { type: delta.type } : {}),
                    function: {
                      ...(delta.function.name
                        ? { name: delta.function.name }
                        : {}),
                      ...(delta.function.arguments !== undefined
                        ? { arguments: delta.function.arguments }
                        : {}),
                    },
                  },
                ],
              }),
            ],
          });
        }

        for (const tc of toolCalls) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: emitting tool_call chunk", {
              id: tc.id,
              name: tc.name,
              argsKeys: Object.keys(tc.arguments),
              index:
                toolParser.getEmittedToolCallCount() -
                toolCalls.length +
                toolCalls.indexOf(tc),
            });
          }

          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [
              makeChoice({
                tool_calls: [
                  {
                    index:
                      toolParser.getEmittedToolCallCount() -
                      toolCalls.length +
                      toolCalls.indexOf(tc),
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments),
                    },
                  },
                ],
              }),
            ],
          });
        }
      };

      const emitSanitizedAnswerChunk = async (textChunk: string) => {
        if (!reasoningTagSanitizer) {
          await emitAnswerText(textChunk);
          return;
        }
        const sanitized = reasoningTagSanitizer.feed(textChunk);
        if (sanitized.detectedThinkTag && !loggedThinkTagLeak) {
          logger.warn(
            "[chat] Detected <think> tags in answer content; sanitizing output",
            {
              completionId,
              mode: "stream",
              model: body.model,
              hadMalformedTag: sanitized.hadMalformedTag,
              hadUnclosedTag: sanitized.hadUnclosedTag,
            },
          );
          loggedThinkTagLeak = true;
        }

        if (sanitized.reasoning) {
          reasoningBuffer += sanitized.reasoning;
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [makeChoice({ reasoning_content: sanitized.reasoning })],
          });
        }

        if (sanitized.text) {
          await emitAnswerText(sanitized.text);
        }
      };

      // Main SSE reader loop
      readLoop: while (true) {
        if (clientDisconnected) {
          if (isToolcallDebugEnabled()) {
            logger.debug("[chat] stream: breaking loop - client disconnected");
          }
          break;
        }

        if (!buffer.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
        }

        let lineStart = 0;
        let lineEnd = buffer.indexOf("\n", lineStart);

        for (; lineEnd !== -1; lineEnd = buffer.indexOf("\n", lineStart)) {
          const line = buffer.slice(lineStart, lineEnd);
          lineStart = lineEnd + 1;
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") {
            upstreamDone = true;
            break;
          }

          if (upstreamDebugEnabled) {
            console.log(`[Upstream] Chunk | ${dataStr.substring(0, 500)}`);
          }

          // Fast-path: simple text delta (avoids JSON.parse for ~90% of chunks)
          const fastMatch = dataStr.match(
            /^\{"response_id":"[^"]*","choices":\[\{"delta":\{"content":"((?:[^"\\]|\\.)*)"\}\}\]\}$/,
          );
          if (fastMatch) {
            let unescaped = "";
            try {
              unescaped = JSON.parse(`"${fastMatch[1]}"`);
            } catch {
              unescaped = fastMatch[1];
            }

            if (unescaped) {
              const result = getIncrementalDelta(
                lastRawContent,
                unescaped,
                lastRawContentLength,
                lastRawContentSuffix,
              );
              const vStr = result.delta;
              if (vStr && vStr !== "FINISHED") {
                lastRawContent = result.matchedContent;
                lastRawContentLength = result.contentLength;
                lastRawContentSuffix = result.contentSuffix;
                await emitSanitizedAnswerChunk(vStr);
              }
            }
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);
            rememberSession(extractChatSessionId(chunk));

            // Check for upstream error in chunk
            if (chunk.error) {
              const errDetails =
                chunk.error.details ||
                chunk.error.message ||
                JSON.stringify(chunk.error);
              const errCode = chunk.error.code || "upstream_error";
              console.error(
                `[Upstream] Error | ${errCode} | ${errDetails.substring(0, 200)}`,
              );

              // Anti-bot: FAIL_SYS_USER_VALIDATE / RGV587_ERROR — retryable
              if (
                errDetails.includes("FAIL_SYS_USER_VALIDATE") ||
                errDetails.includes("RGV587_ERROR") ||
                errDetails.includes("user validate")
              ) {
                throw new RetryableQwenStreamError(
                  `Qwen anti-bot: ${errCode}: ${errDetails}`,
                  config.antiBot.baseDelayMs,
                );
              }

              // Quota exceeded in SSE chunk — retryable (try other account)
              // Covers `quota_limit`, `quota_exceeded`, `RateLimited`, EN/PT-BR
              // messages like "O serviço está com alta demanda no momento.
              // Tente novamente mais tarde." that the upstream returns under
              // high load. Treating these as retryable allows the orchestrator
              // in routes/chat/index.ts to switch accounts and re-stream.
              if (isQuotaLimitError(errCode, errDetails)) {
                throw new RetryableQwenStreamError(
                  `Qwen quota: ${errCode}: ${errDetails.substring(0, 200)}`,
                  config.retry.baseDelayMs,
                );
              }

              throw new QwenUpstreamError(
                `Qwen upstream error: ${errCode}: ${errDetails}`,
                errCode,
                502,
              );
            }

            if (
              chunk["response.created"] &&
              chunk["response.created"].response_id
            ) {
              if (!targetResponseId) {
                targetResponseId = chunk["response.created"].response_id;
                if (targetResponseId) {
                  updateStreamTargetResponseId(completionId, targetResponseId);
                }
              }
              rememberParent(chunk["response.created"].response_id);
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              if (targetResponseId) {
                updateStreamTargetResponseId(completionId, targetResponseId);
              }
              rememberParent(chunk.response_id);
            }

            applyUpstreamUsage(usageAccumulator, chunk.usage);

            let vStr = "";
            let foundStr = false;
            let isThinkingChunk = false;

            if (
              chunk.choices &&
              chunk.choices[0] &&
              chunk.choices[0].delta &&
              (targetResponseId === null ||
                chunk.response_id === targetResponseId)
            ) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === "thinking_summary") {
                isThinkingChunk = true;
                const formattedSummary = formatThinkingSummaryContent(delta);
                if (formattedSummary) {
                  const result = getIncrementalDelta(
                    lastThinkingSummary,
                    formattedSummary,
                    lastThinkingSummaryLength,
                    lastThinkingSummarySuffix,
                  );
                  vStr = result.delta;
                  lastThinkingSummary = result.matchedContent;
                  lastThinkingSummaryLength = result.contentLength;
                  lastThinkingSummarySuffix = result.contentSuffix;
                  if (vStr) {
                    foundStr = true;
                  }
                }
              } else if (delta.phase === "answer") {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || "";
                  const result = getIncrementalDelta(
                    lastRawContent,
                    newContent,
                    lastRawContentLength,
                    lastRawContentSuffix,
                  );
                  vStr = result.delta;
                  if (vStr) {
                    lastRawContent = result.matchedContent;
                    lastRawContentLength = result.contentLength;
                    lastRawContentSuffix = result.contentSuffix;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== "") {
              if (vStr === "FINISHED") continue;

              if (isThinkingChunk) {
                reasoningBuffer += vStr;
                await writeEvent({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: createdTimestamp,
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })],
                });
              } else {
                await emitSanitizedAnswerChunk(vStr);
              }
            }
          } catch (_e) {
            // Re-throw known errors for retry logic in index.ts
            if (_e instanceof RetryableQwenStreamError) {
              if (await switchToRetryStream(_e)) {
                continue readLoop;
              }
              throw _e;
            }
            if (_e instanceof QwenUpstreamError) {
              throw _e;
            }
            // Ignore partial chunk parse errors
          }
        }

        buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
        if (upstreamDone) {
          buffer = "";
          break;
        }
      }

      // Post-stream: error check + flush remaining content
      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({ content: upstreamError.message })],
        });
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({}, "stop")],
        });
        await streamWriter.write("data: [DONE]\n\n");
        return;
      }

      // Activate batch mode — all writeEvent calls accumulate until flushed
      flushBuffer = [];

      if (reasoningTagSanitizer) {
        const remainingSanitized = reasoningTagSanitizer.flush();
        if (remainingSanitized.detectedThinkTag && !loggedThinkTagLeak) {
          logger.warn(
            "[chat] Detected <think> tags in answer content; sanitizing output",
            {
              completionId,
              mode: "stream",
              model: body.model,
              hadMalformedTag: remainingSanitized.hadMalformedTag,
              hadUnclosedTag: remainingSanitized.hadUnclosedTag,
            },
          );
          loggedThinkTagLeak = true;
        }
        if (remainingSanitized.reasoning) {
          reasoningBuffer += remainingSanitized.reasoning;
          await writeEvent({
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: body.model,
            choices: [
              makeChoice({ reasoning_content: remainingSanitized.reasoning }),
            ],
          });
        }
        if (remainingSanitized.text) {
          await emitAnswerText(remainingSanitized.text);
        }
      }

      const remainingParsed = toolParser
        ? toolParser.flush()
        : { text: "", toolCalls: [], toolCallDeltas: [] };
      const {
        text: remainingText,
        toolCalls: remainingToolCalls,
        toolCallDeltas: remainingToolCallDeltas,
      } = remainingParsed;

      if (toolParser && isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: parser flush result", {
          remainingTextLength: remainingText?.length || 0,
          remainingToolCallsCount: remainingToolCalls.length,
          remainingToolCallNames: remainingToolCalls.map((tc) => tc.name),
          remainingToolCallDeltaCount: remainingToolCallDeltas.length,
          totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
        });
      }

      if (remainingText) {
        finalContent += remainingText;
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [makeChoice({ content: remainingText })],
        });
      }
      for (const delta of remainingToolCallDeltas) {
        if (toolParser && isToolcallDebugEnabled()) {
          logger.debug(
            "[chat] stream: emitting flushed incremental tool_call delta",
            {
              index: delta.index,
              id: delta.id,
              name: delta.function.name,
              argumentsChunkLength: delta.function.arguments?.length || 0,
            },
          );
        }

        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [
            makeChoice({
              tool_calls: [
                {
                  index: delta.index,
                  ...(delta.id ? { id: delta.id } : {}),
                  ...(delta.type ? { type: delta.type } : {}),
                  function: {
                    ...(delta.function.name
                      ? { name: delta.function.name }
                      : {}),
                    ...(delta.function.arguments !== undefined
                      ? { arguments: delta.function.arguments }
                      : {}),
                  },
                },
              ],
            }),
          ],
        });
      }
      for (const tc of remainingToolCalls) {
        if (toolParser && isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: emitting flushed tool_call chunk", {
            id: tc.id,
            name: tc.name,
            argsKeys: Object.keys(tc.arguments),
            index:
              toolParser.getEmittedToolCallCount() -
              remainingToolCalls.length +
              remainingToolCalls.indexOf(tc),
          });
        }

        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [
            makeChoice({
              tool_calls: [
                {
                  index: toolParser
                    ? toolParser.getEmittedToolCallCount() -
                      remainingToolCalls.length +
                      remainingToolCalls.indexOf(tc)
                    : remainingToolCalls.indexOf(tc),
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                },
              ],
            }),
          ],
        });
      }

      // Finish reason + usage + [DONE]
      const usage = buildUsage(usageAccumulator);

      const finalFinishReason =
        toolParser && toolParser.getEmittedToolCallCount() > 0
          ? "tool_calls"
          : "stop";

      if (toolParser && isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: sending finish reason", {
          finishReason: finalFinishReason,
          totalEmittedToolCalls: toolParser.getEmittedToolCallCount(),
          usage,
          includeUsage: body.stream_options?.include_usage,
        });
      }

      await writeEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(body.stream_options?.include_usage ? {} : { usage }),
      });

      if (body.stream_options?.include_usage) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: sending usage event", { usage });
        }
        await writeEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: body.model,
          choices: [],
          usage,
        });
      }

      if (!clientDisconnected) {
        // Single write: flush all accumulated events + [DONE] sentinel
        const donePayload = "data: [DONE]\n\n";
        const payload =
          flushBuffer && flushBuffer.length > 0
            ? flushBuffer.join("") + donePayload
            : donePayload;

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: sending [DONE]", {
            batchedEvents: flushBuffer?.length ?? 0,
          });
        }

        await streamWriter.write(payload);
        flushBuffer = null;

        scheduleAssistantComplete(onAssistantComplete, {
          sessionId: currentLogicalSessionId,
          accountId: currentActiveAccountId,
          chatSessionId: currentUiSessionId,
          parentId: null,
          responseId: targetResponseId,
          userPrompt,
          finalPrompt,
          assistantContent: finalContent,
          reasoningContent: reasoningBuffer || undefined,
          usage,
          finishReason: finalFinishReason,
        });

        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: completed successfully", {
            completionId,
            totalEmittedToolCalls: toolParser
              ? toolParser.getEmittedToolCallCount()
              : 0,
            finishReason: finalFinishReason,
          });
        }

        console.log(
          `[Chat] Response sent | ${currentActiveAccountLabel} | ${usage.prompt_tokens} prompt / ${usage.completion_tokens} completion / ${usage.total_tokens} total tokens`,
        );
        logTokenEstimationSample({
          model: body.model,
          finalPrompt,
          userPrompt,
          assistantContent: finalContent,
          reasoningContent: reasoningBuffer || undefined,
          usage,
          mode: "stream",
          context: currentTokenEstimationContext,
        });
      } else {
        if (isToolcallDebugEnabled()) {
          logger.debug(
            "[chat] stream: skipped [DONE] - client already disconnected",
          );
        }
      }
    } catch (err: any) {
      const streamStillRegistered = Boolean(getStream(completionId));
      if (
        shouldSuppressStreamAbort(
          err,
          clientDisconnected,
          c.req.raw.signal.aborted,
          streamStillRegistered,
        )
      ) {
        if (isToolcallDebugEnabled()) {
          logger.debug("[chat] stream: suppressed expected abort", {
            completionId,
            clientDisconnected,
            requestAborted: c.req.raw.signal.aborted,
            streamStillRegistered,
            errorName: err?.name,
            errorMessage: err?.message,
          });
        }
        return;
      }
      throw err;
    } finally {
      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: cleanup started", {
          completionId,
          clientDisconnected,
        });
      }

      c.req.raw.signal.removeEventListener("abort", abortHandler);
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }
      removeStream(completionId);

      if (isToolcallDebugEnabled()) {
        logger.debug("[chat] stream: cleanup completed", {
          completionId,
        });
      }

      // Release locks now that the stream is fully done
      if (onStreamComplete) onStreamComplete();
    }
  });
}

// ─── Top-level error wrapper ───────────────────────────────────────────────────

export function handleChatCompletionsError(c: Context, err: unknown): Response {
  const classified = classifyError(err);
  if (classified.statusCode >= 500) {
    metrics.increment("requests.errors");
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = classified.code || "unknown";
  const status = classified.statusCode;
  console.error(`[Chat] Error | ${status} ${code} | ${message}`);

  return sendOpenAIError(c, err);
}
