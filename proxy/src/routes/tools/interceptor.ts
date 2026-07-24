/**
 * Tool Call Interceptor — wrap do endpoint /v1/chat/completions que:
 *  1. Injeta tools server-side no body
 *  2. Repassa a request ao handler original (que retorna um stream SSE)
 *  3. Lê o stream, repassa deltas ao cliente, e captura tool_calls
 *  4. Quando o modelo termina com tool_calls, executa server-side,
 *     emite eventos SSE extras (tool_call.start, tool_call.execute.*,
 *     tool_call.result, tool_call.loop) e faz nova request ao handler
 *
 * Importante: como o handler original é um Hono handler (Context -> Response),
 * chamamos via fetch interno ao próprio servidor (localhost) para não precisar
 * recriar Context. O servidor escuta na porta configurada.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  buildOpenAiToolsArray,
  getToolByName,
  type ToolExecutionContext,
} from "./registry.ts";
import { logger } from "../../core/logger.ts";
import { config } from "../../core/config.ts";

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argsBuffer: string;
}

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

const MAX_TOOL_LOOP_ITERATIONS = 6;

/**
 * Faz uma request interna ao próprio proxy /v1/chat/completions e retorna
 * a Response SSE. Usamos fetch ao invés de chamar a função diretamente
 * porque o handler original precisa de um Context Hono completo.
 */
