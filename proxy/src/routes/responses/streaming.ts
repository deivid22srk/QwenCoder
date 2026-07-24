import crypto from "crypto";
import type {
  ResponsesResponse,
  ResponsesOutputMessage,
  ResponsesOutputFunctionCall,
  ResponsesOutputReasoning,
  ResponsesOutputContentPart,
  ResponsesUsage,
  ResponsesStreamEvent,
} from "./types.ts";
import { makeResponsesUsage } from "./types.ts";

/**
 * Convert OpenAI Chat Completions streaming chunks to Responses API streaming events.
 *
 * The Responses API has more granular streaming events than Chat Completions:
 * - response.created
 * - response.in_progress
 * - response.output_item.added
 * - response.content_part.added
 * - response.output_text.delta (multiple)
 * - response.output_text.done
 * - response.content_part.done
 * - response.output_item.done
 * - response.function_call_arguments.delta (for tool calls)
 * - response.function_call_arguments.done
 * - response.completed
 */

export interface ResponsesStreamState {
  responseId: string;
  messageId: string;
  reasoningId: string;
  requestModel: string;
  outputIndex: number;
  contentIndex: number;
  sequenceNumber: number;
  currentBlockType: "text" | "function_call" | "reasoning" | null;
  accumulatedText: string;
  accumulatedReasoning: string;
  accumulatedToolCalls: Map<
    number,
    {
      id: string;
      callId: string;
      name: string;
      arguments: string;
      outputIndex: number;
    }
  >;
  completedOutput: (
    | ResponsesOutputMessage
    | ResponsesOutputFunctionCall
    | ResponsesOutputReasoning
  )[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  hasRealUsage: boolean;
  reasoningPartStarted: boolean;
}

export function createStreamState(
  responseId: string,
  requestModel: string,
): ResponsesStreamState {
  return {
    responseId,
    messageId: `msg_${crypto.randomBytes(16).toString("hex")}`,
    reasoningId: `rs_${crypto.randomBytes(16).toString("hex")}`,
    requestModel,
    outputIndex: 0,
    contentIndex: 0,
    sequenceNumber: 0,
    currentBlockType: null,
    accumulatedText: "",
    accumulatedReasoning: "",
    accumulatedToolCalls: new Map(),
    completedOutput: [],
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    hasRealUsage: false,
    reasoningPartStarted: false,
  };
}

/** Stamp OpenAI-style sequence_number onto every stream event. */
export function stampSequence(
  state: ResponsesStreamState,
  event: ResponsesStreamEvent,
): ResponsesStreamEvent {
  const seq = state.sequenceNumber++;
  return { ...event, sequence_number: seq } as ResponsesStreamEvent;
}

/**
 * Process a Chat Completions streaming chunk and emit Responses API events.
 */
export function processChatChunk(
  chunk: any,
  state: ResponsesStreamState,
  response: ResponsesResponse,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  // Capture real usage from chat layer (OpenAI or Qwen field names)
  if (chunk.usage && typeof chunk.usage === "object") {
    const u = chunk.usage as Record<string, unknown>;
    const prompt =
      typeof u.prompt_tokens === "number"
        ? u.prompt_tokens
        : typeof u.input_tokens === "number"
          ? u.input_tokens
          : undefined;
    const completion =
      typeof u.completion_tokens === "number"
        ? u.completion_tokens
        : typeof u.output_tokens === "number"
          ? u.output_tokens
          : undefined;
    if (typeof prompt === "number") {
      state.inputTokens = prompt;
      state.hasRealUsage = true;
    }
    if (typeof completion === "number") {
      state.outputTokens = completion;
      state.hasRealUsage = true;
    }
    const ptd = u.prompt_tokens_details as
      | { cached_tokens?: number }
      | undefined;
    const itd = u.input_tokens_details as
      | { cached_tokens?: number }
      | undefined;
    if (typeof ptd?.cached_tokens === "number") {
      state.cachedTokens = ptd.cached_tokens;
    } else if (typeof itd?.cached_tokens === "number") {
      state.cachedTokens = itd.cached_tokens;
    }
    const ctd = u.completion_tokens_details as
      | { reasoning_tokens?: number }
      | undefined;
    const otd = u.output_tokens_details as
      | { reasoning_tokens?: number }
      | undefined;
    if (typeof ctd?.reasoning_tokens === "number") {
      state.reasoningTokens = ctd.reasoning_tokens;
    } else if (typeof otd?.reasoning_tokens === "number") {
      state.reasoningTokens = otd.reasoning_tokens;
    }
  }

  const choice = chunk.choices?.[0];
  if (!choice) return events;

  const delta = choice.delta ?? {};

  // Reasoning content (thinking/reasoning from Qwen models)
  if (delta.reasoning_content) {
    // Close non-reasoning block if active
    if (
      state.currentBlockType === "text" ||
      state.currentBlockType === "function_call"
    ) {
      if (state.currentBlockType === "text") {
        events.push(...closeCurrentText(state));
      } else if (state.currentBlockType === "function_call") {
        events.push(...closeCurrentFunctionCall(state));
      }
    }

    // Start reasoning block if needed (OpenAI part lifecycle)
    if (state.currentBlockType !== "reasoning") {
      const reasoningItem: ResponsesOutputReasoning = {
        type: "reasoning",
        id: state.reasoningId,
        summary: [],
      };
      events.push({
        type: "response.output_item.added",
        response_id: state.responseId,
        output_index: state.outputIndex,
        item: reasoningItem,
      });
      events.push({
        type: "response.reasoning_summary_part.added",
        response_id: state.responseId,
        item_id: state.reasoningId,
        output_index: state.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      } as any);
      state.currentBlockType = "reasoning";
      state.reasoningPartStarted = true;
    }

    state.accumulatedReasoning += delta.reasoning_content;
    events.push({
      type: "response.reasoning_summary_text.delta",
      response_id: state.responseId,
      item_id: state.reasoningId,
      output_index: state.outputIndex,
      summary_index: 0,
      delta: delta.reasoning_content,
    } as any);
  }

  // Text content
  if (delta.content) {
    // Start text block if needed
    if (state.currentBlockType !== "text") {
      // Close previous block if exists
      if (state.currentBlockType === "function_call") {
        events.push(...closeCurrentFunctionCall(state));
      } else if (state.currentBlockType === "reasoning") {
        events.push(...closeCurrentReasoning(state));
      }

      // Emit output_item.added for message
      const messageItem: ResponsesOutputMessage = {
        type: "message",
        id: state.messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      };
      events.push({
        type: "response.output_item.added",
        response_id: state.responseId,
        output_index: state.outputIndex,
        item: messageItem,
      });

      // Emit content_part.added
      const contentPart: ResponsesOutputContentPart = {
        type: "output_text",
        text: "",
        annotations: [],
      };
      events.push({
        type: "response.content_part.added",
        response_id: state.responseId,
        item_id: state.messageId,
        output_index: state.outputIndex,
        content_index: state.contentIndex,
        part: contentPart,
      });

      state.currentBlockType = "text";
    }

    // Emit text delta
    state.accumulatedText += delta.content;
    events.push({
      type: "response.output_text.delta",
      response_id: state.responseId,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: state.contentIndex,
      delta: delta.content,
    });
  }

  // Tool calls
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const index = tc.index;

      // New tool call
      if (tc.function?.name) {
        // Close previous text block if exists
        if (state.currentBlockType === "text") {
          events.push(...closeCurrentText(state));
        }

        const callId =
          tc.id || `call_${crypto.randomBytes(12).toString("hex")}`;
        const fcId = `fc_${crypto.randomBytes(12).toString("hex")}`;
        const outputIndex = state.outputIndex++;

        state.accumulatedToolCalls.set(index, {
          id: fcId,
          callId,
          name: tc.function.name,
          arguments: "",
          outputIndex,
        });

        // Emit output_item.added for function_call
        const fcItem: ResponsesOutputFunctionCall = {
          type: "function_call",
          id: fcId,
          call_id: callId,
          name: tc.function.name,
          arguments: "",
          status: "in_progress",
        };
        events.push({
          type: "response.output_item.added",
          response_id: state.responseId,
          output_index: outputIndex,
          item: fcItem,
        });

        state.currentBlockType = "function_call";
      }

      // Tool call arguments
      if (tc.function?.arguments) {
        const stored = state.accumulatedToolCalls.get(index);
        if (stored) {
          stored.arguments += tc.function.arguments;
          events.push({
            type: "response.function_call_arguments.delta",
            response_id: state.responseId,
            item_id: stored.id,
            output_index: stored.outputIndex,
            call_id: stored.callId,
            delta: tc.function.arguments,
          });
        }
      }
    }
  }

  // Finish reason
  if (choice.finish_reason) {
    // Close current block
    if (state.currentBlockType === "reasoning") {
      events.push(...closeCurrentReasoning(state));
    }
    if (state.currentBlockType === "text") {
      events.push(...closeCurrentText(state));
    } else if (state.currentBlockType === "function_call") {
      events.push(...closeCurrentFunctionCall(state));
    }
  }

  return events;
}

