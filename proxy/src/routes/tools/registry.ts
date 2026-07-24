/**
 * Tool Registry — definição de ferramentas server-side que o proxy executa.
 *
 * Cada tool registra:
 *  - schema OpenAI (enviada ao modelo em `tools`)
 *  - handler async que recebe args + callback de progresso
 *
 * O proxy então:
 *  1. detecta tool_calls no stream do modelo
 *  2. emite SSE `tool_call.start` + `tool_call.args_delta`
 *  3. executa o handler local, emitindo `tool_call.execute.start`,
 *     `tool_call.execute.progress` (opcional) e `tool_call.execute.complete`
 *  4. adiciona mensagem `role: tool` ao contexto e re-envia ao modelo
 */

export interface ToolProgressUpdate {
  /** 0..100 opcional, para tools longas */
  percent?: number;
  /** mensagem de status livre */
  message: string;
  /** dados extras opcionais */
  data?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  toolCallId: string;
  /** Emite um evento de progresso durante a execução (SSE para o cliente) */
  emitProgress: (update: ToolProgressUpdate) => void;
  /** Account ID que está processando essa mensagem — pode ser usado para
   *  tools que precisam identificar qual conta gerou a request */
  accountId?: string;
  /** Request ID para correlação */
  requestId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Handler que executa a tool. Deve retornar uma string (JSON ou texto) */
  execute: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<string>;
}

// ---------- Built-in tools ----------

const getCurrentTime: ToolDefinition = {
  name: "get_current_time",
  description:
    "Retorna a data e hora atuais no servidor do proxy, em ISO-8601 e em formato amigável. Use para qualquer pergunta sobre 'que horas são' ou 'que dia é hoje'.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "Timezone opcional (ex: America/Sao_Paulo). Se omitido, usa o timezone do servidor.",
      },
    },
  },
  async execute(args, ctx) {
    ctx.emitProgress({ message: "Consultando relógio do servidor…" });
    const now = new Date();
    return JSON.stringify({
      iso8601: now.toISOString(),
      local_iso: now.toLocaleString("pt-BR"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_minutes: -now.getTimezoneOffset(),
      requested_timezone: (args.timezone as string) || null,
      server_note:
        "Data/hora vinda do servidor do proxy, não do device do cliente.",
    });
  },
};

const calculator: ToolDefinition = {
  name: "calculator",
  description:
    "Avalia uma expressão matemática simples (4 operações, parênteses, potência com ^, funções sqrt, sin, cos, tan, log, ln, abs). Use sempre que precisar de cálculo exato em vez de estimar.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: 'Expressão matemática, ex: "2*(3+4)^2 - sqrt(16)"',
      },
    },
    required: ["expression"],
  },
  async execute(args, ctx) {
    const expr = String(args.expression ?? "").trim();
    if (!expr) {
      return JSON.stringify({ error: "expression is required" });
    }
    ctx.emitProgress({
      message: `Avaliando: ${expr}`,
      percent: 10,
    });
    const allowed = /^[\d\s+\-*/().^,_a-zA-Z]+$/;
    if (!allowed.test(expr)) {
      return JSON.stringify({
        error: "invalid characters in expression",
        expression: expr,
      });
    }
    try {
      const result = safeEvalMath(expr);
      ctx.emitProgress({
        message: `Resultado: ${result}`,
        percent: 100,
      });
      return JSON.stringify({ expression: expr, result });
    } catch (e) {
      return JSON.stringify({
        error: (e as Error).message,
        expression: expr,
      });
    }
  },
};

const randomNumber: ToolDefinition = {
  name: "random_number",
  description:
    "Gera um número inteiro aleatório no intervalo [min, max] (inclusivos).",
  parameters: {
    type: "object",
    properties: {
      min: { type: "integer", default: 0 },
      max: { type: "integer", default: 100 },
    },
  },
  async execute(args, ctx) {
    const min = Number(args.min ?? 0);
    const max = Number(args.max ?? 100);
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      return JSON.stringify({ error: "min and max must be integers" });
    }
    if (min > max) {
      return JSON.stringify({ error: "min > max", min, max });
    }
    ctx.emitProgress({ message: `Sorteando entre ${min} e ${max}…` });
    const value = min + Math.floor(Math.random() * (max - min + 1));
    return JSON.stringify({ min, max, value });
  },
};

const listAccounts: ToolDefinition = {
  name: "list_qwen_accounts",
  description:
    "Lista as contas Qwen configuradas no proxy (sem expor senhas). Mostra status e cooldown. Use quando o usuário perguntar quantas contas existem ou qual está ativa.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.emitProgress({ message: "Lendo contas do banco do proxy…" });
    const { listAccounts } = await import("../../core/accounts.ts");
    const { getCooldownStatus } = await import(
      "../../core/account-manager.ts"
    );
    const accounts = listAccounts();
    const cooldowns = getCooldownStatus() as Record<string, unknown>;
    const enriched = accounts.map((a) => {
      const cdInfo = (cooldowns[a.id] || {}) as Record<string, unknown>;
      return {
        id: a.id,
        email: a.email,
        cooldown_until: a.cooldown_until ?? null,
        cooldown_reason: a.cooldown_reason ?? null,
        cooldown_info: cdInfo,
      };
    });
    return JSON.stringify({
      total: enriched.length,
      active: enriched.filter((a) => !a.cooldown_until).length,
      in_cooldown: enriched.filter((a) => a.cooldown_until).length,
      accounts: enriched,
    });
  },
};

