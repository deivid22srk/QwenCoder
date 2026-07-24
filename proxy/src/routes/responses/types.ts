// OpenAI Responses API types (/v1/responses)

// ============ Request types ============

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputMessage[];
  instructions?: string | null;
  stream?: boolean;
  previous_response_id?: string | null;
  tools?: ResponsesTool[] | null;
  tool_choice?: ResponsesToolChoice | null;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  store?: boolean;
  user?: string;
  metadata?: Record<string, string>;
  parallel_tool_calls?: boolean;
  // Reasoning (optional, passthrough) — clients may send xhigh/none/minimal (normalized in validation)
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "none" | "minimal" | "max" | string;
    summary?: "auto" | "concise" | "detailed" | "none" | string;
  } | null;
  text?: {
    verbosity?: "low" | "medium" | "high" | string;
    format?: { type?: string; [k: string]: unknown };
  } | null;
  truncation?: "auto" | "disabled";
  service_tier?: "auto" | "default" | "flex" | "priority" | string;
  /** Optional conversation continuity keys used by some clients */
  session_id?: string;
  conversation?: string;
  prompt_cache_key?: string;
  include?: string[];
  background?: boolean;
}

export type ResponsesInputMessage =
  | ResponsesMessageInputItem
  | ResponsesFunctionCallInputItem
  | ResponsesFunctionCallOutputInputItem;

export interface ResponsesMessageInputItem {
  type?: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesContentPart[];
}

export interface ResponsesFunctionCallInputItem {
  type: "function_call";
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface ResponsesFunctionCallOutputInputItem {
  type: "function_call_output";
  call_id?: string;
  output?: string;
  content?: string | ResponsesContentPart[];
  role?: "tool";
}

export interface ResponsesContentPart {
  type: "input_text" | "output_text" | "text" | "input_image" | "input_file";
  text?: string;
  // For images
  image_url?: string;
  detail?: "auto" | "low" | "high";
  // For files
  file?: {
    file_id?: string;
    file_data?: string;
    filename?: string;
  };
}

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesBuiltinTool {
  type: string; // web_search, file_search, shell, code_interpreter, etc.
  [key: string]: unknown;
}

export type ResponsesTool = ResponsesFunctionTool | ResponsesBuiltinTool;

export type ResponsesToolChoice =
  | "auto"
  | "required"
  | "none"
  | {
      type: "function";
      name?: string;
      function?: { name: string };
    };

// ============ Response types ============

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "incomplete";
  error?: {
    code: string;
    message: string;
  } | null;
  incomplete_details?: {
    reason: string;
  } | null;
  output: ResponsesOutputItem[];
  parallel_tool_calls?: boolean;
  tool_choice?: ResponsesToolChoice;
  tools?: ResponsesTool[];
  usage?: ResponsesUsage;
  // Metadata
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  previous_response_id?: string | null;
  metadata?: Record<string, string>;
  text?: { verbosity?: "low" | "medium" | "high"; format?: { type: "text" } };
  reasoning?: {
    effort?: "low" | "medium" | "high" | string;
    summary?: "auto" | "concise" | "detailed" | string;
  };
  truncation?: "auto" | "disabled";
  user?: string;
  /** Echo of last id for clients that look for last_response_id */
  last_response_id?: string;
}

/**
 * OpenAI Responses usage shape.
 * Always emit details objects — Grok CLI (Rust/serde) requires
 * `input_tokens_details` and rejects streams that omit it.
 */
export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
  };
  output_tokens_details: {
    reasoning_tokens: number;
  };
}

/** Build a complete Responses usage block (never omit details). */
export function makeResponsesUsage(parts: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}): ResponsesUsage {
  const input_tokens = parts.input_tokens ?? 0;
  const output_tokens = parts.output_tokens ?? 0;
  return {
    input_tokens,
    output_tokens,
    total_tokens: parts.total_tokens ?? input_tokens + output_tokens,
    input_tokens_details: {
      cached_tokens: parts.cached_tokens ?? 0,
    },
    output_tokens_details: {
      reasoning_tokens: parts.reasoning_tokens ?? 0,
    },
  };
}

export interface ResponsesOutputReasoning {
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning;

export interface ResponsesOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "in_progress";
  content: ResponsesOutputContentPart[];
}

export interface ResponsesOutputFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress";
}

export interface ResponsesOutputContentPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

// ============ Streaming event types ============

export type ResponsesStreamEvent =
  | { type: "response.created"; response: ResponsesResponse }
  | { type: "response.in_progress"; response: ResponsesResponse }
  | {
      type: "response.output_item.added";
      response_id?: string;
      output_index: number;
      item: ResponsesOutputItem;
    }
  | {
      type: "response.content_part.added";
      response_id?: string;
      item_id: string;
      output_index: number;
      content_index: number;
      part: ResponsesOutputContentPart;
    }
  | {
      type: "response.output_text.delta";
      response_id?: string;
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      response_id?: string;
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
  | {
      type: "response.content_part.done";
      response_id?: string;
      item_id: string;
      output_index: number;
      content_index: number;
      part: ResponsesOutputContentPart;
    }
  | {
      type: "response.output_item.done";
      response_id?: string;
      output_index: number;
      item: ResponsesOutputItem;
    }
  | {
      type: "response.function_call_arguments.delta";
      response_id?: string;
      item_id: string;
      output_index: number;
      call_id?: string;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      response_id?: string;
      item_id: string;
      output_index: number;
      call_id?: string;
      name?: string;
      arguments: string;
    }
  | {
      type: "response.reasoning_summary_text.delta";
      response_id?: string;
      item_id: string;
      output_index: number;
      delta: string;
    }
  | { type: "response.completed"; response: ResponsesResponse }
  | { type: "response.failed"; response: ResponsesResponse }
  | { type: "error"; code: string; message: string };
