import { createQwenAccountAuto } from "../services/account-register.ts";
import { addAccount } from "../core/accounts.ts";

const t0 = Date.now();
const mark = (label: string) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${label}`);
};

mark("start createQwenAccountAuto (HTTP native + puzzle solver)");

const result = await createQwenAccountAuto();
const total_s = Number(((Date.now() - t0) / 1000).toFixed(2));
const creds = result.credentials;

let saved = false;
let saveError: string | null = null;
if (result.success && creds) {
  try {
    addAccount(creds.email, creds.password);
    saved = true;
  } catch (e: any) {
    saveError = e?.message || String(e);
    if (String(saveError).toLowerCase().includes("already exists")) {
      saved = true;
      saveError = null;
    }
  }
}

console.log(
  "\n=== RESULT ===\n" +
    JSON.stringify(
      {
        success: result.success,
        method: result.method,
        error: result.error,
        username: creds?.username,
        email: creds?.email,
        password: creds?.password,
        userId: result.userId,
        hasToken: !!result.token,
        captcha: result.captcha,
        emailVerified: result.emailVerified,
        activateUrl: result.activateUrl,
        mailTm: result.mailTm?.address,
        savedToDb: saved,
        saveError,
        elapsedMs: result.elapsedMs,
        total_s,
      },
      null,
      2,
    ),
);

if (result.success && creds) {
  console.log("\n=== LOGIN DATA ===");
  console.log(`Email:    ${creds.email}`);
  console.log(`Password: ${creds.password}`);
  console.log(`Username: ${creds.username}`);
  console.log(
    `Email verify: ${result.emailVerified ? "OK (activate link hit)" : "PENDING/FAIL"}`,
  );
  console.log(`Tempo:    ${total_s}s`);
  console.log(
    "\nNota: a senha no login da API Qwen é SHA256(plain). O bridge já salva a plain e hasheia no uso.",
  );
}

process.exit(result.success ? 0 : 2);
