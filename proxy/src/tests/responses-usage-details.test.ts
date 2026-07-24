import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResponsesUsage } from "../routes/responses/types.ts";
import { buildInProgressResponse } from "../routes/responses/adapter.ts";
import { buildFinalUsage } from "../routes/responses/streaming.ts";
import type { ResponsesStreamState } from "../routes/responses/streaming.ts";

test("makeResponsesUsage always includes input_tokens_details", () => {
  const u = makeResponsesUsage({ input_tokens: 10, output_tokens: 5 });
  assert.equal(u.input_tokens, 10);
  assert.equal(u.output_tokens, 5);
  assert.equal(u.total_tokens, 15);
  assert.deepEqual(u.input_tokens_details, { cached_tokens: 0 });
  assert.deepEqual(u.output_tokens_details, { reasoning_tokens: 0 });
});

test("buildInProgressResponse usage has required details for Grok serde", () => {
  const ip = buildInProgressResponse("resp_test", "qwen3.8-max-preview", {
    model: "qwen3.8-max-preview",
    input: "hi",
  } as any);
  assert.ok(ip.usage);
  assert.ok(ip.usage.input_tokens_details);
  assert.equal(typeof ip.usage.input_tokens_details.cached_tokens, "number");
  assert.ok(ip.usage.output_tokens_details);
  assert.equal(typeof ip.usage.output_tokens_details.reasoning_tokens, "number");
});

test("buildFinalUsage with zero cache still emits input_tokens_details", () => {
  const state = {
    inputTokens: 23,
    outputTokens: 10,
    cachedTokens: 0,
    reasoningTokens: 0,
  } as ResponsesStreamState;
  const final = buildFinalUsage(state);
  assert.deepEqual(final.input_tokens_details, { cached_tokens: 0 });
  assert.deepEqual(final.output_tokens_details, { reasoning_tokens: 0 });
  assert.equal(final.total_tokens, 33);
});

test("buildFinalUsage preserves cached and reasoning when present", () => {
  const state = {
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 12,
    reasoningTokens: 40,
  } as ResponsesStreamState;
  const final = buildFinalUsage(state);
  assert.deepEqual(final.input_tokens_details, { cached_tokens: 12 });
  assert.deepEqual(final.output_tokens_details, { reasoning_tokens: 40 });
});
