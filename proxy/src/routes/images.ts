/*
 * OpenAI-compatible image endpoints (scaffold).
 *
 * Full Qwen native image_gen_tool reverse-eng is incomplete.
 * This route:
 *  - Accepts OpenAI-shaped POST /v1/images/generations
 *  - Isolates media generation from agent tools (documented design)
 *  - Currently returns 501 with actionable next steps OR optional experimental
 *    path via QWEN_IMAGE_GEN_EXPERIMENTAL=1 (prompt-based, native tools briefly enabled)
 */

import { Hono } from "hono";
import { config } from "../core/config.ts";

const app = new Hono();

/**
 * POST /v1/images/generations
 * Body: { model?, prompt, n?, size?, response_format?: "url"|"b64_json" }
 */
app.post("/v1/images/generations", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          message: "Invalid JSON body",
          type: "invalid_request_error",
          param: null,
          code: "invalid_json",
        },
      },
      400,
    );
  }

  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return c.json(
      {
        error: {
          message: "'prompt' is required",
          type: "invalid_request_error",
          param: "prompt",
          code: "missing_prompt",
        },
      },
      400,
    );
  }

  const experimental =
    process.env.QWEN_IMAGE_GEN_EXPERIMENTAL === "1" ||
    process.env.QWEN_IMAGE_GEN_EXPERIMENTAL === "true";

  if (!experimental) {
    return c.json(
      {
        error: {
          message:
            "Image generation is scaffolded but not fully reverse-engineered for chat.qwen.ai. " +
            "Native image_gen_tool is force-disabled for agent stability. " +
            "Set QWEN_IMAGE_GEN_EXPERIMENTAL=1 to enable experimental path (WIP), " +
            "or capture a real browser Network sample of image gen and wire qwen-media.ts.",
          type: "not_implemented_error",
          param: null,
          code: "image_gen_not_implemented",
        },
        qwenbridge: {
          status: "scaffold",
          design: {
            isolation: "enable image_gen_tool only on a dedicated media lane, never mid-Codex turn",
            endpoint_upstream: "POST /api/v2/chat/completions + tools_enabled.image_gen_tool",
            disable_after: "always restore tools_enabled via disableNativeTools()",
          },
        },
      },
      501,
    );
  }

  // Experimental: ask a thinking-off multimodal model to produce markdown image URLs
  // This is a best-effort fallback, NOT true native image_gen_tool.
  try {
    const model = typeof body.model === "string" ? body.model : "qwen3.7-plus";
    const response = await fetch(
      `http://127.0.0.1:${config.server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
        },
        body: JSON.stringify({
          model: model.endsWith("-no-thinking")
            ? model
            : `${model.replace(/-no-thinking$/, "")}-no-thinking`,
          stream: false,
          messages: [
            {
              role: "user",
              content:
                "You are an image generation helper. If you cannot generate images, reply exactly: " +
                "NO_IMAGE. Otherwise output only a single markdown image like ![img](https://...).\n\n" +
                `Prompt: ${prompt}`,
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      return c.json(
        {
          error: {
            message: `Upstream chat failed: ${response.status} ${text.slice(0, 200)}`,
            type: "api_error",
            param: null,
            code: "upstream_error",
          },
        },
        502,
      );
    }

    const json = (await response.json()) as any;
    const content = json?.choices?.[0]?.message?.content || "";
    const urls = [
      ...content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g),
      ...content.matchAll(/(https?:\/\/\S+\.(?:png|jpg|jpeg|webp|gif))/gi),
    ].map((m: RegExpMatchArray) => m[1]);

    if (!urls.length) {
      return c.json(
        {
          error: {
            message:
              "Experimental path did not receive image URLs from the model. " +
              "Native image_gen_tool reverse-eng is still required.",
            type: "api_error",
            param: null,
            code: "no_image_in_response",
            details: String(content).slice(0, 500),
          },
        },
        502,
      );
    }

    const n = Math.min(Math.max(Number(body.n) || 1, 1), 4);
    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: urls.slice(0, n).map((url: string) => ({ url })),
    });
  } catch (err) {
    return c.json(
      {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: "api_error",
          param: null,
          code: "image_gen_failed",
        },
      },
      500,
    );
  }
});

/**
 * POST /v1/videos/generations — not reverse-engineered yet
 */
app.post("/v1/videos/generations", async (c) => {
  return c.json(
    {
      error: {
        message:
          "Video generation is not reverse-engineered on chat.qwen.ai in this bridge. " +
          "Video input (upload) already works via multimodal chat.",
        type: "not_implemented_error",
        param: null,
        code: "video_gen_not_implemented",
      },
    },
    501,
  );
});

export { app as imagesApp };
