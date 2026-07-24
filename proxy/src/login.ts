import {
  addAccount,
  removeAccount,
  listAccounts,
  type QwenAccount,
} from "./core/accounts.ts";

import { maskEmail } from "./core/logger.ts";
import {
  PURPLE,
  PURPLE_BRIGHT,
  PURPLE_LIGHT,
  PURPLE_DIM,
  PURPLE_MUTED,
  PURPLE_VIVID,
  BOLD,
  clearTerminal,
  paint,
} from "./core/ansi.ts";
import { createQwenAccountAuto } from "./services/account-register.ts";
import * as readline from "readline";
import * as dotenv from "dotenv";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const MAX_CREATE_PER_TURN = 50;

function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function p(text: string, ...codes: string[]) {
  return paint(text, ...codes);
}

function line(ch = "─", n = 46) {
  return p(ch.repeat(n), PURPLE_DIM);
}

function header(title: string) {
  console.log();
  console.log(p("  ▸ " + title, BOLD, PURPLE_BRIGHT));
  console.log(p("  " + line(), PURPLE_DIM));
}

function mute(s: string) {
  return p(s, PURPLE_MUTED);
}

function ok(s: string) {
  return p(s, PURPLE_LIGHT);
}

function err(s: string) {
  return p(s, PURPLE_VIVID);
}

function askPurple(prompt: string): Promise<string> {
  return askQuestion(p(prompt, PURPLE));
}

/** Drop noisy service spam; keep only account-manager UI lines. */
function silenceNoisyServiceLogs() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const re =
    /^\[(Register|RegisterHTTP|WafAssist|PuzzleSolver|EmailVerify|AutoCreate)/;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && re.test(args[0])) return;
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && re.test(args[0])) return;
    origWarn(...args);
  };
  return () => {
    console.log = origLog;
    console.warn = origWarn;
  };
}

function printMenuBanner(accountCount: number) {
  clearTerminal();
  console.log();
  console.log(p("  ╔════════════════════════════════════════════╗", PURPLE_DIM));
  console.log(
    p("  ║", PURPLE_DIM) +
      p("   QwenBridge  ·  Account Manager", BOLD, PURPLE_BRIGHT) +
      p("      ║", PURPLE_DIM),
  );
  console.log(p("  ╚════════════════════════════════════════════╝", PURPLE_DIM));
  console.log(mute(`  accounts · ${accountCount}  ·  playwright auth`));
  console.log();
}

async function showMenu() {
  while (true) {
    const accounts = listAccounts();
    printMenuBanner(accounts.length);

    if (accounts.length > 0) {
      console.log(p("  contas", PURPLE_MUTED));
      for (let i = 0; i < accounts.length; i++) {
        console.log(
          p(`    ${String(i + 1).padStart(2, " ")}  `, PURPLE_DIM) +
            p(maskEmail(accounts[i].email), PURPLE_LIGHT) +
            mute(`  ${accounts[i].id.slice(0, 8)}`),
        );
      }
      console.log();
    } else {
      console.log(mute("  nenhuma conta ainda\n"));
    }

    console.log(p("  opções", PURPLE_MUTED));
    console.log(
      p("    [A]", PURPLE_BRIGHT) + p("  adicionar conta existente", PURPLE),
    );
    console.log(
      p("    [B]", PURPLE_BRIGHT) +
        p("  adicionar várias contas em lote", PURPLE) +
        mute("  · email/senha por linha"),
    );
    console.log(
      p("    [C]", PURPLE_BRIGHT) +
        p("  criar contas", PURPLE) +
        mute("  · 1–50 / turno"),
    );
    if (accounts.length > 0) {
      console.log(
        p("    [R]", PURPLE_BRIGHT) + p("  remover conta", PURPLE),
      );
    }
    console.log(p("    [Q]", PURPLE_BRIGHT) + p("  sair", PURPLE));
    console.log();

    const choice = (await askPurple("  › ")).toUpperCase();

    if (choice === "Q") {
      rl.close();
      process.exit(0);
    }
    if (choice === "A") {
      await addAccountFlow();
      continue;
    }
    if (choice === "B") {
      await addBatchAccountsFlow();
      continue;
    }
    if (choice === "C") {
      await createAccountFlow();
      continue;
    }
    if (choice === "R" && accounts.length > 0) {
      await removeAccountFlow();
      continue;
    }
  }
}

