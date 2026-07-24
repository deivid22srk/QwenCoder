import { Hono, type Context } from "hono";
import { config } from "../../core/config.ts";
import { validateResponsesRequest } from "./validation.ts";
import {
  responsesToChatCompletions,
  chatCompletionsToResponses,
  buildInProgressResponse,
  finalizeResponse,
  generateResponseId,
  responsesOutputToChatMessages,
} from "./adapter.ts";
import {
  createStreamState,
  processChatChunk,
  buildFinalOutput,
  buildFinalUsage,
} from "./streaming.ts";
import {
  storeResponse,
  getStoredEntry,
  getStoredResponse,
  deleteStoredResponse,
  getLatestResponseIdForSession,
  canUseNativeQwenMemory,
  startPeriodicCleanup,
  type StoredResponseMeta,
} from "./state.ts";
import {
  getLogicalThreadState,
  updateLogicalThreadState,
} from "../../services/qwen.ts";
import type { ResponsesRequest } from "./types.ts";

const app = new Hono();

// Durable + memory store cleanup (idempotent)
startPeriodicCleanup();

function resolveSessionKey(
  req: ResponsesRequest,
  previousMeta?: StoredResponseMeta | null,
  responseId?: string,
): string {
  const fromMeta =
    (req.metadata &&
      (req.metadata.session_id ||
        req.metadata.sessionId ||
        req.metadata.conversation_id)) ||
    undefined;
  const explicit =
    req.session_id ||
    (req as any).conversation ||
    fromMeta ||
    previousMeta?.sessionId ||
    previousMeta?.logicalSessionId;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  // Sticky chain key so Qwen thread memory survives without client session_id
  if (req.previous_response_id) {
    return `responses:${req.previous_response_id}`;
  }
  return `responses:${responseId || generateResponseId()}`;
}

/**
 * Rehydrate Qwen logical thread from a stored previous response so the
 * next turn can send only the new user input (parent_id chain) instead of
 * replaying the full OpenAI message history.
 */
function rehydrateQwenThread(entry: NonNullable<ReturnType<typeof getStoredEntry>>): boolean {
  const sessionKey = entry.sessionId || entry.logicalSessionId;
  if (!sessionKey || !entry.qwenChatId || !entry.qwenParentId) return false;

  updateLogicalThreadState(sessionKey, {
    accountId: entry.qwenAccountId || "global",
    chatSessionId: entry.qwenChatId,
    parentId: entry.qwenParentId,
    instructionsSent: true,
  });
  return true;
}

function collectStoreMeta(
  sessionKey: string,
  finalOutputMessages: any[],
  chatRequestMessages: any[],
): StoredResponseMeta {
  const thread = getLogicalThreadState(sessionKey);
  return {
    sessionId: sessionKey,
    logicalSessionId: sessionKey,
    qwenChatId: thread?.chatSessionId ?? null,
    qwenParentId: thread?.parentId ?? null,
    qwenAccountId: thread?.accountId ?? null,
  };
}

/**
 * POST /v1/responses - Create a response (OpenAI Responses API format)
 */
