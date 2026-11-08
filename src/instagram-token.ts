// Instagram tokens from "API setup with Instagram login" last about 60 days.
// This module checks the connection, renews the token before it expires and
// keeps the renewed token AES-GCM encrypted in D1. The INSTAGRAM_ACCESS_TOKEN
// secret stays the bootstrap credential and the source of the encryption key;
// replacing that secret starts a fresh renewal schedule.

type InstagramTokenEnv = Pick<Cloudflare.Env, "DB"> & {
  INSTAGRAM_ACCESS_TOKEN: string;
  IG_USER_ID: string;
  GRAPH_API_BASE: string;
};

export type InstagramTokenStatus = {
  state: "pending" | "healthy" | "error" | "reconnect";
  username: string | null;
  lastCheckedAt: string | null;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  expiresAt: string | null;
  needsReconnect: boolean;
  error: string | null;
};

type TokenRow = {
  seed_fingerprint: string;
  token_ciphertext: string;
  first_observed_at: number;
  last_checked_at: number | null;
  last_refreshed_at: number | null;
  next_refresh_at: number;
  expires_at: number | null;
  username: string | null;
  needs_reconnect: number;
  safe_error: string | null;
};

// graph.facebook.com is "Unified login": a system-user token that never expires.
const GRAPH_HOSTS = new Set(["graph.instagram.com", "graph.facebook.com"]);
const DAY = 24 * 60 * 60 * 1000;
const FIRST_REFRESH_DELAY = 2 * DAY;
const REFRESH_INTERVAL = 30 * DAY;
const LEASE_DURATION = 2 * 60 * 1000;
const REQUEST_TIMEOUT = 15 * 1000;
const MAX_RESPONSE_BYTES = 16 * 1024;

class TokenError extends Error {
  constructor(message: string, readonly needsReconnect = false) {
    super(message);
  }
}

function seedValue(env: InstagramTokenEnv): string {
  const seed = env.INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!seed || !env.IG_USER_ID?.trim()) {
    throw new TokenError("Instagram credentials are missing. Reconnect the account.", true);
  }
  return seed;
}

async function fingerprint(env: InstagramTokenEnv): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    `manychat-lite:token-seed:v1\u0000${env.IG_USER_ID}\u0000${seedValue(env)}`
  ));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(env: InstagramTokenEnv): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    `manychat-lite:token-encryption:v1\u0000${env.IG_USER_ID}\u0000${seedValue(env)}`
  ));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function encryptToken(env: InstagramTokenEnv, seedFingerprint: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(seedFingerprint) },
    await encryptionKey(env),
    new TextEncoder().encode(token)
  );
  return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

async function decryptToken(env: InstagramTokenEnv, row: TokenRow): Promise<string> {
  try {
    const [version, nonce, ciphertext, extra] = row.token_ciphertext.split(".");
    if (version !== "v1" || !nonce || !ciphertext || extra) throw new Error("Invalid envelope");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(nonce), additionalData: new TextEncoder().encode(row.seed_fingerprint) },
      await encryptionKey(env), decodeBase64(ciphertext)
    );
    const token = new TextDecoder().decode(plaintext);
    if (!token || token.length > 8192) throw new Error("Invalid token");
    return token;
  } catch {
    // Crypto errors must not expose token values or cause fallback to an old seed.
    throw new TokenError("The saved Instagram token could not be read. Reconnect the account.", true);
  }
}

async function readRow(env: InstagramTokenEnv, seedFingerprint: string): Promise<TokenRow | null> {
  return env.DB.prepare("SELECT * FROM instagram_tokens WHERE seed_fingerprint = ?")
    .bind(seedFingerprint).first<TokenRow>();
}

