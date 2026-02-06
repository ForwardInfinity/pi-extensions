/**
 * Claude Account Rotator Extension for Pi
 *
 * Automatically rotates between multiple Claude Pro OAuth accounts
 * when rate limit / quota errors (429) are detected.
 *
 * How it works:
 *   1. On `turn_end`, if the assistant message has a rate limit error,
 *      the extension swaps OAuth credentials to the next available account.
 *   2. Pi's built-in retry mechanism then uses the new credentials transparently.
 *   3. The retry succeeds with the new account — no user intervention needed.
 *
 * Commands:
 *   /account add [label]    - Add a new Claude Pro account via OAuth
 *   /account list            - Show all accounts and their status
 *   /account identify        - Fetch email for accounts missing it
 *   /account rotate          - Manually rotate to next available account
 *   /account remove <index>  - Remove an account by index
 *   /account reset           - Reset all exhaustion markers
 *   /account sync            - Sync credentials from current auth.json
 *   /account help            - Show help
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  OAuthCredential,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

interface Account {
  label: string;
  email?: string;
  accountUuid?: string;
  refresh: string;
  access: string;
  expires: number;
  addedAt: number;
  exhaustedAt: number | null;
}

interface AccountsConfig {
  accounts: Account[];
  currentIndex: number;
}

/** Fields returned by Anthropic token endpoints (both auth code and refresh) */
interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  account?: { uuid: string; email_address: string };
  organization?: { uuid: string; name: string };
}

// =============================================================================
// Constants
// =============================================================================

const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || join(process.env.HOME!, ".pi", "agent");
const ACCOUNTS_FILE = join(AGENT_DIR, "claude-accounts.json");

// Anthropic OAuth (same constants as Pi's built-in flow)
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

// Match rate limit / quota errors only (NOT server overload 529, NOT 5xx)
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|429/i;

// Exhausted accounts become available again after this cooldown period
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// =============================================================================
// Account Storage
// =============================================================================

function loadAccounts(): AccountsConfig {
  if (!existsSync(ACCOUNTS_FILE)) {
    return { accounts: [], currentIndex: 0 };
  }
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
    return {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      currentIndex: typeof raw.currentIndex === "number" ? raw.currentIndex : 0,
    };
  } catch {
    return { accounts: [], currentIndex: 0 };
  }
}

function saveAccounts(cfg: AccountsConfig): void {
  const dir = dirname(ACCOUNTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  try {
    chmodSync(ACCOUNTS_FILE, 0o600);
  } catch {
    /* ignore */
  }
}

// =============================================================================
// Anthropic Token Helpers
// =============================================================================

async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Call the Anthropic token endpoint and parse the full response
 * including account email. Works for both authorization_code and refresh_token grants.
 */
async function callTokenEndpoint(
  body: Record<string, string>,
): Promise<TokenResponse | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return (await response.json()) as TokenResponse;
  } catch {
    return null;
  }
}

/** Extract standard fields from a token response into account-friendly shape */
function parseTokenResponse(data: TokenResponse) {
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    email: data.account?.email_address ?? undefined,
    accountUuid: data.account?.uuid ?? undefined,
  };
}

/**
 * Refresh an account's tokens and retrieve its email/uuid.
 * NOTE: Anthropic rotates the refresh token on every refresh —
 * the old refresh token becomes invalid.
 */
