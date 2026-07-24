import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEffortToModel,
  normalizeReasoningEffort,
  effortToProviderLabel,
  effortEnablesThinking,
} from "../routes/responses/effort.ts";
import { validateResponsesRequest } from "../routes/responses/validation.ts";
import { responsesToChatCompletions } from "../routes/responses/adapter.ts";
import {
  isAlwaysThinkingModel,
  resolveThinkingConfig,
  stripNoThinkingSuffix,
} from "../core/model-registry.ts";
import {
  canUseNativeQwenMemory,
  storeResponse,
  getStoredEntry,
  getLatestResponseIdForSession,
  clearStore,
} from "../routes/responses/state.ts";

test("normalizeReasoningEffort maps Codex and Fast/Max efforts", () => {
  assert.equal(normalizeReasoningEffort("xhigh"), "high");
  assert.equal(normalizeReasoningEffort("max"), "high");
  assert.equal(normalizeReasoningEffort("none"), "low");
  assert.equal(normalizeReasoningEffort("minimal"), "low");
  assert.equal(normalizeReasoningEffort("fast"), "low");
  assert.equal(normalizeReasoningEffort("quick"), "low");
  assert.equal(normalizeReasoningEffort("medium"), "medium");
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort(undefined), undefined);
});

test("effort labels: Max vs Fast", () => {
  assert.equal(effortToProviderLabel("high"), "Max");
  assert.equal(effortToProviderLabel("low"), "Fast");
  assert.equal(effortToProviderLabel("medium"), "Medium");
  assert.equal(effortEnablesThinking("low"), false);
  assert.equal(effortEnablesThinking("high"), true);
  assert.equal(effortEnablesThinking("medium"), true);
});

test("applyEffortToModel toggles no-thinking for low/Fast", () => {
  assert.equal(
    applyEffortToModel("qwen3.7-max", "low"),
    "qwen3.7-max-no-thinking",
  );
  assert.equal(
    applyEffortToModel("qwen3.7-max-no-thinking", "high"),
    "qwen3.7-max",
  );
  assert.equal(applyEffortToModel("qwen3.7-plus", "high"), "qwen3.7-plus");
});

test("qwen3.8-max-preview always keeps thinking (no Fast twin rewrite)", () => {
  assert.equal(isAlwaysThinkingModel("qwen3.8-max-preview"), true);
  assert.equal(
    applyEffortToModel("qwen3.8-max-preview", "low"),
    "qwen3.8-max-preview",
  );
  assert.equal(
    applyEffortToModel("qwen3.8-max-preview-no-thinking", "low"),
    "qwen3.8-max-preview",
  );
  assert.equal(
    applyEffortToModel("qwen3.8-max-preview", "high"),
    "qwen3.8-max-preview",
  );
  const cfg = resolveThinkingConfig("qwen3.8-max-preview", false);
  assert.equal(cfg.enableThinking, true);
  assert.equal(cfg.thinkingMode, "Thinking");
  assert.equal(cfg.thinkingFormat, "summary");
});

test("resolveThinkingConfig Fast vs Thinking for normal models", () => {
  const off = resolveThinkingConfig("qwen3.7-plus-no-thinking");
  assert.equal(off.enableThinking, false);
  assert.equal(off.thinkingMode, "Fast");
  assert.equal(off.thinkingFormat, undefined);

  const on = resolveThinkingConfig("qwen3.7-plus");
  assert.equal(on.enableThinking, true);
  assert.equal(on.thinkingMode, "Thinking");
  assert.equal(on.thinkingFormat, "summary");
});

test("stripNoThinkingSuffix", () => {
  assert.equal(stripNoThinkingSuffix("qwen3.7-max-no-thinking"), "qwen3.7-max");
  assert.equal(stripNoThinkingSuffix("qwen3.8-max-preview"), "qwen3.8-max-preview");
});

test("validateResponsesRequest accepts xhigh / max / fast effort", () => {
  const result = validateResponsesRequest({
    model: "qwen3.7-max",
    input: "hello",
    reasoning: { effort: "xhigh" },
    stream: true,
  });
  assert.equal(result.valid, true, result.error);
  assert.equal(result.data?.reasoning?.effort, "high");

  const fast = validateResponsesRequest({
    model: "qwen3.7-plus",
    input: "hi",
    reasoning: { effort: "fast" },
  });
  assert.equal(fast.valid, true, fast.error);
  assert.equal(fast.data?.reasoning?.effort, "low");
});

test("validateResponsesRequest accepts none and minimal", () => {
  for (const effort of ["none", "minimal", "max", "fast"]) {
    const result = validateResponsesRequest({
      model: "qwen3.7-max",
      input: "hi",
      reasoning: { effort },
    });
    assert.equal(result.valid, true, `${effort}: ${result.error}`);
  }
});

test("responsesToChatCompletions maps input_image to image_url parts", () => {
  const chat = responsesToChatCompletions({
    model: "qwen3.7-plus",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,aaa",
            detail: "high",
          },
        ],
      },
    ],
  });
  const user = chat.messages.find((m) => m.role === "user");
  assert.ok(user);
  assert.ok(Array.isArray(user!.content));
  const parts = user!.content as any[];
  assert.ok(parts.some((p) => p.type === "text"));
  assert.ok(parts.some((p) => p.type === "image_url"));
});

test("responsesToChatCompletions keeps function tools and drops built-ins", () => {
  const chat = responsesToChatCompletions({
    model: "qwen3.7-max",
    input: "test",
    tools: [
      {
        type: "function",
        name: "list-clients",
        description: "x",
        parameters: {},
      },
      { type: "web_search" } as any,
      { type: "shell" } as any,
    ],
  });
  assert.equal(chat.tools?.length, 1);
  assert.equal(chat.tools?.[0].function.name, "list-clients");
});

test("responses store tracks last_response_id chain meta for native memory", () => {
  clearStore();
  const responseId = "resp_test_native_1";
  storeResponse(
    responseId,
    {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: "qwen3.8-max-preview",
      status: "completed",
      output: [],
      last_response_id: responseId,
    },
    [{ role: "user", content: "hi" }],
    {
      sessionId: "sess-abc",
      logicalSessionId: "sess-abc",
      qwenChatId: "chat-xyz",
      qwenParentId: "parent-msg-1",
      qwenAccountId: "acc-1",
    },
  );

  const entry = getStoredEntry(responseId);
  assert.ok(entry);
  assert.equal(entry!.qwenChatId, "chat-xyz");
  assert.equal(entry!.qwenParentId, "parent-msg-1");
  assert.equal(canUseNativeQwenMemory(entry), true);
  assert.equal(getLatestResponseIdForSession("sess-abc"), responseId);

  clearStore();
});