/**
 * Close the current text content block.
 */
function closeCurrentText(state: ResponsesStreamState): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  if (state.currentBlockType !== "text") return events;

  // Emit output_text.done
  events.push({
    type: "response.output_text.done",
    response_id: state.responseId,
    item_id: state.messageId,
    output_index: state.outputIndex,
    content_index: state.contentIndex,
    text: state.accumulatedText,
  });

  // Emit content_part.done
  const contentPart: ResponsesOutputContentPart = {
    type: "output_text",
    text: state.accumulatedText,
    annotations: [],
  };
  events.push({
    type: "response.content_part.done",
    response_id: state.responseId,
    item_id: state.messageId,
    output_index: state.outputIndex,
    content_index: state.contentIndex,
    part: contentPart,
  });

  // Emit output_item.done for message
  const messageItem: ResponsesOutputMessage = {
    type: "message",
    id: state.messageId,
    role: "assistant",
    status: "completed",
    content: [contentPart],
  };
  events.push({
    type: "response.output_item.done",
    response_id: state.responseId,
    output_index: state.outputIndex,
    item: messageItem,
  });
  state.completedOutput.push(messageItem);

  state.currentBlockType = null;
  state.contentIndex++;
  state.outputIndex++;

  return events;
}

/**
 * Close all current function call blocks.
 */
