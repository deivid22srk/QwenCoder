import { createMailTmInbox } from "../services/mail-tm.ts";
import { registerQwenAccountHttp } from "../services/account-register-http.ts";
import {
  nextQwenUsername,
  generatePassword,
} from "../services/account-register.ts";
import { addAccount } from "../core/accounts.ts";

const t0 = Date.now();
const marks: Record<string, number> = {};
const mark = (k: string) => {
  marks[k] = Date.now() - t0;
};

mark("start");
const mail = await createMailTmInbox();
mark("mailTm");

const name = nextQwenUsername();
const password = generatePassword(16);
mark("creds");

const r = await registerQwenAccountHttp({
  name,
  email: mail.address,
  password,
});
mark("signup");

let saved = false;
let saveError: string | null = null;
if (r.success) {
  try {
    addAccount(mail.address, password);
    saved = true;
  } catch (e: any) {
    saveError = e?.message || String(e);
  }
}
mark("done");

const totalSec = (Date.now() - t0) / 1000;

console.log(
  JSON.stringify(
    {
      success: r.success,
      needsCaptcha: r.needsCaptcha,
      wafBlocked: r.wafBlocked,
      status: r.status,
      error: r.error,
      username: name,
      email: mail.address,
      password,
      userId: r.userId,
      hasToken: !!r.token,
      tokenPreview: r.token ? `${r.token.slice(0, 40)}...` : null,
      savedToDb: saved,
      saveError,
      timing: {
        mailTm_s: Number((marks.mailTm / 1000).toFixed(2)),
        signup_s: Number(((marks.signup - marks.mailTm) / 1000).toFixed(2)),
        total_s: Number(totalSec.toFixed(2)),
      },
      rawBodyPreview: r.rawBody?.slice(0, 300) ?? null,
    },
    null,
    2,
  ),
);

process.exit(r.success ? 0 : 2);
