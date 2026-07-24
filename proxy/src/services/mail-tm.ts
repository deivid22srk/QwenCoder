/*
 * mail.tm temporary email API client
 * Docs: https://docs.mail.tm/
 * Site: https://mail.tm/pt/
 */

import crypto from "crypto";

const MAIL_TM_BASE = "https://api.mail.tm";

export interface MailTmAccount {
  id: string;
  address: string;
  password: string;
  token: string;
}

async function mailTmFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const headers: Record<string, string> = {
    accept: "application/ld+json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  // Only set Content-Type on requests with a body — GET + content-type breaks mail.tm.
  if (method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${MAIL_TM_BASE}${path}`, {
    ...init,
    headers,
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      (data as { detail?: string; message?: string; "hydra:description"?: string })
        ?.detail ||
      (data as { message?: string })?.message ||
      (data as { "hydra:description"?: string })?.["hydra:description"] ||
      text ||
      `HTTP ${res.status}`;
    throw new Error(`mail.tm ${path}: ${msg}`);
  }

  return data as T;
}

function hydraMembers<T>(data: unknown): T[] {
  if (!data) return [];
  // Some mail.tm responses return a bare array (especially with Accept: application/json).
  if (Array.isArray(data)) return data as T[];
  if (typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const members = obj["hydra:member"] ?? obj["member"];
  return Array.isArray(members) ? (members as T[]) : [];
}

/**
 * Pick an active domain from mail.tm
 */
export async function getMailTmDomain(): Promise<string> {
  // Prefer JSON-LD hydra collection; also accept bare array.
  let data: unknown;
  try {
    data = await mailTmFetch<unknown>("/domains?page=1");
  } catch {
    data = await mailTmFetch<unknown>("/domains");
  }

  const members = hydraMembers<{ domain: string; isActive?: boolean }>(data);
  const active = members.find((d) => d.isActive !== false) || members[0];
  if (!active?.domain) {
    // Last resort: parse domain from any object shape
    if (Array.isArray(data) && data[0]?.domain) {
      return String(data[0].domain);
    }
    throw new Error(
      `mail.tm: no domains available (shape: ${Array.isArray(data) ? "array" : typeof data})`,
    );
  }
  return active.domain;
}

function randomLocalPart(): string {
  const a = cryptoRandom(8);
  const b = Date.now().toString(36).slice(-4);
  return `qwen${a}${b}`.toLowerCase();
}

function cryptoRandom(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

/**
 * Create a disposable inbox on mail.tm and return address + JWT.
 */
export async function createMailTmInbox(): Promise<MailTmAccount> {
  const domain = await getMailTmDomain();
  const local = randomLocalPart();
  const address = `${local}@${domain}`;
  // mail.tm account password (inbox access), not the Qwen password
  const password = `Mt${cryptoRandom(12)}!`;

  const account = await mailTmFetch<{ id: string; address: string }>(
    "/accounts",
    {
      method: "POST",
      body: JSON.stringify({ address, password }),
    },
  );

  const tokenRes = await mailTmFetch<{ token: string }>("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });

  return {
    id: account.id,
    address: account.address || address,
    password,
    token: tokenRes.token,
  };
}

export interface MailTmMessage {
  id: string;
  subject?: string;
  from?: { address?: string; name?: string };
  intro?: string;
  text?: string;
  html?: string[];
}

/**
 * List messages in the temp inbox.
 */
export async function listMailTmMessages(
  token: string,
): Promise<MailTmMessage[]> {
  const data = await mailTmFetch<unknown>("/messages", {
    headers: { authorization: `Bearer ${token}` },
  });
  return hydraMembers<MailTmMessage>(data);
}

/**
 * Read a full message body.
 */
export async function getMailTmMessage(
  token: string,
  messageId: string,
): Promise<MailTmMessage> {
  return mailTmFetch<MailTmMessage>(`/messages/${messageId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Poll inbox until a message arrives (or timeout).
 */
export async function waitForMailTmMessage(
  token: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MailTmMessage | null> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const messages = await listMailTmMessages(token);
    if (messages.length > 0) {
      const full = await getMailTmMessage(token, messages[0].id);
      return full;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