function closeCurrentFunctionCall(
  state: ResponsesStreamState,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  if (state.currentBlockType !== "function_call") return events;

  // Close all accumulated tool calls
  for (const [index, fc] of state.accumulatedToolCalls) {
    // Emit function_call_arguments.done
    events.push({
      type: "response.function_call_arguments.done",
      response_id: state.responseId,
      item_id: fc.id,
      output_index: fc.outputIndex,
      call_id: fc.callId,
      name: fc.name,
      arguments: fc.arguments,
    });

    // Emit output_item.done for function_call
    const fcItem: ResponsesOutputFunctionCall = {
      type: "function_call",
      id: fc.id,
      call_id: fc.callId,
      name: fc.name,
      arguments: fc.arguments,
      status: "completed",
    };
    events.push({
      type: "response.output_item.done",
      response_id: state.responseId,
      output_index: fc.outputIndex,
      item: fcItem,
    });
    state.completedOutput.push(fcItem);
  }

  state.currentBlockType = null;
  state.accumulatedToolCalls.clear();

  return events;
}

/**
 * Close the current reasoning block.
 */
function closeCurrentReasoning(
  state: ResponsesStreamState,
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [];

  if (state.currentBlockType !== "reasoning") return events;

  if (state.reasoningPartStarted) {
    events.push({
      type: "response.reasoning_summary_text.done",
      response_id: state.responseId,
      item_id: state.reasoningId,
      output_index: state.outputIndex,
      summary_index: 0,
      text: state.accumulatedReasoning,
    } as any);
    events.push({
      type: "response.reasoning_summary_part.done",
      response_id: state.responseId,
      item_id: state.reasoningId,
      output_index: state.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: state.accumulatedReasoning },
    } as any);
    state.reasoningPartStarted = false;
  }

  const reasoningItem: ResponsesOutputReasoning = {
    type: "reasoning",
    id: state.reasoningId,
    summary: [{ type: "summary_text", text: state.accumulatedReasoning }],
  };
  events.push({
    type: "response.output_item.done",
    response_id: state.responseId,
    output_index: state.outputIndex,
    item: reasoningItem,
  });
  state.completedOutput.push(reasoningItem);

  state.currentBlockType = null;
  state.outputIndex++;

  return events;
}

/**
 * Build the final output items from accumulated stream state.
 */
export function buildFinalOutput(
  state: ResponsesStreamState,
): (
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning
)[] {
  const output: (
    | ResponsesOutputMessage
    | ResponsesOutputFunctionCall
    | ResponsesOutputReasoning
  )[] = [...state.completedOutput];

  // Add an open reasoning block if the stream ended without a finish_reason
  if (state.currentBlockType === "reasoning" && state.accumulatedReasoning) {
    output.push({
      type: "reasoning",
      id: state.reasoningId,
      summary: [{ type: "summary_text", text: state.accumulatedReasoning }],
    });
  }

  // Add an open text block if the stream ended without a finish_reason
  if (state.currentBlockType === "text" && state.accumulatedText) {
    output.push({
      type: "message",
      id: state.messageId,
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: state.accumulatedText,
          annotations: [],
        },
      ],
    });
  }

  // Add open function calls if the stream ended without a finish_reason
  if (state.currentBlockType === "function_call") {
    for (const [, fc] of state.accumulatedToolCalls) {
      output.push({
        type: "function_call",
        id: fc.id,
        call_id: fc.callId,
        name: fc.name,
        arguments: fc.arguments,
        status: "completed",
      });
    }
  }

  return output;
}

/**
 * Build final usage from stream state — prefers real upstream token counts.
 */
export function buildFinalUsage(
  state: ResponsesStreamState,
  completionTokens?: number,
): ResponsesUsage {
  const output =
    state.outputTokens > 0
      ? state.outputTokens
      : typeof completionTokens === "number"
        ? completionTokens
        : 0;
  // Always include details — Grok serde requires input_tokens_details
  return makeResponsesUsage({
    input_tokens: state.inputTokens,
    output_tokens: output,
    cached_tokens: state.cachedTokens > 0 ? state.cachedTokens : 0,
    reasoning_tokens: state.reasoningTokens > 0 ? state.reasoningTokens : 0,
  });
}
