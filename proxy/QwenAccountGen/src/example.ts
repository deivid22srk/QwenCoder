/**
 * Example usage of QwenAccountGen
 *
 * Demonstrates how to use the anti-bot system to capture headers
 * and make authenticated requests to Qwen API
 */

import {
  configureAntiBot,
  initAccount,
  captureHeaders,
  getHeaders,
  closeAccount,
  closeAll,
  markAccountRateLimited,
  isAccountAvailable,
  type AccountConfig,
} from "./index.js";

async function main() {
  // Configure the anti-bot system
  configureAntiBot({
    headerCacheTtlMs: 5 * 60 * 1000, // 5 minutes
    rateLimitCooldownMs: 10 * 60 * 1000, // 10 minutes
    headless: false, // Set to true for production
    profileDir: "./data/profiles",
  });

  // Define account
  const account: AccountConfig = {
    id: "account-1",
    email: "your-email@example.com",
    password: "your-password",
  };

  try {
    // Initialize browser for the account
    console.log("Initializing browser...");
    await initAccount(account);

    // Capture anti-bot headers
    console.log("Capturing headers...");
    const headers = await captureHeaders(account.id);

    if (!headers) {
      console.error("Failed to capture headers");
      return;
    }

    console.log("Headers captured successfully!");
    console.log("Cookie length:", headers.cookie.length);
    console.log("bx-ua length:", headers["bx-ua"].length);
    console.log("bx-umidtoken length:", headers["bx-umidtoken"].length);

    // Use headers to make API requests
    console.log("\nMaking API request with captured headers...");
    const response = await fetch("https://chat.qwen.ai/api/v2/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": headers["user-agent"],
        Cookie: headers.cookie,
        "bx-ua": headers["bx-ua"],
        "bx-umidtoken": headers["bx-umidtoken"],
        "bx-v": headers["bx-v"],
      },
      body: JSON.stringify({
        model: "qwen3.7-plus",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("API request failed:", response.status, errorText);

      // Check if it's an anti-bot error
      if (
        errorText.includes("FAIL_SYS_USER_VALIDATE") ||
        errorText.includes("RGV587_ERROR") ||
        errorText.includes("anti-bot")
      ) {
        console.log("Anti-bot detected! Marking account as rate limited...");
        markAccountRateLimited(account.id);
      }
    } else {
      console.log("API request successful!");
      // Process streaming response...
    }

    // Get cached headers (will reuse if still valid)
    console.log("\nGetting cached headers...");
    const cachedHeaders = await getHeaders(account.id);
    console.log("Using cached headers:", cachedHeaders === headers);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    // Clean up
    console.log("\nClosing browser...");
    await closeAccount(account.id);
  }
}

// Multi-account example
async function multiAccountExample() {
  const accounts: AccountConfig[] = [
    { id: "account-1", email: "email1@example.com", password: "pass1" },
    { id: "account-2", email: "email2@example.com", password: "pass2" },
    { id: "account-3", email: "email3@example.com", password: "pass3" },
  ];

  try {
    // Initialize all accounts
    for (const account of accounts) {
      await initAccount(account);
      await captureHeaders(account.id);
    }

    // Find available account
    const availableAccount = accounts.find((acc) => isAccountAvailable(acc.id));

    if (availableAccount) {
      console.log(`Using account: ${availableAccount.id}`);
      const headers = await getHeaders(availableAccount.id);
      // Make request...
    } else {
      console.log("All accounts are rate limited!");
    }
  } finally {
    await closeAll();
  }
}

// Run example
main().catch(console.error);
