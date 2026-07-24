import crypto from "crypto";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesContentPart,
  ResponsesOutputMessage,
  ResponsesOutputFunctionCall,
  ResponsesOutputReasoning,
  ResponsesUsage,
  ResponsesFunctionTool,
} from "./types.ts";
import { makeResponsesUsage } from "./types.ts";
import { applyEffortToModel, normalizeReasoningEffort } from "./effort.ts";

// OpenAI Chat Completions types (internal)
type ChatContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } }
  | { type: "file_url"; file_url: { url: string; filename?: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ChatContentPart[];
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
  }>;
  tool_choice?: string | object;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  parallel_tool_calls?: boolean;
  /** Continuity for QwenBridge chat thread layer */
  session_id?: string;
  conversation_id?: string;
  user?: string;
}

interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
}

interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============ ID generators ============

export function generateResponseId(): string {
  return `resp_${crypto.randomBytes(16).toString("hex")}`;
}

export function generateMessageId(): string {
  return `msg_${crypto.randomBytes(16).toString("hex")}`;
}

export function generateCallId(): string {
  return `call_${crypto.randomBytes(12).toString("hex")}`;
}

// ============ Model mapping ============

/**
 * Map GPT/OpenAI model names to Qwen equivalents.
 * Qwen models pass through as-is.
 */
export function mapResponsesModel(model: string): string {
  if (model.startsWith("qwen")) return model;

  const gptToQwen: Record<string, string> = {
    // GPT-5.x → prefer newest max when available
    "gpt-5.5": "qwen3.8-max-preview",
    "gpt-5.5-turbo": "qwen3.8-max-preview",
    "gpt-5": "qwen3.8-max-preview",
    "gpt-5-turbo": "qwen3.7-plus",
    // GPT-4.1
    "gpt-4.1": "qwen3.7-plus",
    "gpt-4.1-mini": "qwen3.5-flash",
    "gpt-4.1-nano": "qwen3.5-flash",
    // GPT-4o
    "gpt-4o": "qwen3.7-plus",
    "gpt-4o-mini": "qwen3.5-flash",
    "gpt-4o-2024-11-20": "qwen3.7-plus",
    "gpt-4o-2024-08-06": "qwen3.7-plus",
    // GPT-4
    "gpt-4": "qwen3.6-plus",
    "gpt-4-turbo": "qwen3.6-plus",
    "gpt-4-turbo-preview": "qwen3.6-plus",
    // GPT-3.5
    "gpt-3.5-turbo": "qwen3.5-flash",
    // o-series
    o3: "qwen3.7-max",
    "o3-mini": "qwen3.7-plus",
    "o4-mini": "qwen3.7-plus",
    o1: "qwen3.7-max",
    "o1-mini": "qwen3.7-plus",
  };

  return gptToQwen[model] || model;
}

// ============ Request conversion ============

/**
 * Extract text from a content field that can be string or array of parts.
 */
function extractText(content?: string | ResponsesContentPart[]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter(
      (p) =>
        p.type === "input_text" ||
        p.type === "output_text" ||
        p.type === "text",
    )
    .map((p) => p.text || "")
    .join("\n");
}

/**
 * Convert Responses content (incl. images/files) to Chat Completions content.
 * Multimodal parts become image_url / file_url so /v1/chat can upload to Qwen.
 */
function convertContentForChat(
  content?: string | ResponsesContentPart[] | unknown,
): string | null | ChatContentPart[] {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts: ChatContentPart[] = [];
  let hasMedia = false;

  for (const raw of content as ResponsesContentPart[]) {
    const p = raw as ResponsesContentPart & Record<string, unknown>;
    if (
      p.type === "input_text" ||
      p.type === "output_text" ||
      p.type === "text"
    ) {
      if (p.text) parts.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "input_image") {
      const url =
        (typeof p.image_url === "string" ? p.image_url : undefined) ||
        (typeof (p as any).image_url?.url === "string"
          ? (p as any).image_url.url
          : undefined) ||
        (typeof (p as any).url === "string" ? (p as any).url : undefined);
      if (url) {
        hasMedia = true;
        parts.push({
          type: "image_url",
          image_url: {
            url,
            detail: p.detail || "auto",
          },
        });
      }
      continue;
    }
    if (p.type === "input_file") {
      const file = p.file || (p as any);
      const dataUrl =
        file?.file_data ||
        (typeof (p as any).file_data === "string"
          ? (p as any).file_data
          : undefined);
      const fileId = file?.file_id || (p as any).file_id;
      if (dataUrl) {
        hasMedia = true;
        const mimeGuess =
          String(dataUrl).match(/^data:([^;]+)/)?.[1] ||
          "application/octet-stream";
        const isImage = mimeGuess.startsWith("image/");
        if (isImage) {
          parts.push({
            type: "image_url",
            image_url: { url: String(dataUrl), detail: "auto" },
          });
        } else {
          parts.push({
            type: "file_url",
            file_url: {
              url: String(dataUrl),
              filename: file?.filename || "file",
            },
          });
        }
      } else if (fileId) {
        // Keep a text marker so context is not silently lost
        parts.push({
          type: "text",
          text: `[attached file_id=${fileId}${file?.filename ? ` name=${file.filename}` : ""}]`,
        });
      }
      continue;
    }
    // Unknown part — best-effort text
    if (typeof (p as any).text === "string") {
      parts.push({ type: "text", text: (p as any).text });
    }
  }

  if (parts.length === 0) return extractText(content as any) || null;
  if (!hasMedia) {
    return parts
      .filter((x): x is { type: "text"; text: string } => x.type === "text")
      .map((x) => x.text)
      .join("\n");
  }
  return parts;
}