async function addAccountFlow() {
  clearTerminal();
  header("Adicionar conta");
  console.log(mute("  Use se a conta Qwen já existe.\n"));

  const email = await askPurple("  email  › ");
  if (!email) {
    console.log(err("  email obrigatório"));
    await askPurple("  enter… ");
    return;
  }
  const password = await askPurple("  senha  › ");
  if (!password) {
    console.log(err("  senha obrigatória"));
    await askPurple("  enter… ");
    return;
  }

  let account: QwenAccount | null = null;
  try {
    account = addAccount(email, password);
    console.log(
      ok(`\n  + ${maskEmail(account.email)}`) + mute(`  ${account.id}`),
    );
  } catch (e: any) {
    if (account) removeAccount(account.id);
    console.log(err(`\n  ${e.message}`));
  }
  await askPurple("\n  enter… ");
}

/**
 * Parse a free-form paste of accounts into a list of {email, password} pairs.
 *
 * Accepted formats (any of these will work, mixed):
 *
 *   1. One account per pair of lines (most common when pasting from a sheet):
 *        user1@gmail.com
 *        senha1
 *
 *        user2@gmail.com
 *        senha2
 *
 *   2. `email:password` per line (single or multiple lines):
 *        user1@gmail.com:senha1
 *        user2@gmail.com:senha2
 *
 *   3. `email password` separated by whitespace/tab:
 *        user1@gmail.com senha1
 *        user2@gmail.com senha2
 *
 *   4. The env-style format with `;` or `,` separators:
 *        user1@gmail.com:senha1;user2@gmail.com:senha2
 *
 * Blank lines are ignored. Lines starting with `#` are treated as comments.
 * Email validation is intentionally lenient (anything containing `@`), so the
 * batch keeps going even if one entry is malformed — the offending entry is
 * skipped and reported in the summary.
 */
function parseBatchAccounts(raw: string): Array<{
  email: string;
  password: string;
  raw: string;
}> {
  const out: Array<{ email: string; password: string; raw: string }> = [];
  if (!raw) return out;

  // 1) Try the env-style single-line format first (contains `;` or `,` with `:`).
  //    If the entire paste is a single non-empty line, attempt to split it.
  const trimmed = raw.trim();
  const singleLine = trimmed.includes("\n") === false;
  if (singleLine && (trimmed.includes(";") || trimmed.includes(","))) {
    const sep = trimmed.includes(";") ? ";" : ",";
    for (const piece of trimmed.split(sep)) {
      const entry = piece.trim();
      if (!entry || entry.startsWith("#")) continue;
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) continue;
      const email = entry.substring(0, colonIdx).trim();
      const password = entry.substring(colonIdx + 1).trim();
      if (email && password && email.includes("@")) {
        out.push({ email, password, raw: entry });
      }
    }
    if (out.length > 0) return out;
  }

  // 2) Walk the lines and group "email" + "password" pairs.
  //    A line is considered an "email" if it contains `@` and has no spaces
  //    (or it contains `:` / whitespace-separated password after it).
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Format 2: `email:password` on a single line
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && line.slice(0, colonIdx).includes("@")) {
      const email = line.slice(0, colonIdx).trim();
      const password = line.slice(colonIdx + 1).trim();
      if (email && password) {
        out.push({ email, password, raw: line });
        i++;
        continue;
      }
    }

    // Format 3: `email<space>password` on a single line
    const spaceIdx = line.search(/\s+/);
    if (spaceIdx > 0 && line.slice(0, spaceIdx).includes("@")) {
      const email = line.slice(0, spaceIdx).trim();
      const password = line.slice(spaceIdx + 1).trim();
      if (email && password) {
        out.push({ email, password, raw: line });
        i++;
        continue;
      }
    }

    // Format 1: email on one line, password on the next
    if (line.includes("@") && i + 1 < lines.length) {
      const email = line;
      const password = lines[i + 1];
      // Only treat the next line as a password if it does NOT look like an
      // email itself (avoids eating the next account's email as a password).
      if (password && !password.includes("@")) {
        out.push({ email, password, raw: `${email}\n${password}` });
        i += 2;
        continue;
      }
    }

    // Could not parse this line — skip it
    i++;
  }

  return out;
}