const httpRequest: ToolDefinition = {
  name: "http_request",
  description:
    "Faz uma requisição HTTP simples (GET/POST) a uma URL pública. Útil para consultar APIs externas. O proxy executa a request — o cliente não precisa de internet direta.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL completa, ex: https://api.github.com/repos/deivid22srk/QwenCoder" },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE"],
        default: "GET",
      },
      headers: {
        type: "object",
        description: "Headers opcionais (chave-valor)",
      },
      body: {
        type: "string",
        description: "Corpo da requisição para POST/PUT (string)",
      },
      timeout_ms: { type: "integer", default: 10000 },
    },
    required: ["url"],
  },
  async execute(args, ctx) {
    const url = String(args.url ?? "");
    const method = String(args.method ?? "GET").toUpperCase();
    const timeoutMs = Number(args.timeout_ms ?? 10000);
    if (!url) return JSON.stringify({ error: "url is required" });
    ctx.emitProgress({ message: `${method} ${url}…`, percent: 10 });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, {
        method,
        headers: (args.headers as Record<string, string>) || undefined,
        body: method === "GET" || method === "DELETE" ? undefined : String(args.body ?? ""),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await resp.text();
      ctx.emitProgress({
        message: `HTTP ${resp.status} · ${text.length} bytes`,
        percent: 100,
      });
      // Trunca resposta muito longa
      const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n…[truncated]" : text;
      return JSON.stringify({
        status: resp.status,
        status_text: resp.statusText,
        content_type: resp.headers.get("content-type"),
        body: truncated,
      });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message, url, method });
    }
  },
};

// ---------- Registry ----------

const REGISTRY: ToolDefinition[] = [
  getCurrentTime,
  calculator,
  randomNumber,
  listAccounts,
  httpRequest,
];

export function listToolDefinitions(): ToolDefinition[] {
  return REGISTRY;
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return REGISTRY.find((t) => t.name === name);
}

/** Retorna o schema OpenAI tools[] para enviar ao modelo. */
export function buildOpenAiToolsArray(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return REGISTRY.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ---------- Safe math evaluator (sem eval) ----------

function safeEvalMath(expr: string): number {
  const normalized = expr.replace(/\^/g, "**").replace(/,/g, ".");
  const tokens = tokenize(normalized);
  const parser = new MathParser(tokens);
  const value = parser.parseExpression();
  if (!parser.atEnd) throw new Error(`Unexpected token at position ${parser.pos}`);
  return value;
}

type TokType = "number" | "ident" | "op";
interface Token {
  type: TokType;
  value: string;
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  const numberRe = /\d+(\.\d+)?/;
  const identRe = /[a-zA-Z_]+/;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if ("+-*/()".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
    } else if (c === "*" && i + 1 < s.length && s[i + 1] === "*") {
      tokens.push({ type: "op", value: "^" });
      i += 2;
    } else if (numberRe.test(s.slice(i))) {
      const m = numberRe.exec(s.slice(i))!;
      tokens.push({ type: "number", value: m[0] });
      i += m[0].length;
    } else if (identRe.test(s.slice(i))) {
      const m = identRe.exec(s.slice(i))!;
      tokens.push({ type: "ident", value: m[0] });
      i += m[0].length;
    } else {
      throw new Error(`Invalid char "${c}" at ${i}`);
    }
  }
  return tokens;
}

class MathParser {
  pos = 0;
  constructor(private tokens: Token[]) {}

  get atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
  get peek(): Token | undefined {
    return this.atEnd ? undefined : this.tokens[this.pos];
  }

  parseExpression(): number {
    let v = this.parseTerm();
    while (this.peek?.type === "op" && (this.peek.value === "+" || this.peek.value === "-")) {
      const op = this.tokens[this.pos++].value;
      const r = this.parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  parseTerm(): number {
    let v = this.parseFactor();
    while (this.peek?.type === "op" && (this.peek.value === "*" || this.peek.value === "/")) {
      const op = this.tokens[this.pos++].value;
      const r = this.parseFactor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }

  parseFactor(): number {
    let v = this.parseUnary();
    while (this.peek?.type === "op" && this.peek.value === "^") {
      this.pos++;
      const r = this.parseUnary();
      v = Math.pow(v, r);
    }
    return v;
  }

  parseUnary(): number {
    if (this.peek?.type === "op" && this.peek.value === "-") {
      this.pos++;
      return -this.parseUnary();
    }
    if (this.peek?.type === "op" && this.peek.value === "+") {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  parsePrimary(): number {
    const t = this.peek;
    if (!t) throw new Error("Unexpected end");
    if (t.type === "number") {
      this.pos++;
      return parseFloat(t.value);
    }
    if (t.type === "op" && t.value === "(") {
      this.pos++;
      const v = this.parseExpression();
      if (this.peek?.value !== ")") throw new Error("Expected )");
      this.pos++;
      return v;
    }
    if (t.type === "ident") {
      this.pos++;
      if (this.peek?.value === "(") {
        this.pos++;
        const arg = this.parseExpression();
        if (this.peek?.value !== ")") throw new Error("Expected ) after function arg");
        this.pos++;
        return this.applyFunction(t.value, arg);
      }
      switch (t.value) {
        case "pi": return Math.PI;
        case "e": return Math.E;
        default: throw new Error(`Unknown identifier ${t.value}`);
      }
    }
    throw new Error(`Unexpected token ${t.value}`);
  }

  applyFunction(name: string, arg: number): number {
    switch (name) {
      case "sqrt": return Math.sqrt(arg);
      case "sin": return Math.sin(arg);
      case "cos": return Math.cos(arg);
      case "tan": return Math.tan(arg);
      case "log": return Math.log10(arg);
      case "ln": return Math.log(arg);
      case "abs": return Math.abs(arg);
      default: throw new Error(`Unknown function ${name}`);
    }
  }
}
