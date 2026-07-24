import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { config } from "../core/config.js";
import { metrics } from "../core/metrics.js";
import { logger, maskEmail, cli } from "../core/logger.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { Watchdog } from "../core/watchdog.js";
import { app as modelsApp } from "./models.js";
import { chatCompletionsStop } from "../routes/chat.js";
import { uploadFile } from "../routes/upload.js";
import { anthropicApp } from "../routes/anthropic/index.js";
import { responsesApp } from "../routes/responses/index.js";
import { imagesApp } from "../routes/images.js";
import { sendOpenAIError } from "./error-helpers.js";
import { AuthError, NotFoundError } from "../core/errors.js";
import type { QwenAccount } from "../core/accounts.js";
// Novos módulos — tools server-side + accounts management
import { accountsApp } from "../routes/accounts/index.js";
import { handleChatWithTools } from "../routes/tools/interceptor.js";
import { listToolDefinitions, buildOpenAiToolsArray } from "../routes/tools/registry.js";

// Module-level state (initialized in startServer)
let cache: MemoryCache | undefined;
let watchdog: Watchdog | undefined;
let server: any;
let startPromise: Promise<StartedServerInfo> | null = null;
let stopPromise: Promise<void> | null = null;
let signalHandlersInstalled = false;

const app = new Hono();

// Module-level accessor for cross-module cache access
export function getCache(): MemoryCache | undefined {
  return cache;
}

export function setCacheForTesting(nextCache: MemoryCache | undefined): void {
  cache = nextCache;
}

// Middleware must be registered BEFORE routes
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") || uuidv4();
  c.header("X-Request-Id", requestId);

  metrics.increment("requests.total");
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  metrics.histogram("latency.request", duration);
  c.header("X-Response-Time", `${duration}ms`);
});

function constantTimeStringEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const providedHash = crypto.createHash("sha256").update(providedBuf).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedBuf).digest();

  return (
    crypto.timingSafeEqual(providedHash, expectedHash) &&
    providedBuf.length === expectedBuf.length
  );
}

function verifyApiKey(c: Context): Response | null {
  const apiKey = process.env.API_KEY || config.apiKey;
  if (!apiKey) return null;

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return sendOpenAIError(
      c,
      new AuthError("Missing or invalid Authorization header"),
    );
  }
  const token = auth.slice(7);
  if (!constantTimeStringEqual(token, apiKey)) {
    return sendOpenAIError(c, new AuthError("Invalid API key"));
  }
  return null;
}

app.use("/v1/*", async (c, next) => {
  const error = verifyApiKey(c);
  if (error) return error;
  await next();
});

// Routes
app.route("", modelsApp);
// /v1/chat/completions agora passa pelo interceptor de tools server-side
// — ele injeta tools, detecta tool_calls no stream, executa server-side
// e emite eventos SSE extras (tool_call.start, tool_call.execute.*,
// tool_call.result, tool_call.loop).
app.post("/v1/chat/completions", (c) => handleChatWithTools(c));
app.post("/v1/chat/completions/stop", chatCompletionsStop);
app.post("/v1/upload", uploadFile);

// Accounts management REST API — permite ao app Android listar,
// adicionar, remover e gerenciar contas Qwen em runtime.
app.route("/v1/accounts", accountsApp);

// Tools introspection endpoints
app.get("/v1/tools", (c) => {
  return c.json({
    tools: listToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    openai_format: buildOpenAiToolsArray(),
  });
});

// Anthropic API compatible routes
app.route("", anthropicApp);

// OpenAI Responses API compatible routes
app.route("", responsesApp);

// OpenAI Images / Videos (scaffold + experimental)
app.route("", imagesApp);

app.get("/health", async (c) => {
  const status = await watchdog?.getStatus();
  return c.json({
    status: status?.overall || "unknown",
    timestamp: Date.now(),
    metrics: {
      cache: await cache?.getStats(),
    },
  });
});