async function addBatchAccountsFlow() {
  clearTerminal();
  header("Adicionar várias contas");
  console.log(
    mute("  Cole as contas abaixo. Aceita os formatos:\n") +
      mute("    · email na linha 1, senha na linha 2 (uma conta por par)\n") +
      mute("    · email:senha (uma conta por linha)\n") +
      mute("    · email senha  (separados por espaço)\n") +
      mute("    · user1@x.com:pwd1;user2@x.com:pwd2  (formato .env)\n") +
      mute("  Linhas em branco são ignoradas. Linhas com # são comentários.\n"),
  );
  console.log(
    p("  › ", PURPLE) +
      mute("cole as contas e pressione Enter duas vezes para finalizar") +
      "\n",
  );

  // Read multiple lines until the user enters an empty line twice in a row
  // (or a sentinel like `END` / `DONE`).
  const lines: string[] = [];
  let emptyStreak = 0;
  while (true) {
    const line = await askPurple("  │ ");
    if (line === "" ) {
      emptyStreak++;
      if (emptyStreak >= 2 && lines.length > 0) break;
      // allow up to one blank line between accounts (format 1 uses blank
      // lines between pairs); keep collecting.
      if (lines.length === 0) {
        // nothing typed yet and the user just pressed enter — bail out.
        console.log(mute("  cancelado"));
        await askPurple("  enter… ");
        return;
      }
      lines.push("");
      continue;
    }
    emptyStreak = 0;
    if (line.toUpperCase() === "END" || line.toUpperCase() === "DONE") break;
    lines.push(line);
  }

  const raw = lines.join("\n");
  const parsed = parseBatchAccounts(raw);

  if (parsed.length === 0) {
    console.log(err("  nenhuma conta válida encontrada no texto colado"));
    await askPurple("  enter… ");
    return;
  }

  console.log();
  console.log(
    p(`  ${parsed.length} conta(s) detectada(s)`, PURPLE_LIGHT) +
      mute("  · confirmando importação…"),
  );
  const confirm = await askPurple("  confirmar? (y/N)  › ");
  if (confirm.toLowerCase() !== "y") {
    console.log(mute("  cancelado"));
    await askPurple("  enter… ");
    return;
  }

  console.log();
  console.log(line());

  let okN = 0;
  let skipN = 0;
  let failN = 0;
  const added: { email: string; id: string }[] = [];
  const skipped: { email: string; reason: string }[] = [];
  const failed: { raw: string; reason: string }[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const { email, password, raw: rawEntry } = parsed[i];
    const tag = p(`[${i + 1}/${parsed.length}]`, PURPLE_DIM);
    try {
      const account = addAccount(email, password);
      okN++;
      added.push({ email: account.email, id: account.id });
      console.log(
        p(`  ${tag} `, PURPLE) +
          ok("  ok") +
          "  " +
          p(maskEmail(account.email), PURPLE_LIGHT) +
          mute(`  ${account.id.slice(0, 8)}`),
      );
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.toLowerCase().includes("already exists")) {
        skipN++;
        skipped.push({ email, reason: "já existe" });
        console.log(
          p(`  ${tag} `, PURPLE) +
            mute("  skip") +
            "  " +
            p(maskEmail(email), PURPLE_MUTED) +
            mute("  já existe"),
        );
      } else {
        failN++;
        failed.push({ raw: rawEntry, reason: msg });
        console.log(
          p(`  ${tag} `, PURPLE) +
            err("  erro") +
            "  " +
            p(maskEmail(email) || rawEntry.slice(0, 40), PURPLE_VIVID) +
            mute(`  ${msg}`),
        );
      }
    }
  }

  console.log(line());
  console.log(
    mute("  total ") +
      p(String(parsed.length), PURPLE_LIGHT) +
      mute("   ok ") +
      ok(String(okN)) +
      mute("   skip ") +
      p(String(skipN), PURPLE_MUTED) +
      mute("   fail ") +
      err(String(failN)),
  );

  if (added.length > 0) {
    console.log();
    console.log(mute("  adicionadas"));
    for (const a of added) {
      console.log(
        p("    · ", PURPLE_DIM) +
          p(maskEmail(a.email), PURPLE_LIGHT) +
          mute(`  ${a.id.slice(0, 8)}`),
      );
    }
  }
  if (skipped.length > 0) {
    console.log();
    console.log(mute("  ignoradas (já existiam)"));
    for (const s of skipped) {
      console.log(
        p("    · ", PURPLE_DIM) + p(maskEmail(s.email), PURPLE_MUTED),
      );
    }
  }
  console.log();
  await askPurple("  enter… ");
}