app.post("/v1/responses", async (c) => {
  const requestStartedAt = Date.now();

  // Parse and validate request
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return responsesError(c, "invalid_request_error", "Invalid JSON body", 400);
  }

  const validation = validateResponsesRequest(body);
  if (!validation.valid) {
    return responsesError(c, "invalid_request_error", validation.error!, 400);
  }

  const req = validation.data!;
  const isStream = req.stream ?? false;
  const requestModel = req.model;

  // Resolve previous_response_id from explicit field or session latest
  let previousResponseId = req.previous_response_id || null;
  if (!previousResponseId) {
    const sessionHint =
      req.session_id ||
      (req as any).conversation ||
      req.metadata?.session_id ||
      req.metadata?.sessionId;
    if (typeof sessionHint === "string" && sessionHint.trim()) {
      previousResponseId = getLatestResponseIdForSession(sessionHint.trim());
    }
  }

  console.log(
    `[Responses] Request | ${requestModel} | ${typeof req.input === "string" ? "string" : `${req.input.length} msg(s)`}${req.tools ? ` | ${req.tools.length} tool(s)` : ""}${isStream ? " | stream" : ""}${previousResponseId ? " | stateful" : ""}`,
  );

  try {
    let historyMessages: any[] = [];
    let previousEntry: ReturnType<typeof getStoredEntry> = null;
    let useNativeMemory = false;

    if (previousResponseId) {
      previousEntry = getStoredEntry(previousResponseId);
      if (!previousEntry) {
        return responsesError(
          c,
          "invalid_request_error",
          `Response '${previousResponseId}' not found or expired`,
          404,
        );
      }

      // Prefer Qwen parent_id chain: skip full history resend
      if (canUseNativeQwenMemory(previousEntry) && rehydrateQwenThread(previousEntry)) {
        useNativeMemory = true;
        historyMessages = [];
        console.log(
          `[Responses] Native Qwen memory | prev=${previousResponseId} | chat=${previousEntry.qwenChatId} | parent=${previousEntry.qwenParentId}`,
        );
      } else {
        historyMessages = previousEntry.chatMessages;
      }
    }

    // Sticky session for thread-native chat path
    const responseId = generateResponseId();
    const sessionKey = resolveSessionKey(
      { ...req, previous_response_id: previousResponseId },
      previousEntry,
      responseId,
    );

    // Convert to Chat Completions format
    // When native memory is active, only send the NEW turn (no full history)
    const chatRequest = responsesToChatCompletions(
      { ...req, previous_response_id: previousResponseId },
      historyMessages,
    );
    // Force sticky session so chat layer reuses Qwen parent_id
    chatRequest.session_id = sessionKey;

    // If we used native memory but history was empty of assistant turns,
    // inject a synthetic assistant placeholder so chat context treats this as continuation.
    // (session_id alone already enables allowThreadReuse when hasExplicitConversationKey)

    if (isStream) {
      // ============ STREAMING MODE ============
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const inProgressResponse = buildInProgressResponse(
        responseId,
        requestModel,
        { ...req, previous_response_id: previousResponseId },
      );

      let upstreamAbortController: AbortController | null = null;
      let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let requestAbortHandler: (() => void) | null = null;
      let streamClosed = false;

      const abortUpstream = (reason?: unknown) => {
        streamClosed = true;
        upstreamAbortController?.abort();
        if (upstreamReader) {
          void upstreamReader.cancel(reason).catch(() => undefined);
        }
      };
      const cleanupAbortHandling = () => {
        if (requestAbortHandler) {
          c.req.raw.signal.removeEventListener("abort", requestAbortHandler);
          requestAbortHandler = null;
        }
        upstreamAbortController = null;
      };

      const readable = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          // OpenAI Responses SSE: both `event:` and `data:` lines for max client compat
          const enqueue = (event: string, data: any) => {
            if (streamClosed) return;
            try {
              const eventName =
                typeof event === "string" && event.length > 0
                  ? event
                  : typeof data?.type === "string"
                    ? data.type
                    : "message";
              const payload =
                data && typeof data === "object"
                  ? { ...data, type: data.type || eventName }
                  : data;
              controller.enqueue(
                encoder.encode(
                  `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`,
                ),
              );
            } catch {
              streamClosed = true;
            }
          };

          const streamState = createStreamState(responseId, requestModel);
          let completionTokens = 0;
          let streamError: Error | null = null;
          requestAbortHandler = () => abortUpstream("client disconnected");
          c.req.raw.signal.addEventListener("abort", requestAbortHandler);

          try {
            // Emit response.created
            enqueue("response.created", {
              type: "response.created",
              sequence_number: streamState.sequenceNumber++,
              response: inProgressResponse,
            });

            // Emit response.in_progress
            enqueue("response.in_progress", {
              type: "response.in_progress",
              sequence_number: streamState.sequenceNumber++,
              response: inProgressResponse,
            });

            // Internal Chat Completions — always request real usage
            upstreamAbortController = new AbortController();
            const response = await fetch(
              `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
                },
                body: JSON.stringify({
                  ...chatRequest,
                  stream: true,
                  stream_options: { include_usage: true },
                }),
                signal: upstreamAbortController.signal,
              },
            );

            if (!response.ok) {
              const errorText = await response.text();
              console.error(
                `[Responses] Upstream error: ${response.status} ${errorText}`,
              );
              throw new Error(`Upstream service error: ${response.status}`);
            }

            upstreamReader = response.body?.getReader() ?? null;
            if (!upstreamReader) {
              throw new Error("No response body");
            }

            const decoder = new TextDecoder();
            let responseBuffer = "";

            try {
              while (true) {
                const { done, value } = await upstreamReader.read();
                if (done) break;

                responseBuffer += decoder.decode(value, { stream: true });
                const lines = responseBuffer.split("\n");
                responseBuffer = lines.pop() || "";

                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const data = line.slice(6);
                  if (data === "[DONE]") continue;

                  try {
                    const chunk = JSON.parse(data);

                    if (chunk.usage?.completion_tokens !== undefined) {
                      completionTokens = chunk.usage.completion_tokens;
                    } else if (chunk.usage?.output_tokens !== undefined) {
                      completionTokens = chunk.usage.output_tokens;
                    }

                    const events = processChatChunk(
                      chunk,
                      streamState,
                      inProgressResponse,
                    );
                    for (const event of events) {
                      const stamped = {
                        ...event,
                        sequence_number: streamState.sequenceNumber++,
                      };
                      enqueue(event.type, stamped);
                    }
                  } catch {
                    // Ignore parse errors
                  }
                }
              }
            } finally {
              upstreamReader?.releaseLock();
              upstreamReader = null;
            }
          } catch (error) {
            streamError =
              error instanceof Error ? error : new Error(String(error));
            if (
              streamError.message?.includes("ERR_INVALID_STATE") ||
              streamError.message?.includes("aborted") ||
              streamError.message?.includes("cancelled")
            ) {
              streamClosed = true;
            } else {
              console.error("[Responses] Stream error:", streamError.message);
            }
          } finally {
            if (streamClosed) {
              cleanupAbortHandling();
              return;
            }
            try {
              const finalOutput = buildFinalOutput(streamState);
              const finalUsage = buildFinalUsage(streamState, completionTokens);
              const finalResponse = finalizeResponse(
                inProgressResponse,
                finalOutput,
                finalUsage,
              );

              if (streamError) {
                enqueue("response.failed", {
                  type: "response.failed",
                  sequence_number: streamState.sequenceNumber++,
                  response: {
                    ...finalResponse,
                    status: "failed",
                    error: {
                      code: "api_error",
                      message: streamError.message,
                    },
                  },
                });
              } else {
                enqueue("response.completed", {
                  type: "response.completed",
                  sequence_number: streamState.sequenceNumber++,
                  response: finalResponse,
                });

                if (req.store !== false) {
                  const meta = collectStoreMeta(
                    sessionKey,
                    finalOutput,
                    chatRequest.messages,
                  );
                  // For native-memory turns, still accumulate fallback history
                  // so cold start (expired Qwen chat) can replay
                  const fallbackHistory = useNativeMemory
                    ? [
                        ...(previousEntry?.chatMessages || []),
                        ...chatRequest.messages.filter(
                          (m) =>
                            !(
                              previousEntry?.chatMessages || []
                            ).some(
                              (h: any) =>
                                h.role === m.role &&
                                h.content === m.content,
                            ),
                        ),
                        ...responsesOutputToChatMessages(finalOutput),
                      ]
                    : [
                        ...chatRequest.messages,
                        ...responsesOutputToChatMessages(finalOutput),
                      ];
                  storeResponse(responseId, finalResponse, fallbackHistory, meta);
                }

                console.log(
                  `[Responses] Response | ${responseId} | ${finalUsage.input_tokens} input / ${finalUsage.output_tokens} output${finalUsage.input_tokens_details?.cached_tokens ? ` | cached=${finalUsage.input_tokens_details.cached_tokens}` : ""}${useNativeMemory ? " | native-mem" : ""}`,
                );
              }
            } catch (finalError) {
              console.error(
                "[Responses] Failed to emit final event:",
                finalError,
              );
            }

            try {
              if (!streamClosed) controller.close();
            } catch {
              // Already closed
            } finally {
              cleanupAbortHandling();
            }
          }
        },
        cancel(reason) {
          abortUpstream(reason);
          cleanupAbortHandling();
        },
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      // ============ NON-STREAMING MODE ============
      const response = await fetch(
        `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
          },
          body: JSON.stringify(chatRequest),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[Responses] Upstream error: ${response.status} ${errorText}`,
        );
        return responsesError(c, "api_error", "Upstream service error", 502);
      }

      const chatResponse = await response.json();
      const responsesResponse = chatCompletionsToResponses(
        chatResponse,
        requestModel,
        { ...req, previous_response_id: previousResponseId },
      );
      // Keep pre-generated response id for chain stability
      responsesResponse.id = responseId;
      responsesResponse.last_response_id = responseId;

      if (req.store !== false) {
        const meta = collectStoreMeta(
          sessionKey,
          responsesResponse.output,
          chatRequest.messages,
        );
        const fallbackHistory = useNativeMemory
          ? [
              ...(previousEntry?.chatMessages || []),
              ...chatRequest.messages,
              ...responsesOutputToChatMessages(responsesResponse.output),
            ]
          : [
              ...chatRequest.messages,
              ...responsesOutputToChatMessages(responsesResponse.output),
            ];
        storeResponse(
          responsesResponse.id,
          responsesResponse,
          fallbackHistory,
          meta,
        );
      }

      const duration = Date.now() - requestStartedAt;
      console.log(
        `[Responses] Response | ${responsesResponse.id} | ${responsesResponse.usage?.input_tokens || 0} input / ${responsesResponse.usage?.output_tokens || 0} output | ${duration}ms${useNativeMemory ? " | native-mem" : ""}`,
      );

      return c.json(responsesResponse);
    }
  } catch (error) {
    console.error("[Responses] Error:", error);
    return responsesError(c, "api_error", "Internal server error", 500);
  }
});

/**
 * GET /v1/responses/session/:session_id/latest
 * Resolve last_response_id for a session (proxy memory helper).
 * Registered before :response_id so "session" is not captured as an id.
 */
app.get("/v1/responses/session/:session_id/latest", async (c) => {
  const sessionId = c.req.param("session_id");
  const latestId = getLatestResponseIdForSession(sessionId);
  if (!latestId) {
    return responsesError(
      c,
      "invalid_request_error",
      `No stored response for session '${sessionId}'`,
      404,
    );
  }
  const stored = getStoredResponse(latestId);
  return c.json({
    id: latestId,
    last_response_id: latestId,
    object: "response",
    response: stored,
  });
});

/**
 * GET /v1/responses/:response_id - Retrieve a stored response
 */
app.get("/v1/responses/:response_id", async (c) => {
  const responseId = c.req.param("response_id");

  const stored = getStoredResponse(responseId);
  if (!stored) {
    return responsesError(
      c,
      "invalid_request_error",
      `Response '${responseId}' not found`,
      404,
    );
  }

  return c.json(stored);
});

/**
 * DELETE /v1/responses/:response_id - Delete a stored response
 */
app.delete("/v1/responses/:response_id", async (c) => {
  const responseId = c.req.param("response_id");

  const existed = deleteStoredResponse(responseId);
  return c.json({
    id: responseId,
    object: "response.deleted",
    deleted: existed,
  });
});

/**
 * Responses API error response helper
 */
function responsesError(
  c: Context,
  type: string,
  message: string,
  statusCode: number,
  param?: string | null,
  code?: string | null,
) {
  return c.json(
    {
      error: {
        message,
        type,
        param: param ?? null,
        code: code ?? type,
      },
    },
    statusCode as any,
  );
}

export { app as responsesApp };