function safeStatus(row: TokenRow | null, now: number): InstagramTokenStatus {
  const expired = row?.expires_at != null && row.expires_at <= now;
  const needsReconnect = Boolean(row?.needs_reconnect || expired);
  const overdue = row?.last_checked_at != null && now - row.last_checked_at > 3 * DAY;
  const error = expired ? "The Instagram token expired. Reconnect the account." :
    row?.safe_error ?? (overdue ? "The connection check is overdue." : null);
  return {
    state: needsReconnect ? "reconnect" : error ? "error" : row?.last_checked_at != null ? "healthy" : "pending",
    username: row?.username ?? null,
    lastCheckedAt: row?.last_checked_at != null ? new Date(row.last_checked_at).toISOString() : null,
    lastRefreshedAt: row?.last_refreshed_at != null ? new Date(row.last_refreshed_at).toISOString() : null,
    nextRefreshAt: row && !needsReconnect ? new Date(row.next_refresh_at).toISOString() : null,
    expiresAt: row?.expires_at != null ? new Date(row.expires_at).toISOString() : null,
    needsReconnect,
    error
  };
}

/** Read-only, serializable connection details. No tokens or fingerprints leave this module. */
export async function getInstagramTokenStatus(env: InstagramTokenEnv, now = Date.now()): Promise<InstagramTokenStatus> {
  return safeStatus(await readRow(env, await fingerprint(env)), now);
}

/** Every outbound request resolves the current token; a refreshed token is never cached globally. */
export async function getInstagramAccessToken(env: InstagramTokenEnv, now = Date.now()): Promise<string> {
  const row = await readRow(env, await fingerprint(env));
  // No matching row means an initial install or a manually replaced Cloudflare secret.
  if (!row) return seedValue(env);
  const status = safeStatus(row, now);
  if (status.needsReconnect) throw new TokenError(status.error ?? "Reconnect the Instagram account.", true);
  return decryptToken(env, row);
}

function graphBase(env: InstagramTokenEnv): URL {
  try {
    const url = new URL(env.GRAPH_API_BASE);
    if (url.protocol !== "https:" || !GRAPH_HOSTS.has(url.hostname) || url.port ||
        url.username || url.password || url.search || url.hash || !/^\/v\d+\.\d+\/?$/.test(url.pathname)) {
      throw new Error("Unexpected Graph API URL");
    }
    return url;
  } catch {
    throw new TokenError("Token renewal requires the official Instagram Graph API address.");
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new TokenError("Meta returned an empty response. It will try again tomorrow.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TokenError("Meta returned an unexpected response. It will try again tomorrow.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid response");
    return result as Record<string, unknown>;
  } catch {
    throw new TokenError("Meta returned an unexpected response. It will try again tomorrow.");
  }
}

async function graphRequest(url: URL, token?: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      redirect: "manual",
      signal: controller.signal
    });
    // Workers supports manual/follow only. Never forward credentials to a redirect destination.
    if (response.status >= 300 && response.status < 400) {
      throw new TokenError("Meta returned an unexpected redirect. It will try again tomorrow.");
    }
    const body = await readJson(response);
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : null;
    if (error?.code === 190 || error?.code === 102 || response.status === 401) {
      throw new TokenError("Meta rejected the Instagram token. Reconnect the account.", true);
    }
    if (!response.ok || error) {
      throw new TokenError("Meta could not check or renew the token. It will try again tomorrow.");
    }
    return body;
  } catch (error) {
    if (error instanceof TokenError) throw error;
    // Native fetch errors can contain the request URL, including refresh credentials.
    throw new TokenError("Meta could not be reached. It will try again tomorrow.");
  } finally {
    clearTimeout(timeout);
  }
}