/**
 * Create 1–50 accounts with purple UI + quiet service logs.
 */
async function createAccountFlow() {
  clearTerminal();
  header("Criar contas");
  console.log(mute("  mail.tm · captcha · ativar e-mail · provar login"));
  console.log(
    mute(
      `  máx ${MAX_CREATE_PER_TURN}/turno  ·  ~1 min/conta  ·  auto-create se o pool morrer`,
    ),
  );
  console.log();

  const raw = await askPurple(
    `  quantas? (1–${MAX_CREATE_PER_TURN}) [1]  › `,
  );
  let count = raw === "" ? 1 : parseInt(raw, 10);
  if (!Number.isFinite(count) || count < 1) {
    console.log(err("  número inválido"));
    await askPurple("  enter… ");
    return;
  }
  if (count > MAX_CREATE_PER_TURN) {
    console.log(mute(`  cap ${MAX_CREATE_PER_TURN}`));
    count = MAX_CREATE_PER_TURN;
  }

  console.log(
    p(`\n  ${count} conta(s)`, PURPLE_LIGHT) +
      mute(`  · estimativa ~${count} min`),
  );
  const confirm = await askPurple("  confirmar? (y/N)  › ");
  if (confirm.toLowerCase() !== "y") {
    console.log(mute("  cancelado"));
    await askPurple("  enter… ");
    return;
  }

  process.env.REGISTER_QUIET = "1";
  process.env.SOLVER_HUMAN_SLIDER_TRAVEL =
    process.env.SOLVER_HUMAN_SLIDER_TRAVEL ?? "0";
  const restoreLogs = silenceNoisyServiceLogs();

  const batchT0 = Date.now();
  let okN = 0;
  let failN = 0;
  const created: {
    email: string;
    password: string;
    username: string;
    s: number;
  }[] = [];

  console.log();
  console.log(line());

  try {
    for (let i = 1; i <= count; i++) {
      const tag = p(`[${i}/${count}]`, PURPLE_DIM);
      process.stdout.write(
        p(`  ${tag} `, PURPLE) + mute("criando…"),
      );

      const oneT0 = Date.now();
      let account: QwenAccount | null = null;

      try {
        const result = await createQwenAccountAuto();
        const creds = result.credentials;
        const sec = Number(((Date.now() - oneT0) / 1000).toFixed(1));

        // clear "criando…" line
        process.stdout.write("\r" + " ".repeat(60) + "\r");

        if (!result.success || !creds) {
          failN++;
          console.log(
            p(`  [${i}/${count}]`, PURPLE_DIM) +
              err("  fail") +
              mute(`  ${sec}s  ${result.error || "?"}`),
          );
          if (i < count) await sleep(20_000);
          continue;
        }

        try {
          account = addAccount(creds.email, creds.password);
        } catch (e: any) {
          if (
            String(e?.message || "")
              .toLowerCase()
              .includes("already exists")
          ) {
            okN++;
            created.push({
              email: creds.email,
              password: creds.password,
              username: creds.username,
              s: sec,
            });
            console.log(
              p(`  [${i}/${count}]`, PURPLE_DIM) +
                ok("  ok") +
                mute(`  já no db  ${sec}s`),
            );
            console.log(mute(`         ${creds.email}`));
            continue;
          }
          throw e;
        }

        okN++;
        created.push({
          email: creds.email,
          password: creds.password,
          username: creds.username,
          s: sec,
        });

        const mail = result.emailVerified ? "mail✓" : "mail…";
        console.log(
          p(`  [${i}/${count}]`, PURPLE_DIM) +
            ok("  ok") +
            p(`  ${sec}s`, PURPLE_LIGHT) +
            mute(`  ${mail}  ${result.method || ""}`),
        );
        console.log(
          p("         ", PURPLE_DIM) +
            p(creds.email, PURPLE_LIGHT) +
            mute(`  ${creds.password}`),
        );
        // Aliyun-safe spacing (seq only; never parallel captcha)
        if (i < count) await sleep(10_000);
      } catch (e: any) {
        failN++;
        if (account) removeAccount(account.id);
        process.stdout.write("\r" + " ".repeat(60) + "\r");
        console.log(
          p(`  [${i}/${count}]`, PURPLE_DIM) +
            err("  erro") +
            mute(`  ${e?.message || e}`),
        );
        if (i < count) await sleep(20_000);
      }
    }
  } finally {
    restoreLogs();
    delete process.env.REGISTER_QUIET;
  }

  const totalS = ((Date.now() - batchT0) / 1000).toFixed(1);
  console.log(line());
  header("Resumo");
  console.log(
    mute("  pedidas ") +
      p(String(count), PURPLE_LIGHT) +
      mute("   ok ") +
      ok(String(okN)) +
      mute("   fail ") +
      err(String(failN)) +
      mute("   tempo ") +
      p(`${totalS}s`, PURPLE_LIGHT),
  );

  if (created.length > 0) {
    console.log();
    console.log(mute("  salvas"));
    for (const c of created) {
      console.log(
        p("    · ", PURPLE_DIM) +
          p(c.username, PURPLE) +
          mute(`  ${c.email}  ${c.password}  ${c.s}s`),
      );
    }
  }
  console.log();
  await askPurple("  enter… ");
}

async function removeAccountFlow() {
  const accounts = listAccounts();
  if (accounts.length === 0) return;

  clearTerminal();
  header("Remover conta");
  for (let i = 0; i < accounts.length; i++) {
    console.log(
      p(`    ${i + 1}  `, PURPLE_DIM) +
        p(maskEmail(accounts[i].email), PURPLE_LIGHT),
    );
  }

  const input = await askPurple("\n  nº (0 cancela)  › ");
  const idx = parseInt(input) - 1;
  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(mute(input !== "0" ? "  inválido" : "  cancelado"));
    await askPurple("  enter… ");
    return;
  }

  const account = accounts[idx];
  const confirm = await askPurple(
    `  remover ${maskEmail(account.email)}? (y/N)  › `,
  );
  if (confirm.toLowerCase() === "y") {
    if (removeAccount(account.id)) {
      console.log(ok(`  removida`));
    } else {
      console.log(err("  falhou"));
    }
  } else {
    console.log(mute("  cancelado"));
  }
  await askPurple("  enter… ");
}

showMenu().catch((err) => {
  console.error(err);
  process.exit(1);
});
