/**
 * Rotas REST para gerenciamento de contas Qwen no proxy.
 * Permite que o app Android (QwenCoder) adicione/remova/liste contas em runtime.
 *
 * Endpoints:
 *   GET    /v1/accounts            — lista contas (sem senhas)
 *   POST   /v1/accounts            — adiciona uma ou várias contas (batch)
 *   DELETE /v1/accounts/:id        — remove conta
 *   PATCH  /v1/accounts/:id        — atualiza (apenas 'enabled' / 'label')
 *   GET    /v1/accounts/status     — status detalhado (cooldowns, métricas)
 *   POST   /v1/accounts/:id/warmup — força re-init de uma conta via Playwright
 *   GET    /v1/accounts/stream     — SSE com mudanças de status em tempo real
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  addAccount,
  listAccounts,
  removeAccount,
  invalidateAccountsCache,
} from "../../core/accounts.ts";
import { getCooldownStatus, clearAccountCooldown } from "../../core/account-manager.ts";
import { logger } from "../../core/logger.ts";

export const accountsApp = new Hono();

interface AccountPublicDto {
  id: string;
  email: string;
  enabled: boolean;
  cooldown_until: number | null;
  cooldown_reason: string | null;
  cooldown_remaining_ms: number | null;
  in_cooldown: boolean;
}

function toDto(account: {
  id: string;
  email: string;
  cooldown_until?: number;
  cooldown_reason?: string | null;
}): AccountPublicDto {
  const now = Date.now();
  const cdUntil = account.cooldown_until ?? null;
  const inCd = cdUntil !== null && cdUntil > now;
  return {
    id: account.id,
    email: account.email,
    enabled: true, // o proxy não persiste 'enabled' ainda — sempre true
    cooldown_until: cdUntil,
    cooldown_reason: account.cooldown_reason ?? null,
    cooldown_remaining_ms: inCd ? cdUntil! - now : null,
    in_cooldown: inCd,
  };
}

// GET /v1/accounts — lista contas (sem senhas)
accountsApp.get("/", (c) => {
  const accounts = listAccounts();
  const dtos = accounts.map(toDto);
  return c.json({
    total: dtos.length,
    active: dtos.filter((a) => !a.in_cooldown).length,
    in_cooldown: dtos.filter((a) => a.in_cooldown).length,
    accounts: dtos,
  });
});

// GET /v1/accounts/status — status detalhado (inclui cooldowns do account-manager)
accountsApp.get("/status", (c) => {
  const accounts = listAccounts();
  const cooldowns = getCooldownStatus() as Record<string, unknown>;
  const now = Date.now();
  const status = accounts.map((a) => {
    const cdInfo = (cooldowns[a.id] || {}) as Record<string, unknown>;
    const cdUntil = (cdInfo.cooldownUntil as number | undefined) ?? a.cooldown_until ?? null;
    return {
      id: a.id,
      email: a.email,
      cooldown_until: cdUntil,
      cooldown_reason: (cdInfo.cooldownReason as string | undefined) ?? a.cooldown_reason ?? null,
      in_cooldown: cdUntil !== null && cdUntil > now,
      cooldown_remaining_ms: cdUntil !== null && cdUntil > now ? cdUntil - now : null,
    };
  });
  return c.json({ status, generated_at: now });
});

// POST /v1/accounts — adiciona uma ou várias contas
// Body: { "accounts": [{ "email": "...", "password": "..." }] }
//   OU  { "email": "...", "password": "..." }  (single)
//   OU  { "wire": "email1:pass1;email2:pass2" }  (formato QWEN_ACCOUNTS)
accountsApp.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const toAdd: Array<{ email: string; password: string }> = [];

  if (Array.isArray(body.accounts)) {
    for (const item of body.accounts as unknown[]) {
      const r = item as Record<string, unknown>;
      const email = String(r.email ?? "").trim();
      const password = String(r.password ?? "");
      if (email && password) toAdd.push({ email, password });
    }
  } else if (typeof body.email === "string" && typeof body.password === "string") {
    toAdd.push({ email: body.email.trim(), password: body.password });
  } else if (typeof body.wire === "string") {
    // Parser tolerante para QWEN_ACCOUNTS=email:pass;email:pass
    const parts = body.wire.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const colonIdx = part.indexOf(":");
      if (colonIdx === -1) continue;
      const email = part.substring(0, colonIdx).trim();
      const password = part.substring(colonIdx + 1).trim();
      if (email && password) toAdd.push({ email, password });
    }
  } else {
    return c.json(
      {
        error:
          "Body must be { email, password } or { accounts: [...] } or { wire: 'email:pass;...' }",
      },
      400,
    );
  }

  if (toAdd.length === 0) {
    return c.json({ error: "No valid accounts provided" }, 400);
  }

  const results: Array<{
    email: string;
    status: "ok" | "skip" | "fail";
    id?: string;
    error?: string;
  }> = [];

  for (const { email, password } of toAdd) {
    try {
      const acc = addAccount(email, password);
      results.push({ email, status: "ok", id: acc.id });
      logger.info("Accounts API", `Added account ${email}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("already exists")) {
        results.push({ email, status: "skip", error: msg });
      } else {
        results.push({ email, status: "fail", error: msg });
      }
    }
  }

  invalidateAccountsCache();

  return c.json({
    added: results.filter((r) => r.status === "ok").length,
    skipped: results.filter((r) => r.status === "skip").length,
    failed: results.filter((r) => r.status === "fail").length,
    results,
  }, 201);
});

// DELETE /v1/accounts/:id — remove conta
accountsApp.delete("/:id", (c) => {
  const id = c.req.param("id");
  const removed = removeAccount(id);
  if (!removed) {
    return c.json({ error: "Account not found", id }, 404);
  }
  invalidateAccountsCache();
  logger.info("Accounts API", `Removed account ${id}`);
  return c.json({ ok: true, id });
});

// PATCH /v1/accounts/:id — atualiza (atualmente apenas limpa cooldown)
// Body: { "action": "clear_cooldown" } | { "action": "warmup" }
accountsApp.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");

  const accounts = listAccounts();
  if (!accounts.find((a) => a.id === id)) {
    return c.json({ error: "Account not found", id }, 404);
  }

  if (action === "clear_cooldown") {
    clearAccountCooldown(id);
    logger.info("Accounts API", `Cleared cooldown for ${id}`);
    return c.json({ ok: true, id, action });
  }

  if (action === "warmup") {
    // Inicia init via Playwright em background
    (async () => {
      try {
        const { getAccountCredentials } = await import("../../core/accounts.ts");
        const { initPlaywrightForAccount } = await import(
          "../../services/playwright.ts"
        );
        const { disableNativeTools, warmQwenChatPool } = await import(
          "../../services/qwen.ts"
        );
        const { config } = await import("../../core/config.ts");
        const creds = getAccountCredentials(id);
        if (!creds) throw new Error("Credentials not found");
        await initPlaywrightForAccount(
          creds,
          config.playwright.headless,
          config.playwright.browser,
        );
        await disableNativeTools(id).catch(() => {});
        await warmQwenChatPool(id, "qwen3-coder-plus").catch(() => {});
        logger.info("Accounts API", `Warmup completed for ${creds.email}`);
      } catch (e) {
        logger.error("Accounts API", `Warmup failed for ${id}: ${(e as Error).message}`);
      }
    })();
    return c.json({ ok: true, id, action, message: "Warmup started in background" });
  }

  return c.json({ error: `Unknown action: ${action}` }, 400);
});

// GET /v1/accounts/stream — SSE com mudanças de status em tempo real
accountsApp.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    // Envia snapshot inicial
    const accounts = listAccounts();
    const cooldowns = getCooldownStatus() as Record<string, unknown>;
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({
        accounts: accounts.map(toDto),
        cooldowns,
        timestamp: Date.now(),
      }),
    });

    // Heartbeat a cada 10s para manter conexão viva + emitir status atualizado
    let heartbeat = 0;
    const interval = setInterval(async () => {
      heartbeat++;
      try {
        const accs = listAccounts();
        const cds = getCooldownStatus() as Record<string, unknown>;
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({
            accounts: accs.map(toDto),
            cooldowns: cds,
            heartbeat,
            timestamp: Date.now(),
          }),
        });
      } catch (e) {
        // Conexao fechada — clearInterval abaixo via abort
      }
    }, 10_000);

    // Mantém a conexão aberta até o cliente desconectar
    try {
      // Aguarda evento de abort do stream
      // Hono fornece stream.aborted (AbortSignal)
      await new Promise<void>((resolve) => {
        if (stream.aborted) return resolve();
        stream.addEventListener("abort", () => resolve());
      });
    } finally {
      clearInterval(interval);
    }
  });
});
