# QwenAccountGen

Standalone anti-bot captcha evasion system for Qwen account generation.

## Overview

This module provides a complete anti-bot evasion system that:

- Uses **Playwright with stealth plugin** to avoid bot detection
- Generates **deterministic browser fingerprints** per account
- Injects **stealth scripts** to hide automation APIs
- **Captures real anti-bot headers** (`bx-ua`, `bx-umidtoken`, `bx-v`) from legitimate browser requests
- **Caches headers** for 5 minutes (Alibaba token lifetime)
- **Detects anti-bot errors** and implements account rotation
- Simulates **human behavior** (mouse movements, scrolling, hover events)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Manager                           │
│  - Playwright initialization with stealth                    │
│  - Header capture via request interception                   │
│  - Account state management (rate limiting, cooldown)        │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌────────────────┐    ┌──────────────────┐
│  Fingerprint  │    │    Stealth     │    │ Human Behavior   │
│  Generator    │    │    Scripts     │    │   Simulation     │
│               │    │                │    │                  │
│ - User-Agent  │    │ - webdriver    │    │ - Mouse moves    │
│ - WebGL       │    │ - chrome obj   │    │ - Scrolling      │
│ - Viewport    │    │ - plugins      │    │ - Hover events   │
│ - Hardware    │    │ - permissions  │    │ - Random delays  │
│ - Languages   │    │ - toString     │    │                  │
└───────────────┘    └────────────────┘    └──────────────────┘
```

## Installation

```bash
cd QwenAccountGen
npm install
```

## Usage

### Basic Example

```typescript
import {
  configureAntiBot,
  initAccount,
  captureHeaders,
  getHeaders,
  closeAccount,
} from "./index.js";

// Configure
configureAntiBot({
  headerCacheTtlMs: 5 * 60 * 1000,
  rateLimitCooldownMs: 10 * 60 * 1000,
  headless: false,
  profileDir: "./data/profiles",
});

// Initialize account
const account = {
  id: "account-1",
  email: "your-email@example.com",
  password: "your-password",
};

await initAccount(account);

// Capture anti-bot headers
const headers = await captureHeaders(account.id);

if (headers) {
  // Use headers for API requests
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
}

// Clean up
await closeAccount(account.id);
```

### Multi-Account Rotation

```typescript
import {
  initAccount,
  captureHeaders,
  getHeaders,
  isAccountAvailable,
  markAccountRateLimited,
  closeAll,
} from "./index.js";

const accounts = [
  { id: "acc-1", email: "email1@example.com", password: "pass1" },
  { id: "acc-2", email: "email2@example.com", password: "pass2" },
  { id: "acc-3", email: "email3@example.com", password: "pass3" },
];

// Initialize all accounts
for (const account of accounts) {
  await initAccount(account);
  await captureHeaders(account.id);
}

// Find available account
const available = accounts.find((acc) => isAccountAvailable(acc.id));

if (available) {
  const headers = await getHeaders(available.id);
  // Make request...
  
  // If anti-bot error detected
  if (antiBotError) {
    markAccountRateLimited(available.id);
  }
}

// Clean up all
await closeAll();
```

## API Reference

### Configuration

```typescript
configureAntiBot({
  headerCacheTtlMs: number;      // How long to cache headers (default: 5 min)
  rateLimitCooldownMs: number;   // Cooldown when rate limited (default: 10 min)
  headless: boolean;             // Run browser in headless mode (default: true)
  profileDir: string;            // Directory for browser profiles (default: "./data/profiles")
});
```

### Account Management

```typescript
// Initialize browser for account
await initAccount(account: AccountConfig);

// Capture anti-bot headers
const headers = await captureHeaders(accountId: string);

// Get cached headers (auto-refresh if expired)
const headers = await getHeaders(accountId: string);

// Check if account is available (not rate limited)
const available = isAccountAvailable(accountId: string);

// Mark account as rate limited
markAccountRateLimited(accountId: string);

// Close browser for account
await closeAccount(accountId: string);

// Close all browsers
await closeAll();

// Reset profile (clears cookies/cache)
await resetProfile(accountId: string);
```

### Types

```typescript
interface AccountConfig {
  id: string;
  email: string;
  password: string;
}

interface CapturedHeaders {
  cookie: string;
  "bx-ua": string;
  "bx-umidtoken": string;
  "bx-v": string;
  "user-agent": string;
}

interface FingerprintProfile {
  accountId: string;
  userAgent: string;
  viewport: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  // ... more fields
}
```

## How It Works

### 1. Fingerprint Generation

Each account gets a **deterministic browser fingerprint** based on the account ID:

- **User-Agent**: Chrome 149 on Windows 10
- **WebGL**: Realistic GPU profiles (Intel UHD 630, RTX 3060, etc.)
- **Viewport**: Common resolutions (1366x768 to 1920x1200)
- **Hardware**: 4-16 CPU cores, 4-16 GB RAM
- **Languages**: pt-BR, en-US, etc.

The fingerprint is **consistent per account** (seeded PRNG), so the same account always presents the same identity.

### 2. Stealth Injection

The stealth script patches browser APIs to hide automation:

- `navigator.webdriver` → `undefined`
- `window.chrome` → realistic Chrome runtime object
- `navigator.plugins` → 3 realistic plugins
- `WebGLRenderingContext.getParameter` → consistent vendor/renderer
- `Function.prototype.toString` → patched functions return `[native code]`

### 3. Header Capture

Instead of solving captchas, the system **captures real anti-bot headers** from legitimate browser requests:

1. Navigate to `chat.qwen.ai`
2. Intercept requests to `/api/v2/chat/completions`
3. Extract headers: `cookie`, `bx-ua`, `bx-umidtoken`, `bx-v`
4. Cache headers for 5 minutes
5. Reuse headers for API requests

### 4. Anti-Bot Detection

When the Alibaba TMD anti-bot system triggers:

```typescript
// Detect errors
if (
  errorText.includes("FAIL_SYS_USER_VALIDATE") ||  // Captcha challenge
  errorText.includes("RGV587_ERROR") ||            // Rate limit
  errorText.includes("anti-bot")
) {
  markAccountRateLimited(accountId);
}
```

### 5. Account Rotation

When an account is rate limited:

1. Mark as unavailable for 10 minutes
2. Switch to another account from the pool
3. If all accounts are limited, wait or add more accounts

## Anti-Bot Errors

| Error Code | Meaning | Action |
|---|---|---|
| `FAIL_SYS_USER_VALIDATE` | Captcha challenge | Rotate account |
| `RGV587_ERROR` | Rate limit | Rotate account, wait cooldown |
| `anti-bot` | Generic anti-bot block | Rotate account |

## Files

- `src/types.ts` - Type definitions
- `src/fingerprint.ts` - Deterministic fingerprint generation
- `src/stealth.ts` - Stealth script injection
- `src/human-behavior.ts` - Human behavior simulation
- `src/browser-manager.ts` - Browser lifecycle and header capture
- `src/index.ts` - Public API exports
- `src/example.ts` - Usage examples

## License

MIT