/** Daily maintenance, also safe to call from an authenticated connection check. */
export async function maintainInstagramAccessToken(env: InstagramTokenEnv, now = Date.now()): Promise<InstagramTokenStatus> {
  const seedFingerprint = await fingerprint(env);
  const initialCiphertext = await encryptToken(env, seedFingerprint, seedValue(env));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO instagram_tokens
      (seed_fingerprint, token_ciphertext, first_observed_at, next_refresh_at)
     VALUES (?, ?, ?, ?)`
  ).bind(seedFingerprint, initialCiphertext, now, now + FIRST_REFRESH_DELAY).run();

  const owner = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE instagram_tokens SET lease_owner = ?, lease_until = ?
     WHERE seed_fingerprint = ? AND (lease_until IS NULL OR lease_until <= ?)`
  ).bind(owner, now + LEASE_DURATION, seedFingerprint, now).run();
  if (claim.meta.changes !== 1) return getInstagramTokenStatus(env, now);

  const row = await readRow(env, seedFingerprint);
  if (!row) throw new TokenError("The Instagram connection record is missing.");
  try {
    if (row.expires_at != null && row.expires_at <= now) {
      throw new TokenError("The Instagram token expired. Reconnect the account.", true);
    }
    const base = graphBase(env);
    const token = await decryptToken(env, row);
    const systemUser = base.hostname === "graph.facebook.com";
    const identityUrl = new URL(`${base.href.replace(/\/$/, "")}/${systemUser ? encodeURIComponent(env.IG_USER_ID) : "me"}`);
    identityUrl.searchParams.set("fields", systemUser ? "username" : "user_id,username");
    const identity = await graphRequest(identityUrl, token);
    if (String(systemUser ? identity.id ?? "" : identity.user_id ?? "") !== env.IG_USER_ID) {
      throw new TokenError("This token belongs to a different Instagram account. Reconnect the correct account.", true);
    }
    const username = typeof identity.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(identity.username)
      ? identity.username : null;
    const tokenObservedAt = row.last_refreshed_at ?? row.first_observed_at;
    // Even a manually triggered check cannot renew a token during its first day.
    if (!systemUser && now >= row.next_refresh_at && now >= tokenObservedAt + DAY) {
      const refreshUrl = new URL("https://graph.instagram.com/refresh_access_token");
      refreshUrl.searchParams.set("grant_type", "ig_refresh_token");
      refreshUrl.searchParams.set("access_token", token);
      const renewed = await graphRequest(refreshUrl);
      if (typeof renewed.access_token !== "string" || !renewed.access_token || renewed.access_token.length > 8192 ||
          typeof renewed.expires_in !== "number" || !Number.isSafeInteger(renewed.expires_in) ||
          renewed.expires_in <= 0 || renewed.expires_in > 366 * 24 * 60 * 60) {
        throw new TokenError("Meta returned an unexpected renewal response. It will try again tomorrow.");
      }
      const lifetime = renewed.expires_in * 1000;
      const expiresAt = now + lifetime;
      const nextRefreshAt = now + Math.max(DAY, Math.min(REFRESH_INTERVAL, Math.floor(lifetime / 2)));
      const ciphertext = await encryptToken(env, seedFingerprint, renewed.access_token);
      await env.DB.prepare(
        `UPDATE instagram_tokens SET token_ciphertext = ?, last_checked_at = ?, last_refreshed_at = ?,
         next_refresh_at = ?, expires_at = ?, username = ?, needs_reconnect = 0, safe_error = NULL,
         lease_owner = NULL, lease_until = NULL WHERE seed_fingerprint = ? AND lease_owner = ?`
      ).bind(ciphertext, now, now, nextRefreshAt, expiresAt, username, seedFingerprint, owner).run();
    } else {
      await env.DB.prepare(
        `UPDATE instagram_tokens SET last_checked_at = ?, username = ?, needs_reconnect = 0, safe_error = NULL,
         lease_owner = NULL, lease_until = NULL WHERE seed_fingerprint = ? AND lease_owner = ?`
      ).bind(now, username, seedFingerprint, owner).run();
    }
  } catch (error) {
    const safeError = error instanceof TokenError ? error :
      new TokenError("The token check could not finish. It will try again tomorrow.");
    // Preserve the last working ciphertext and expiry after transient failures.
    await env.DB.prepare(
      `UPDATE instagram_tokens SET last_checked_at = ?, needs_reconnect = ?, safe_error = ?,
       next_refresh_at = CASE WHEN next_refresh_at <= ? THEN ? ELSE next_refresh_at END,
       lease_owner = NULL, lease_until = NULL WHERE seed_fingerprint = ? AND lease_owner = ?`
    ).bind(now, safeError.needsReconnect || row.needs_reconnect ? 1 : 0,
      row.needs_reconnect && !safeError.needsReconnect ? row.safe_error ?? safeError.message : safeError.message,
      now, now + DAY, seedFingerprint, owner).run();
  }
  return getInstagramTokenStatus(env, now);
}