/**
 * Convert Responses API request to OpenAI Chat Completions format.
 */
type ResponsesRequestInput = {
  input: string | unknown[];
} & Omit<ResponsesRequest, "input">;

export function responsesToChatCompletions(
  req: ResponsesRequestInput,
  historyMessages: ChatMessage[] = [],
): ChatRequest {
  const messages: ChatMessage[] = [...historyMessages];

  // Instructions → system message (prepended)
  if (req.instructions) {
    messages.unshift({ role: "system", content: req.instructions });
  }

  // Convert input to messages
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const raw of req.input) {
      const msg = raw as Record<string, unknown>;

      // Handle function_call_output (tool results)
      if (msg.type === "function_call_output") {
        messages.push({
          role: "tool",
          content: (msg.output as string) ?? extractText(msg.content as any),
          tool_call_id: msg.call_id as string,
        });
        continue;
      }

      // Handle function_call (assistant tool calls from history)
      if (msg.type === "function_call") {
        const callId = (msg.call_id as string) || generateCallId();
        const name = (msg.name as string) || "unknown";
        const args = (msg.arguments as string) || "{}";

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name, arguments: args },
            },
          ],
        });
        continue;
      }

      // Skip items without role (unknown types like reasoning)
      if (!("role" in msg)) continue;

      const msgRole = msg.role as string;
      const content = convertContentForChat(msg.content as any);

      if (msgRole === "system" || msgRole === "developer") {
        // System/developer: text only (images in system are rare)
        const textOnly =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter(
                    (p): p is { type: "text"; text: string } =>
                      p.type === "text",
                  )
                  .map((p) => p.text)
                  .join("\n")
              : "";
        messages.push({ role: "system", content: textOnly });
      } else {
        messages.push({ role: msgRole as any, content });
      }
    }
  }

  // Convert tools — only function tools are sent to Qwen
  // Built-in tools (web_search, shell, etc.) are logged (not silently lost)
  let tools: ChatRequest["tools"];
  if (req.tools && req.tools.length > 0) {
    const functionTools = req.tools.filter(
      (t): t is ResponsesFunctionTool => t.type === "function",
    );
    const dropped = req.tools
      .filter((t) => t.type !== "function")
      .map((t) => t.type);
    if (dropped.length > 0) {
      console.log(
        `[Responses] Dropping ${dropped.length} built-in tool type(s) (not function): ${[...new Set(dropped)].join(", ")} — ${functionTools.length} function tool(s) kept`,
      );
    }
    if (functionTools.length > 0) {
      tools = functionTools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: t.strict,
        },
      }));
    }
  }

  // Convert tool_choice
  let toolChoice: ChatRequest["tool_choice"];
  if (req.tool_choice != null) {
    if (typeof req.tool_choice === "string") {
      toolChoice = req.tool_choice;
    } else {
      const name = req.tool_choice.name ?? req.tool_choice.function?.name;
      if (name) {
        toolChoice = {
          type: "function",
          function: { name },
        };
      }
    }
  }

  const effort = normalizeReasoningEffort(req.reasoning?.effort);
  let model = mapResponsesModel(req.model);
  model = applyEffortToModel(model, effort);

  const chatReq: ChatRequest = {
    model,
    messages,
    stream: req.stream ?? false,
  };

  if (tools) chatReq.tools = tools;
  if (toolChoice !== undefined) chatReq.tool_choice = toolChoice;
  if (req.temperature !== undefined) chatReq.temperature = req.temperature;
  if (req.top_p !== undefined) chatReq.top_p = req.top_p;
  if (req.max_output_tokens !== undefined)
    chatReq.max_completion_tokens = req.max_output_tokens;
  if (req.parallel_tool_calls !== undefined)
    chatReq.parallel_tool_calls = req.parallel_tool_calls;

  if (effort) {
    console.log(
      `[Responses] reasoning.effort=${req.reasoning?.effort ?? "?"} → ${effort} | model=${model}`,
    );
  }

  // Continuity: map Responses session/user keys → Chat thread keys
  const sessionFromMeta =
    (req.metadata &&
      (req.metadata.session_id ||
        req.metadata.sessionId ||
        req.metadata.conversation_id)) ||
    undefined;
  const sessionId =
    (req as any).session_id ||
    (req as any).conversation ||
    sessionFromMeta ||
    undefined;
  if (typeof sessionId === "string" && sessionId.trim()) {
    chatReq.session_id = sessionId.trim();
  }
  if (typeof req.user === "string" && req.user.trim()) {
    chatReq.user = req.user.trim();
  }

  return chatReq;
}

