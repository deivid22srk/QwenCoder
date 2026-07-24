import type { ResponsesResponse } from "./types.ts";
import { getDatabase } from "../../core/database.ts";

// ============ State management for previous_response_id ============
//
// Dual store: in-memory Map (hot path) + SQLite (survives process restart).
// The Responses API supports stateful conversations via `previous_response_id`.
// Extra Qwen thread fields let the proxy resume parent_id without resending full history.

export interface StoredResponseMeta {
  sessionId?: string | null;
  logicalSessionId?: string | null;
  qwenChatId?: string | null;
  qwenParentId?: string | null;
  qwenAccountId?: string | null;
}

export interface StoredResponse extends StoredResponseMeta {
  response: ResponsesResponse;
  /** Full Chat Completions history for this response chain step (fallback) */
  chatMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | null | any[];
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  storedAt: number;
}

const store = new Map<string, StoredResponse>();
/** session_id → latest response_id */
const sessionLatest = new Map<string, string>();
const MAX_STORE_SIZE = 10000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isExpired(storedAt: number): boolean {
  return Date.now() - storedAt > MAX_AGE_MS;
}

function ensureMetaColumns(): void {
  try {
    const db = getDatabase();
    const cols = [
      "session_id TEXT",
      "logical_session_id TEXT",
      "qwen_chat_id TEXT",
      "qwen_parent_id TEXT",
      "qwen_account_id TEXT",
      "meta_json TEXT",
    ];
    for (const col of cols) {
      try {
        db.exec(`ALTER TABLE responses_store ADD COLUMN ${col};`);
      } catch {
        // column exists
      }
    }
    try {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_responses_store_session
         ON responses_store(session_id, stored_at DESC);`,
      );
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

let metaColumnsReady = false;
function ensureMetaReady(): void {
  if (metaColumnsReady) return;
  ensureMetaColumns();
  metaColumnsReady = true;
}

function persistToDb(responseId: string, entry: StoredResponse): void {
  ensureMetaReady();
  try {
    const db = getDatabase();
    const expiresAt = entry.storedAt + MAX_AGE_MS;
    const metaJson = JSON.stringify({
      sessionId: entry.sessionId ?? null,
      logicalSessionId: entry.logicalSessionId ?? null,
      qwenChatId: entry.qwenChatId ?? null,
      qwenParentId: entry.qwenParentId ?? null,
      qwenAccountId: entry.qwenAccountId ?? null,
    });
    db.prepare(
      `INSERT INTO responses_store (
         response_id, response_json, chat_messages_json, stored_at, expires_at,
         session_id, logical_session_id, qwen_chat_id, qwen_parent_id, qwen_account_id, meta_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(response_id) DO UPDATE SET
         response_json = excluded.response_json,
         chat_messages_json = excluded.chat_messages_json,
         stored_at = excluded.stored_at,
         expires_at = excluded.expires_at,
         session_id = excluded.session_id,
         logical_session_id = excluded.logical_session_id,
         qwen_chat_id = excluded.qwen_chat_id,
         qwen_parent_id = excluded.qwen_parent_id,
         qwen_account_id = excluded.qwen_account_id,
         meta_json = excluded.meta_json`,
    ).run(
      responseId,
      JSON.stringify(entry.response),
      JSON.stringify(entry.chatMessages),
      entry.storedAt,
      expiresAt,
      entry.sessionId ?? null,
      entry.logicalSessionId ?? null,
      entry.qwenChatId ?? null,
      entry.qwenParentId ?? null,
      entry.qwenAccountId ?? null,
      metaJson,
    );
  } catch (err) {
    // Non-fatal: memory store still works
    console.warn(
      `[Responses] Failed to persist response ${responseId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function loadFromDb(responseId: string): StoredResponse | null {
  ensureMetaReady();
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT response_json, chat_messages_json, stored_at, expires_at,
                session_id, logical_session_id, qwen_chat_id, qwen_parent_id,
                qwen_account_id, meta_json
         FROM responses_store WHERE response_id = ?`,
      )
      .get(responseId) as
      | {
          response_json: string;
          chat_messages_json: string;
          stored_at: number;
          expires_at: number;
          session_id?: string | null;
          logical_session_id?: string | null;
          qwen_chat_id?: string | null;
          qwen_parent_id?: string | null;
          qwen_account_id?: string | null;
          meta_json?: string | null;
        }
      | undefined;
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      db.prepare(`DELETE FROM responses_store WHERE response_id = ?`).run(
        responseId,
      );
      return null;
    }
    let meta: StoredResponseMeta = {};
    if (row.meta_json) {
      try {
        meta = JSON.parse(row.meta_json);
      } catch {
        meta = {};
      }
    }
    return {
      response: JSON.parse(row.response_json) as ResponsesResponse,
      chatMessages: JSON.parse(row.chat_messages_json),
      storedAt: row.stored_at,
      sessionId: row.session_id ?? meta.sessionId ?? null,
      logicalSessionId: row.logical_session_id ?? meta.logicalSessionId ?? null,
      qwenChatId: row.qwen_chat_id ?? meta.qwenChatId ?? null,
      qwenParentId: row.qwen_parent_id ?? meta.qwenParentId ?? null,
      qwenAccountId: row.qwen_account_id ?? meta.qwenAccountId ?? null,
    };
  } catch {
    return null;
  }
}

function deleteFromDb(responseId: string): void {
  try {
    getDatabase()
      .prepare(`DELETE FROM responses_store WHERE response_id = ?`)
      .run(responseId);
  } catch {
    // ignore
  }
}

/**
 * Store a completed response for future `previous_response_id` lookups.
 */
export function storeResponse(
  responseId: string,
  response: ResponsesResponse,
  chatMessages: StoredResponse["chatMessages"],
  meta?: StoredResponseMeta,
): void {
  if (store.size >= MAX_STORE_SIZE) {
    const oldest = [...store.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)
      .slice(0, Math.floor(MAX_STORE_SIZE * 0.1));
    for (const [key] of oldest) {
      store.delete(key);
      deleteFromDb(key);
    }
  }

  const entry: StoredResponse = {
    response,
    chatMessages,
    storedAt: Date.now(),
    sessionId: meta?.sessionId ?? null,
    logicalSessionId: meta?.logicalSessionId ?? null,
    qwenChatId: meta?.qwenChatId ?? null,
    qwenParentId: meta?.qwenParentId ?? null,
    qwenAccountId: meta?.qwenAccountId ?? null,
  };
  store.set(responseId, entry);

  const sessionKey = entry.sessionId || entry.logicalSessionId;
  if (sessionKey) {
    sessionLatest.set(sessionKey, responseId);
  }

  persistToDb(responseId, entry);
}

/**
 * Full stored entry (history + Qwen parent chain meta).
 */
export function getStoredEntry(
  previousResponseId: string,
): StoredResponse | null {
  let entry = store.get(previousResponseId);
  if (entry) {
    if (isExpired(entry.storedAt)) {
      store.delete(previousResponseId);
      deleteFromDb(previousResponseId);
      return null;
    }
    return entry;
  }

  entry = loadFromDb(previousResponseId) ?? undefined;
  if (!entry) return null;
  store.set(previousResponseId, entry);
  const sessionKey = entry.sessionId || entry.logicalSessionId;
  if (sessionKey) {
    sessionLatest.set(sessionKey, previousResponseId);
  }
  return entry;
}

/**
 * Retrieve stored history for a `previous_response_id`.
 */
export function getResponseHistory(
  previousResponseId: string,
): StoredResponse["chatMessages"] | null {
  const entry = getStoredEntry(previousResponseId);
  return entry ? entry.chatMessages : null;
}

/**
 * Latest response id for a session (proxy memory without full context).
 */
export function getLatestResponseIdForSession(
  sessionId: string,
): string | null {
  if (!sessionId) return null;
  const mem = sessionLatest.get(sessionId);
  if (mem && getStoredEntry(mem)) return mem;

  ensureMetaReady();
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT response_id FROM responses_store
         WHERE (session_id = ? OR logical_session_id = ?) AND expires_at > ?
         ORDER BY stored_at DESC LIMIT 1`,
      )
      .get(sessionId, sessionId, Date.now()) as
      | { response_id: string }
      | undefined;
    if (row?.response_id) {
      sessionLatest.set(sessionId, row.response_id);
      return row.response_id;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * True when entry has enough Qwen thread data to skip full history resend.
 */
export function canUseNativeQwenMemory(entry: StoredResponse | null): boolean {
  return !!(
    entry &&
    entry.qwenChatId &&
    entry.qwenParentId &&
    (entry.sessionId || entry.logicalSessionId)
  );
}

/**
 * Retrieve the full stored response (for GET /v1/responses/:id).
 */
export function getStoredResponse(
  responseId: string,
): ResponsesResponse | null {
  const entry = getStoredEntry(responseId);
  return entry ? entry.response : null;
}

export function deleteStoredResponse(responseId: string): boolean {
  const hadMem = store.delete(responseId);
  deleteFromDb(responseId);
  for (const [sid, rid] of sessionLatest) {
    if (rid === responseId) sessionLatest.delete(sid);
  }
  return hadMem || true;
}

export function hasResponse(previousResponseId: string): boolean {
  return getStoredResponse(previousResponseId) !== null;
}

export function getStoreSize(): number {
  return store.size;
}

export function clearStore(): void {
  store.clear();
  sessionLatest.clear();
  try {
    getDatabase().prepare(`DELETE FROM responses_store`).run();
  } catch {
    // ignore
  }
}

export function listStoredResponseIds(): string[] {
  const ids = new Set(store.keys());
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT response_id FROM responses_store WHERE expires_at > ?`,
      )
      .all(Date.now()) as Array<{ response_id: string }>;
    for (const r of rows) ids.add(r.response_id);
  } catch {
    // ignore
  }
  return [...ids];
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [key, value] of store) {
        if (now - value.storedAt > MAX_AGE_MS) {
          store.delete(key);
        }
      }
      try {
        getDatabase()
          .prepare(`DELETE FROM responses_store WHERE expires_at < ?`)
          .run(now);
      } catch {
        // ignore
      }
    },
    10 * 60 * 1000,
  );
  if (
    cleanupInterval &&
    typeof cleanupInterval === "object" &&
    "unref" in cleanupInterval
  ) {
    (cleanupInterval as NodeJS.Timeout).unref();
  }
}

export function stopPeriodicCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