async function refreshAccountTokens(refreshToken: string) {
  const data = await callTokenEndpoint({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (!data) return null;
  return parseTokenResponse(data);
}

// =============================================================================
// OAuth Login Flow
// =============================================================================

async function anthropicOAuth(
  pi: ExtensionAPI,
  ui: ExtensionContext["ui"],
): Promise<ReturnType<typeof parseTokenResponse> | null> {
  const { verifier, challenge } = await generatePKCE();

  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

  try {
    await pi.exec("xdg-open", [authUrl], { timeout: 5000 });
  } catch {
    ui.notify(`Open this URL manually:\n${authUrl}`, "info");
  }

  const authCode = await ui.input(
    "Paste the authorization code from the browser:",
  );
  if (!authCode?.trim()) return null;

  const parts = authCode.trim().split("#");
  const code = parts[0];
  const state = parts[1];

  const data = await callTokenEndpoint({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  if (!data) {
    ui.notify("Token exchange failed.", "error");
    return null;
  }

  return parseTokenResponse(data);
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  let config = loadAccounts();

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /** Human-friendly display name: email if available, otherwise label */
  function displayName(acc: Account): string {
    return acc.email ?? acc.label;
  }

  /** Count accounts not currently in cooldown */
  function countAvailable(): number {
    const now = Date.now();
    return config.accounts.filter((a) => {
      if (!a.exhaustedAt) return true;
      return now - a.exhaustedAt > COOLDOWN_MS;
    }).length;
  }

  /** Find next available account (round-robin from currentIndex) */
  function findNextAvailable(): {
    account: Account;
    index: number;
  } | null {
    const now = Date.now();
    const len = config.accounts.length;
    for (let offset = 1; offset < len; offset++) {
      const idx = (config.currentIndex + offset) % len;
      const acc = config.accounts[idx];
      if (!acc.exhaustedAt || now - acc.exhaustedAt > COOLDOWN_MS) {
        return { account: acc, index: idx };
      }
    }
    return null;
  }

  /**
   * Find account index by stable identifiers.
   * Priority: accountUuid > email > refresh token (least stable).
   */
  function findAccountIndex(match: {
    accountUuid?: string;
    email?: string;
    refresh?: string;
  }): number {
    if (match.accountUuid) {
      const idx = config.accounts.findIndex(
        (a) => a.accountUuid === match.accountUuid,
      );
      if (idx >= 0) return idx;
    }
    if (match.email) {
      const idx = config.accounts.findIndex((a) => a.email === match.email);
      if (idx >= 0) return idx;
    }
    if (match.refresh) {
      const idx = config.accounts.findIndex((a) => a.refresh === match.refresh);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  /** Update footer status indicator */
  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    if (config.accounts.length === 0 || ctx.model?.provider !== "anthropic") {
      ctx.ui.setStatus("account-rotator", undefined);
      return;
    }

    const avail = countAvailable();
    const current = config.accounts[config.currentIndex];
    const name = current ? displayName(current) : "?";
    ctx.ui.setStatus(
      "account-rotator",
      `🔑 ${name} (${avail}/${config.accounts.length})`,
    );
  }

  /**
   * Rotate to the next available account.
   * Writes new OAuth credentials into Pi's AuthStorage so the next
   * getApiKey() call (including built-in retry) picks them up.
   */
  function rotateAccount(ctx: ExtensionContext): boolean {
    if (config.accounts.length <= 1) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "⚠️ Need at least 2 accounts for rotation. Use /account add",
          "warning",
        );
      return false;
    }

    const next = findNextAvailable();
    if (!next) {
      const soonest = config.accounts
        .filter((a) => a.exhaustedAt)
        .map((a) => a.exhaustedAt! + COOLDOWN_MS - Date.now())
        .filter((t) => t > 0)
        .sort((a, b) => a - b)[0];
      const mins = soonest ? Math.ceil(soonest / 60000) : "?";
      if (ctx.hasUI)
        ctx.ui.notify(
          `⚠️ All accounts exhausted! Next available in ~${mins} min.`,
          "error",
        );
      return false;
    }

    config.currentIndex = next.index;

    const credential: OAuthCredential = {
      type: "oauth",
      refresh: next.account.refresh,
      access: next.account.access,
      expires: next.account.expires,
    };
    ctx.modelRegistry.authStorage.set("anthropic", credential);

    saveAccounts(config);

    if (ctx.hasUI)
      ctx.ui.notify(`🔄 Rotated to: ${displayName(next.account)}`, "info");
    updateStatus(ctx);
    return true;
  }

  /**
   * Sync credentials from Pi's auth.json back into our accounts config.
   *
   * Matching strategy:
   *   1. Try accountUuid or email (stable across token refreshes)
   *   2. Try refresh token (works if Pi hasn't refreshed yet)
   *   3. Fall back to currentIndex (Pi only refreshes the active account)
   */
  function syncFromAuth(ctx: ExtensionContext): void {
    const cred = ctx.modelRegistry.authStorage.get("anthropic");
    if (!cred || cred.type !== "oauth") return;

    const oauthCred = cred as OAuthCredential;

    // Try stable identifiers first, then refresh token
    let idx = findAccountIndex({ refresh: oauthCred.refresh });

    // Fallback: if no match, Pi rotated the current account's refresh token
    if (idx < 0 && config.currentIndex < config.accounts.length) {
      idx = config.currentIndex;
    }

    if (idx >= 0 && idx < config.accounts.length) {
      config.accounts[idx].refresh = oauthCred.refresh;
      config.accounts[idx].access = oauthCred.access;
      config.accounts[idx].expires = oauthCred.expires;
      config.currentIndex = idx;
      saveAccounts(config);
    }
  }

  /**
   * Auto-import current Anthropic OAuth credentials as first account
   * if no accounts configured yet.
   */
  function autoImportFromAuth(ctx: ExtensionContext): void {
    if (config.accounts.length > 0) return;

    const cred = ctx.modelRegistry.authStorage.get("anthropic");
    if (!cred || cred.type !== "oauth") return;

    const oauthCred = cred as OAuthCredential;
    config.accounts.push({
      label: "Account 1 (auto-imported)",
      refresh: oauthCred.refresh,
      access: oauthCred.access,
      expires: oauthCred.expires,
      addedAt: Date.now(),
      exhaustedAt: null,
    });
    config.currentIndex = 0;
    saveAccounts(config);

    if (ctx.hasUI)
      ctx.ui.notify(
        "🔑 Auto-imported current Anthropic credentials as Account 1.\n" +
          "   Run /account identify to fetch email, then /account add for more.",
        "info",
      );
  }

  // ------------------------------------------------------------------
  // Event Handlers
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadAccounts();
    autoImportFromAuth(ctx);
    syncFromAuth(ctx);
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "anthropic") return;

    const msg = event.message;
    if (msg.role !== "assistant") return;

    const assistantMsg = msg as AssistantMessage;
    if (assistantMsg.stopReason !== "error" || !assistantMsg.errorMessage)
      return;

    if (!RATE_LIMIT_PATTERN.test(assistantMsg.errorMessage)) return;
    if (config.accounts.length <= 1) return;

    const current = config.accounts[config.currentIndex];
    if (current) {
      current.exhaustedAt = Date.now();
      saveAccounts(config);
    }

    const success = rotateAccount(ctx);
    if (success && ctx.hasUI) {
      ctx.ui.notify(
        "⏳ Pi will retry automatically with the new account...",
        "info",
      );
    }
  });

  // ------------------------------------------------------------------
  // /account Command
  // ------------------------------------------------------------------

  const SUBCOMMANDS = [
    "add",
    "list",
    "identify",
    "rotate",
    "remove",
    "reset",
    "sync",
    "help",
  ];

  pi.registerCommand("account", {
    description: "Manage Claude Pro accounts for quota rotation",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const matches = SUBCOMMANDS.filter((s) =>
        s.startsWith(prefix.toLowerCase()),
      ).map((s) => ({ value: s, label: s }));
      return matches.length > 0 ? matches : null;
    },

    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || "help";

      switch (sub) {
        // ---- /account add [label] ----
        case "add": {
          const customLabel = parts.slice(1).join(" ") || "";

          if (ctx.hasUI)
            ctx.ui.notify(
              "Opening browser for Anthropic OAuth login...\n" +
                "💡 Make sure you're signed into the desired Claude account in your browser first!",
              "info",
            );

          const tokens = await anthropicOAuth(pi, ctx.ui);
          if (!tokens) {
            if (ctx.hasUI) ctx.ui.notify("Account add cancelled.", "warning");
            return;
          }

          // Use email as label if user didn't provide one
          const label =
            customLabel ||
            tokens.email ||
            `Account ${config.accounts.length + 1}`;

          // Check for duplicate by stable identifiers
          const dupIdx = findAccountIndex({
            accountUuid: tokens.accountUuid,
            email: tokens.email,
          });

          if (dupIdx >= 0) {
            const existing = config.accounts[dupIdx];
            existing.refresh = tokens.refresh;
            existing.access = tokens.access;
            existing.expires = tokens.expires;
            existing.email = tokens.email;
            existing.accountUuid = tokens.accountUuid;
            existing.label = customLabel || existing.label;
            saveAccounts(config);
            if (ctx.hasUI)
              ctx.ui.notify(
                `🔄 Updated existing: ${displayName(existing)}`,
                "info",
              );
            updateStatus(ctx);
            return;
          }

          config.accounts.push({
            label,
            email: tokens.email,
            accountUuid: tokens.accountUuid,
            refresh: tokens.refresh,
            access: tokens.access,
            expires: tokens.expires,
            addedAt: Date.now(),
            exhaustedAt: null,
          });
          saveAccounts(config);

          if (ctx.hasUI)
            ctx.ui.notify(
              `✅ Added: ${tokens.email ?? label} (total: ${config.accounts.length} accounts)`,
              "info",
            );
          updateStatus(ctx);
          break;
        }

        // ---- /account list ----
        case "list": {
          if (config.accounts.length === 0) {
            if (ctx.hasUI)
              ctx.ui.notify(
                "No accounts configured.\nUse /account add to add one.",
                "info",
              );
            return;
          }

          const now = Date.now();
          const lines = config.accounts.map((acc, i) => {
            const arrow = i === config.currentIndex ? " → " : "   ";
            let status: string;
            if (!acc.exhaustedAt) {
              status = "✅ available";
            } else {
              const remaining = COOLDOWN_MS - (now - acc.exhaustedAt);
              if (remaining > 0) {
                const mins = Math.ceil(remaining / 60000);
                status = `⏳ exhausted (${mins}m cooldown)`;
              } else {
                status = "✅ available (cooldown expired)";
              }
            }
            const email = acc.email
              ? `<${acc.email}>`
              : "(no email — run /account identify)";
            return `${arrow}[${i}] ${acc.label}  ${email}  ${status}`;
          });

          if (ctx.hasUI)
            ctx.ui.notify("Claude Accounts:\n" + lines.join("\n"), "info");
          break;
        }

        // ---- /account identify ----
        case "identify": {
          if (config.accounts.length === 0) {
            if (ctx.hasUI) ctx.ui.notify("No accounts to identify.", "info");
            return;
          }

          const toIdentify = config.accounts
            .map((acc, index) => ({ acc, index }))
            .filter(({ acc }) => !acc.email);

          if (toIdentify.length === 0) {
            if (ctx.hasUI)
              ctx.ui.notify(
                "All accounts already have email addresses.",
                "info",
              );
            return;
          }

          if (ctx.hasUI)
            ctx.ui.notify(
              `Identifying ${toIdentify.length} account(s)...`,
              "info",
            );

          let identified = 0;
          for (const { acc, index } of toIdentify) {
            const result = await refreshAccountTokens(acc.refresh);
            if (result) {
              acc.refresh = result.refresh;
              acc.access = result.access;
              acc.expires = result.expires;
              acc.email = result.email;
              acc.accountUuid = result.accountUuid;

              // Update label to email if it was a generic label
              if (result.email && acc.label.startsWith("Account ")) {
                acc.label = result.email;
              }

              // If this is the active account, also update auth.json
              if (index === config.currentIndex) {
                ctx.modelRegistry.authStorage.set("anthropic", {
                  type: "oauth",
                  refresh: result.refresh,
                  access: result.access,
                  expires: result.expires,
                } as OAuthCredential);
              }

              identified++;
            } else {
              if (ctx.hasUI)
                ctx.ui.notify(
                  `⚠️ Failed to identify [${index}] ${acc.label} — refresh token may be invalid.`,
                  "warning",
                );
            }
          }

          saveAccounts(config);
          if (ctx.hasUI)
            ctx.ui.notify(
              `✅ Identified ${identified}/${toIdentify.length} account(s).`,
              "info",
            );
          updateStatus(ctx);
          break;
        }

        // ---- /account rotate ----
        case "rotate": {
          rotateAccount(ctx);
          break;
        }

        // ---- /account remove <index> ----
        case "remove": {
          const idx = parseInt(parts[1]);
          if (isNaN(idx) || idx < 0 || idx >= config.accounts.length) {
            if (ctx.hasUI)
              ctx.ui.notify(
                `Invalid index. Use: /account remove <0-${config.accounts.length - 1}>`,
                "error",
              );
            return;
          }

          const removed = config.accounts.splice(idx, 1)[0];

          if (config.accounts.length === 0) {
            config.currentIndex = 0;
          } else if (config.currentIndex >= config.accounts.length) {
            config.currentIndex = config.accounts.length - 1;
          } else if (config.currentIndex > idx) {
            config.currentIndex--;
          }

          saveAccounts(config);
          if (ctx.hasUI)
            ctx.ui.notify(
              `🗑️ Removed: ${displayName(removed)} (${config.accounts.length} remaining)`,
              "info",
            );
          updateStatus(ctx);
          break;
        }

        // ---- /account reset ----
        case "reset": {
          let count = 0;
          for (const acc of config.accounts) {
            if (acc.exhaustedAt !== null) {
              acc.exhaustedAt = null;
              count++;
            }
          }
          saveAccounts(config);
          if (ctx.hasUI)
            ctx.ui.notify(`✅ Reset ${count} account(s) to available.`, "info");
          updateStatus(ctx);
          break;
        }

        // ---- /account sync ----
        case "sync": {
          syncFromAuth(ctx);
          if (ctx.hasUI)
            ctx.ui.notify("✅ Synced credentials from auth.json.", "info");
          updateStatus(ctx);
          break;
        }

        // ---- /account help (default) ----
        default: {
          if (ctx.hasUI)
            ctx.ui.notify(
              "Claude Account Rotator\n\n" +
                "  /account add [label]    Add a Claude Pro account (OAuth)\n" +
                "  /account list           Show all accounts + status\n" +
                "  /account identify       Fetch emails for accounts missing it\n" +
                "  /account rotate         Manually rotate to next account\n" +
                "  /account remove <idx>   Remove account by index\n" +
                "  /account reset          Reset all exhaustion markers\n" +
                "  /account sync           Sync tokens from auth.json\n\n" +
                "Auto-rotation triggers on rate limit (429) errors.\n" +
                `Cooldown: ${COOLDOWN_MS / 60000} minutes per exhausted account.\n` +
                `Config: ${ACCOUNTS_FILE}`,
              "info",
            );
          break;
        }
      }
    },
  });
}