// ============ Response conversion ============

/**
 * Convert OpenAI Chat Completions response to Responses API format.
 */
export function chatCompletionsToResponses(
  chatRes: ChatResponse,
  requestModel: string,
  originalRequest: ResponsesRequestInput,
): ResponsesResponse {
  const choice = chatRes.choices[0];
  const output: (
    | ResponsesOutputMessage
    | ResponsesOutputFunctionCall
    | ResponsesOutputReasoning
  )[] = [];

  // Reasoning content → reasoning output item
  if ((choice.message as any).reasoning_content) {
    output.push({
      type: "reasoning",
      id: `rs_${crypto.randomBytes(16).toString("hex")}`,
      summary: [
        {
          type: "summary_text",
          text: (choice.message as any).reasoning_content,
        },
      ],
    });
  }

  // Text content → message output item
  if (choice.message.content) {
    const msgId = generateMessageId();
    output.push({
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        },
      ],
    });
  }

  // Tool calls → function_call output items
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${crypto.randomBytes(12).toString("hex")}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      });
    }
  }

  // Build usage from real chat usage — always include details for Grok serde
  const ptd = (chatRes.usage as any)?.prompt_tokens_details;
  const ctd = (chatRes.usage as any)?.completion_tokens_details;
  const usage: ResponsesUsage = makeResponsesUsage({
    input_tokens: chatRes.usage?.prompt_tokens ?? 0,
    output_tokens: chatRes.usage?.completion_tokens ?? 0,
    total_tokens:
      chatRes.usage?.total_tokens ??
      (chatRes.usage?.prompt_tokens ?? 0) +
        (chatRes.usage?.completion_tokens ?? 0),
    cached_tokens:
      typeof ptd?.cached_tokens === "number" ? ptd.cached_tokens : 0,
    reasoning_tokens:
      typeof ctd?.reasoning_tokens === "number" ? ctd.reasoning_tokens : 0,
  });

  const responseId = generateResponseId();
  return {
    id: responseId,
    object: "response",
    created_at: chatRes.created,
    model: requestModel,
    status: "completed",
    output,
    usage,
    parallel_tool_calls: originalRequest.parallel_tool_calls,
    tool_choice: originalRequest.tool_choice ?? undefined,
    tools: originalRequest.tools ?? undefined,
    temperature: originalRequest.temperature,
    top_p: originalRequest.top_p,
    max_output_tokens: originalRequest.max_output_tokens,
    previous_response_id: originalRequest.previous_response_id || null,
    last_response_id: responseId,
    metadata: originalRequest.metadata,
    user: originalRequest.user,
    reasoning: originalRequest.reasoning
      ? {
          effort: normalizeReasoningEffort(originalRequest.reasoning.effort),
          summary: originalRequest.reasoning.summary as any,
        }
      : undefined,
    error: null,
    incomplete_details: null,
  };
}

/**
 * Build a minimal "in-progress" response for streaming initial event.
 */
export function buildInProgressResponse(
  responseId: string,
  requestModel: string,
  originalRequest: ResponsesRequestInput,
): ResponsesResponse {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: requestModel,
    status: "in_progress",
    output: [],
    // Always include details — Grok CLI fails without input_tokens_details
    usage: makeResponsesUsage({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    }),
    parallel_tool_calls: originalRequest.parallel_tool_calls,
    tool_choice: originalRequest.tool_choice ?? undefined,
    tools: originalRequest.tools ?? undefined,
    temperature: originalRequest.temperature,
    top_p: originalRequest.top_p,
    max_output_tokens: originalRequest.max_output_tokens,
    previous_response_id: originalRequest.previous_response_id || null,
    last_response_id: responseId,
    metadata: originalRequest.metadata,
    user: originalRequest.user,
    reasoning: originalRequest.reasoning
      ? {
          effort: normalizeReasoningEffort(originalRequest.reasoning.effort),
          summary: originalRequest.reasoning.summary as any,
        }
      : undefined,
    error: null,
    incomplete_details: null,
  };
}

/**
 * Finalize an in-progress response for the completed event.
 */
export function finalizeResponse(
  inProgress: ResponsesResponse,
  output: (
    | ResponsesOutputMessage
    | ResponsesOutputFunctionCall
    | ResponsesOutputReasoning
  )[],
  usage: ResponsesUsage,
): ResponsesResponse {
  return {
    ...inProgress,
    status: "completed",
    output,
    usage,
    last_response_id: inProgress.id,
  };
}

export type ChatHistoryMessage = ChatMessage;

/**
 * Convert a Responses API output array into Chat Completions history messages.
 */
export function responsesOutputToChatMessages(
  output: (
    | ResponsesOutputMessage
    | ResponsesOutputFunctionCall
    | ResponsesOutputReasoning
  )[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolCalls: ChatToolCall[] = [];
  const textParts: string[] = [];

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          textParts.push(part.text);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    }
  }

  if (textParts.length > 0 || toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return messages;
}