app.get("/metrics", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.text(metrics.formatPrometheus(), {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

app.onError((err, c) => {
  const requestId = c.req.header("X-Request-Id") || "unknown";
  metrics.increment("requests.errors");
  logger.error("API Error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return sendOpenAIError(c, err);
});

app.notFound((c) => sendOpenAIError(c, new NotFoundError("Not found")));

export interface StartedServerInfo {
  host: string;
  port: number;
  url: string;
}

function buildStartedServerInfo(): StartedServerInfo {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return {
    host,
    port: config.server.port,
    url: `http://${host}:${config.server.port}`,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function warmConfiguredChatPools(
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
  accountId?: string,
): Promise<void> {
  await Promise.all(
    config.qwen.chatPoolModels.map((model) =>
      warmQwenChatPool(accountId, model).catch(() => {}),
    ),
  );
}

async function prepareQwenRuntime(params: {
  accountId?: string;
  successMessage: string;
  failureMessage: string;
  initAuth: () => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
}): Promise<void> {
  try {
    await params.initAuth();
    await params.disableNativeTools(params.accountId).catch(() => {});
    await warmConfiguredChatPools(params.warmQwenChatPool, params.accountId);
    // Prefer explicit OK badge when message is a plain [Server] line
    if (
      typeof params.successMessage === "string" &&
      params.successMessage.startsWith("[Server] Account ready")
    ) {
      cli.ok("Server", params.successMessage.replace(/^\[Server\]\s*/, ""));
    } else {
      console.log(params.successMessage);
    }
  } catch (error) {
    console.error(params.failureMessage, getErrorMessage(error));
  }
}

async function cleanupServerResources(): Promise<void> {
  watchdog?.stop();
  watchdog = undefined;
  metrics.stopCollection();

  try {
    await cache?.close();
  } finally {
    cache = undefined;
  }

  try {
    const { stopSessionKeeper } = await import("../services/session-keeper.ts");
    stopSessionKeeper();
  } catch {
    // Session keeper may not have been initialized.
  }

  if (config.qwen.deleteAllChatsOnShutdown) {
    try {
      const { deleteChatsForConfiguredAccounts } =
        await import("../services/chat-cleanup.ts");
      const result = await deleteChatsForConfiguredAccounts();
      console.log(
        `[Server] Deleted Qwen chats on shutdown: ${result.succeeded}/${result.attempted} scope(s).`,
      );
    } catch (error) {
      console.error(
        "[Server] Failed to delete Qwen chats on shutdown:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const { closeAllPlaywright } = await import("../services/playwright.ts");
  await closeAllPlaywright();

  const { closeDatabase } = await import("../core/database.ts");
  closeDatabase();

  const activeServer = server;
  server = undefined;
  if (activeServer?.close) {
    await new Promise<void>((resolve) => {
      try {
        if (activeServer.close.length > 0) {
          activeServer.close(() => resolve());
        } else {
          activeServer.close();
          resolve();
        }
      } catch {
        resolve();
      }
    });
  }
}

async function handleSignal(signal: string): Promise<never> {
  console.log(`[Server] Shutdown | ${signal}`);
  // Force-exit after a hard cap so a stuck `stopServer` (e.g. a Playwright
  // mutex that never resolves because Chromium was killed mid-launch)
  // can't keep the process alive indefinitely. The cap is generous (10s)
  // to give in-flight cleanup real time to complete in normal cases.
  const forceExitTimer = setTimeout(() => {
    console.error(
      `[Server] Shutdown timeout — forcing exit (some cleanup may have been skipped).`,
    );
    process.exit(1);
  }, 10_000);
  // Don't keep the Node event loop alive just for this timer.
  forceExitTimer.unref();
  try {
    await stopServer();
  } catch (err) {
    console.error(
      `[Server] Error during shutdown: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(forceExitTimer);
  }
  process.exit(0);
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
  signalHandlersInstalled = true;
}

export async function stopServer(): Promise<void> {
  if (stopPromise) {
    await stopPromise;
    return;
  }

  stopPromise = (async () => {
    if (!server && !cache && !watchdog) return;
    await cleanupServerResources();
  })();

  try {
    await stopPromise;
  } finally {
    stopPromise = null;
  }
}

export async function startServer(options?: {
  installSignalHandlers?: boolean;
}): Promise<StartedServerInfo> {
  if (server) {
    if (options?.installSignalHandlers !== false) installSignalHandlers();
    return buildStartedServerInfo();
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    // Install SIGINT/SIGTERM handlers BEFORE the batch init so that an
    // operator hitting Ctrl+C during Playwright account initialization
    // triggers a graceful shutdown (closeAllPlaywright sets the
    // `closingAllPlaywright` flag, which `initPlaywrightForAccount`
    // checks to short-circuit pending launches). Without this early
    // install, SIGINT falls through to Node's default handler, the
    // child Chromium processes die abruptly, and the in-flight
    // `initPlaywrightForAccount` promises reject with noisy
    // "Target page, context or browser has been closed" errors that
    // pollute the logs and can mask the real cause (Ctrl+C).
    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    cache = new MemoryCache();
    await cache.connect();

    if (!config.apiKey && config.server.host === "0.0.0.0") {
      const allowUnauthenticated =
        process.env.ALLOW_UNAUTHENTICATED === "true" ||
        process.env.TEST_MOCK_QWEN_AUTH === "true";
      const message =
        "API_KEY is empty and HOST is 0.0.0.0; the API is reachable without authentication.";
      if (process.env.NODE_ENV === "production" && !allowUnauthenticated) {
        throw new Error(
          `${message} Set API_KEY or explicitly set ALLOW_UNAUTHENTICATED=true.`,
        );
      }
      logger.warn(message);
    }

    const { loadAccounts, getAccountCredentials } =
      await import("../core/accounts.ts");
    const accounts = loadAccounts();

    // Clear stale cooldowns from previous sessions on startup
    const { clearAccountCooldown } = await import("../core/account-manager.ts");
    for (const account of accounts) {
      clearAccountCooldown(account.id);
    }
    if (accounts.length > 0) {
      console.log(
        `[Server] Cleared stale cooldowns for ${accounts.length} account(s).`,
      );
    }

    const { disableNativeTools, warmQwenChatPool } =
      await import("../services/qwen.ts");
    const { initPlaywrightForAccount, isPlaywrightClosing } =
      await import("../services/playwright.ts");

    const BATCH_SIZE = config.playwright.initBatchSize;

    if (accounts.length > 0) {
      console.log(
        `[Server] Preparing ${accounts.length} account(s) with Playwright (batch size: ${BATCH_SIZE})...`,
      );

      for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
        // Abort remaining batches if shutdown was requested (operator hit
        // Ctrl+C during the previous batch's `initPlaywrightForAccount`).
        if (isPlaywrightClosing()) {
          console.log(
            `[Server] Shutdown in progress — skipping remaining account batches (started at index ${i}).`,
          );
          break;
        }
        const batch = accounts.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(accounts.length / BATCH_SIZE);
        console.log(
          `[Server] Batch ${batchNum}/${totalBatches}: initializing ${batch.length} account(s)...`,
        );

        await Promise.all(
          batch.map(async (account: QwenAccount) => {
            // Per-account early bail-out: if shutdown started while this
            // batch was queued, skip the launch instead of producing
            // "Target page, context or browser has been closed" errors.
            if (isPlaywrightClosing()) return;
            return prepareQwenRuntime({
              accountId: account.id,
              successMessage: `[Server] Account ready (Playwright): ${maskEmail(account.email)}`,
              failureMessage: `[Server] Failed to initialize account ${maskEmail(account.email)}:`,
              initAuth: () => {
                const credentials = getAccountCredentials(account.id);
                if (!credentials) {
                  throw new Error(
                    `Account ${account.id} credentials not found`,
                  );
                }
                return initPlaywrightForAccount(
                  credentials,
                  config.playwright.headless,
                  config.playwright.browser,
                );
              },
              disableNativeTools,
              warmQwenChatPool,
            });
          }),
        );
      }
    } else {
      console.warn(
        "[Server] No Qwen accounts configured. Add accounts with npm run login before sending requests.",
      );
    }

    watchdog = new Watchdog();
    watchdog.start();

    metrics.startCollection();

    const { startSessionKeeper } =
      await import("../services/session-keeper.ts");
    startSessionKeeper();

    server = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });

    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    const started = buildStartedServerInfo();
    cli.ok("Server", `Listening on ${started.url}/v1`);
    cli.boot("Server", "Ready · OpenAI-compatible · /v1");
    return started;
  })();

  try {
    return await startPromise;
  } catch (error) {
    await cleanupServerResources().catch(() => {});
    throw error;
  } finally {
    startPromise = null;
  }
}

export { app };
