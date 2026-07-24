import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCliLine, restyleConsoleArgs } from "../core/cli-log.ts";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("formatCliLine uses > TAG > layout", () => {
  const line = stripAnsi(
    formatCliLine("Server", "Listening on http://127.0.0.1:3000/v1", "boot"),
  );
  assert.ok(line.startsWith(">"));
  assert.ok(line.includes("SERVER"));
  assert.ok(!line.includes("_____"));
  // second > after the tag
  assert.match(line, /^>\s+\S[\s\S]*?>\s+Listening/);
  assert.ok(line.includes("Listening"));
});

test("all tags share the same column width (no double OK badge)", () => {
  const a = stripAnsi(formatCliLine("Server", "hello", "info"));
  const b = stripAnsi(formatCliLine("Playwright", "hello", "info"));
  const c = stripAnsi(formatCliLine("SessionKeeper", "hello", "info"));
  const d = stripAnsi(formatCliLine("Server", "ready", "ok"));

  // Message arrow position should match across tags
  const msgArrowAt = (s: string) => {
    const first = s.indexOf(">");
    return s.indexOf(">", first + 1);
  };
  assert.equal(msgArrowAt(a), msgArrowAt(b));
  assert.equal(msgArrowAt(b), msgArrowAt(c));
  assert.equal(msgArrowAt(c), msgArrowAt(d));

  assert.ok(d.includes("SERVER"));
  assert.ok(!d.includes("SESSIONKEEPE"));
  assert.ok(c.includes("SESSION"));
});

test("formatCliLine mini tags keep Chat", () => {
  const line = stripAnsi(
    formatCliLine("Chat", "Request | qwen3.8-max-preview | 5 msg(s)", "mini"),
  );
  assert.ok(line.includes("Request"));
  assert.ok(line.includes("CHAT") || line.includes("Chat"));
  assert.ok(!line.includes("_____"));
});

test("restyleConsoleArgs rewrites [Tag] prefix", () => {
  const out = restyleConsoleArgs(["[Playwright] Stealth plugin loaded"], "info");
  assert.equal(out.length, 1);
  assert.equal(typeof out[0], "string");
  const plain = stripAnsi(String(out[0]));
  assert.ok(plain.includes("Stealth") || plain.includes("plugin"));
  assert.ok(!plain.includes("_____"));
});

test("restyleConsoleArgs merges trailing string arg", () => {
  const out = restyleConsoleArgs(
    ["[Server] Failed to initialize:", "boom"],
    "error",
  );
  assert.equal(out.length, 1);
  assert.ok(stripAnsi(String(out[0])).includes("boom"));
});

test("restyleConsoleArgs keeps non-string extras", () => {
  const err = new Error("x");
  const out2 = restyleConsoleArgs(["[Server] boom", err], "error");
  assert.equal(out2[1], err);
});