async function callInternalChatCompletion(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  const url = `http://${host}:${config.server.port}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return resp;
}

export async function handleChatWithTools(c: Context): Promise<Response> {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const clientWantsStream = body.stream !== false;
  const enableToolsFlag =
    body.enable_tools === true ||
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    body.tools === undefined;

  // Headers a repassar para a chamada interna
  const fwdHeaders: Record<string, string> = {};
  const authHeader = c.req.header("authorization");
  if (authHeader) fwdHeaders.authorization = authHeader;
  const requestId = c.req.header("X-Request-Id");
  if (requestId) fwdHeaders["X-Request-Id"] = requestId;

  // Passa adiante sem modificar se tools desabilitadas
  if (!enableToolsFlag) {
    const resp = await callInternalChatCompletion(body, fwdHeaders);
    return resp;
  }

  // Injeta tools server-side
  const clientTools = Array.isArray(body.tools) ? body.tools : [];
  body.tools = [...clientTools, ...buildOpenAiToolsArray()];
  if (!body.tool_choice) {
    body.tool_choice = "auto";
  }
  // Força stream interno para podermos interceptar
  body.stream = true;

  if (!clientWantsStream) {
    // Cliente pediu non-streaming — fazemos loop interno e devolvemos JSON final
    const result = await runToolLoopNonStreaming(body, fwdHeaders, requestId);
    return c.json(result);
  }

  // Streaming com interceptação
  return streamSSE(c, async (stream) => {
    let iteration = 0;
    let currentMessages = (body.messages as ChatMessage[]) || [];

    while (iteration < MAX_TOOL_LOOP_ITERATIONS) {
      iteration++;
      body.messages = currentMessages;

      if (iteration > 1) {
        await stream.writeSSE({
          event: "tool_call.loop",
          data: JSON.stringify({ iteration }),
        });
      }

      const resp = await callInternalChatCompletion(body, fwdHeaders);
      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => "Internal error");
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: `Upstream returned ${resp.status}`,
            detail: errText.slice(0, 1000),
          }),
        });
        return;
      }

      const toolCalls: ToolCallAccumulator[] = [];
      let assistantContent = "";
      let finishReason: string | null = null;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let lineBuf = "";

      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          lineBuf += decoder.decode(chunk, { stream: true });
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const ev = JSON.parse(payload) as Record<string, unknown>;
              if (ev.error) {
                await stream.writeSSE({
                  event: "error",
                  data: JSON.stringify({ error: ev.error }),
                });
                return;
              }
              const choices = ev.choices as Array<Record<string, unknown>> | undefined;
              if (!choices || choices.length === 0) continue;
              const choice = choices[0];
              const delta = choice.delta as Record<string, unknown> | undefined;
              if (delta) {
                if (typeof delta.content === "string" && delta.content.length > 0) {
                  assistantContent += delta.content;
                  await stream.writeSSE({
                    data: JSON.stringify({
                      choices: [
                        {
                          delta: { content: delta.content },
                          finish_reason: null,
                        },
                      ],
                    }),
                  });
                }
                if (Array.isArray(delta.tool_calls)) {
                  for (const tcRaw of delta.tool_calls as Array<Record<string, unknown>>) {
                    const idx = Number(tcRaw.index ?? 0);
                    let acc = toolCalls.find((a) => a.index === idx);
                    if (!acc) {
                      acc = { index: idx, id: "", name: "", argsBuffer: "" };
                      toolCalls.push(acc);
                    }
                    if (typeof tcRaw.id === "string") acc.id = tcRaw.id;
                    const fn = tcRaw.function as Record<string, unknown> | undefined;
                    if (fn) {
                      if (typeof fn.name === "string") acc.name = fn.name;
                      if (typeof fn.arguments === "string") {
                        acc.argsBuffer += fn.arguments;
                        await stream.writeSSE({
                          event: "tool_call.args_delta",
                          data: JSON.stringify({
                            tool_call_id: acc.id,
                            name: acc.name,
                            delta: fn.arguments,
                          }),
                        });
                      }
                    }
                  }
                  await stream.writeSSE({
                    data: JSON.stringify({
                      choices: [
                        {
                          delta: { tool_calls: delta.tool_calls },
                          finish_reason: null,
                        },
                      ],
                    }),
                  });
                }
              }
              if (typeof choice.finish_reason === "string") {
                finishReason = choice.finish_reason;
              }
            } catch {
              // ignore
            }
          }
        }
      } finally {
        try {
          reader.cancel();
        } catch {}
      }

      // Sem tool_calls — finaliza
      if (toolCalls.length === 0) {
        await stream.writeSSE({
          data: JSON.stringify({
            choices: [{ delta: {}, finish_reason: finishReason ?? "stop" }],
          }),
        });
        await stream.writeSSE({ data: "[DONE]" });
        return;
      }

      // Adiciona assistant com tool_calls ao contexto
      const assistantToolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.argsBuffer || "{}" },
      }));
      currentMessages = [
        ...currentMessages,
        {
          role: "assistant",
          content: assistantContent || null,
          tool_calls: assistantToolCalls,
        },
      ];

      // Executa cada tool
      for (const tc of toolCalls) {
        await stream.writeSSE({
          event: "tool_call.start",
          data: JSON.stringify({
            tool_call_id: tc.id,
            name: tc.name,
            iteration,
          }),
        });
        await stream.writeSSE({
          event: "tool_call.execute.start",
          data: JSON.stringify({
            tool_call_id: tc.id,
            name: tc.name,
            started_at: Date.now(),
          }),
        });

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.argsBuffer || "{}");
        } catch {
          try {
            args = JSON.parse(
              tc.argsBuffer.replace(/,\s*([}\]])/g, "$1") || "{}",
            );
          } catch {
            args = { _raw: tc.argsBuffer };
          }
        }

        const def = getToolByName(tc.name);
        if (!def) {
          const errResult = JSON.stringify({
            error: `Tool "${tc.name}" not found in proxy registry`,
          });
          await stream.writeSSE({
            event: "tool_call.execute.complete",
            data: JSON.stringify({
              tool_call_id: tc.id,
              name: tc.name,
              success: false,
              duration_ms: 0,
              result_length: errResult.length,
            }),
          });
          await stream.writeSSE({
            event: "tool_call.result",
            data: JSON.stringify({
              tool_call_id: tc.id,
              name: tc.name,
              content: errResult,
              is_error: true,
              duration_ms: 0,
            }),
          });
          currentMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: errResult,
          });
          continue;
        }

        const progressQueue: Array<{ message: string; percent?: number; data?: unknown }> = [];
        const flushProgress = async () => {
          while (progressQueue.length > 0) {
            const upd = progressQueue.shift()!;
            await stream.writeSSE({
              event: "tool_call.execute.progress",
              data: JSON.stringify({
                tool_call_id: tc.id,
                name: tc.name,
                ...upd,
              }),
            });
          }
        };

        const ctx: ToolExecutionContext = {
          toolCallId: tc.id,
          requestId,
          emitProgress: (upd) => {
            progressQueue.push(upd);
          },
        };

        const t0 = Date.now();
        let result: string;
        let success = true;
        try {
          result = await def.execute(args, ctx);
          await flushProgress();
        } catch (e) {
          success = false;
          result = JSON.stringify({
            error: (e as Error).message,
            stack: (e as Error).stack?.split("\n").slice(0, 3).join(" | "),
          });
          await flushProgress();
          logger.error("Tools", `Tool ${tc.name} failed: ${(e as Error).message}`);
        }
        const durationMs = Date.now() - t0;

        await stream.writeSSE({
          event: "tool_call.execute.complete",
          data: JSON.stringify({
            tool_call_id: tc.id,
            name: tc.name,
            success,
            duration_ms: durationMs,
            result_length: result.length,
          }),
        });
        await stream.writeSSE({
          event: "tool_call.result",
          data: JSON.stringify({
            tool_call_id: tc.id,
            name: tc.name,
            content: result,
            is_error: !success,
            duration_ms: durationMs,
          }),
        });

        currentMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
      // Loop continua — próxima iteração
    }

    await stream.writeSSE({
      event: "error",
      data: JSON.stringify({
        error: "Max tool call iterations reached",
        max_iterations: MAX_TOOL_LOOP_ITERATIONS,
      }),
    });
    await stream.writeSSE({ data: "[DONE]" });
  });
}

/**
 * Versão non-streaming: faz o loop internamente e devolve JSON final.
 */
async function runToolLoopNonStreaming(
  body: Record<string, unknown>,
  fwdHeaders: Record<string, string>,
  _requestId: string | undefined,
): Promise<Record<string, unknown>> {
  let iteration = 0;
  let currentMessages = (body.messages as ChatMessage[]) || [];
  body.stream = false;

  while (iteration < MAX_TOOL_LOOP_ITERATIONS) {
    iteration++;
    body.messages = currentMessages;
    const resp = await callInternalChatCompletion(body, fwdHeaders);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "{}");
      try {
        return JSON.parse(text);
      } catch {
        return { error: { message: text, code: resp.status } };
      }
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) return data;
    const choice = choices[0];
    const message = choice.message as Record<string, unknown> | undefined;
    const toolCalls = message?.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;

    if (!toolCalls || toolCalls.length === 0) {
      // Sem tools — adiciona metadados e retorna
      (data as Record<string, unknown>).tool_call_iterations = iteration;
      return data;
    }

    // Adiciona assistant com tool_calls
    currentMessages = [
      ...currentMessages,
      {
        role: "assistant",
        content: (message?.content as string) || null,
        tool_calls: toolCalls.map((tc) => ({
          id: String(tc.id),
          type: "function",
          function: {
            name: String((tc.function as Record<string, unknown>).name),
            arguments: String((tc.function as Record<string, unknown>).arguments || "{}"),
          },
        })),
      },
    ];

    // Executa tools
    for (const tc of toolCalls) {
      const id = String(tc.id);
      const name = String((tc.function as Record<string, unknown>).name);
      const argsStr = String((tc.function as Record<string, unknown>).arguments || "{}");
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsStr);
      } catch {
        args = { _raw: argsStr };
      }
      const def = getToolByName(name);
      const ctx: ToolExecutionContext = {
        toolCallId: id,
        emitProgress: () => {},
      };
      let result: string;
      try {
        result = def ? await def.execute(args, ctx) : JSON.stringify({ error: `Tool ${name} not found` });
      } catch (e) {
        result = JSON.stringify({ error: (e as Error).message });
      }
      currentMessages.push({
        role: "tool",
        tool_call_id: id,
        content: result,
      });
    }
  }

  return {
    error: "Max tool call iterations reached",
    max_iterations: MAX_TOOL_LOOP_ITERATIONS,
  };
}
