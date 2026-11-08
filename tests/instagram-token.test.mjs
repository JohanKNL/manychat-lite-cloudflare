import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildModule, createHarness } from "./worker-harness.mjs";

// Unit tests for src/instagram-token.ts against the real migrations and a mocked Meta API.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 7);
let token;
let built;
before(async () => {
  built = await buildModule("src/instagram-token.ts");
  token = built.module;
});
after(async () => { await built?.dispose(); });

async function fixture(t) {
  const h = await createHarness({}, { GRAPH_API_BASE: "https://graph.instagram.com/v25.0" });
  t.after(() => h.dispose());
  h.setResponder((call) => call.url.pathname.endsWith("/me")
    ? Response.json({ user_id: h.env.IG_USER_ID, username: "test_owner" })
    : Response.json({ access_token: "renewed-instagram-token", token_type: "bearer", expires_in: 60 * 24 * 60 * 60 }));
  return h;
}

function saved(h) {
  return h.query("SELECT * FROM instagram_tokens ORDER BY first_observed_at DESC LIMIT 1");
}

function refreshCalls(h) {
  return h.calls.filter((call) => call.url.pathname === "/refresh_access_token");
}

test("bootstrap checks account identity and encrypts the token without claiming an unknown expiry", async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await token.getInstagramTokenStatus(h.env, NOW), {
    state: "pending", username: null, lastCheckedAt: null, lastRefreshedAt: null,
    nextRefreshAt: null, expiresAt: null, needsReconnect: false, error: null,
  });
  assert.equal(await token.getInstagramAccessToken(h.env, NOW), h.env.INSTAGRAM_ACCESS_TOKEN);
  assert.equal(h.calls.length, 0, "Read-only status and send token lookup must not call Meta");
  const status = await token.maintainInstagramAccessToken(h.env, NOW);
  assert.equal(status.state, "healthy");
  assert.equal(status.username, "test_owner");
  assert.equal(status.expiresAt, null, "Bootstrap token's remaining lifetime is unknown");
  assert.equal(status.lastCheckedAt, new Date(NOW).toISOString());
  assert.equal(status.nextRefreshAt, new Date(NOW + 2 * DAY).toISOString());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.pathname, "/v25.0/me");
  assert.equal(h.calls[0].url.searchParams.get("fields"), "user_id,username");
  assert.equal(h.calls[0].headers.get("authorization"), `Bearer ${h.env.INSTAGRAM_ACCESS_TOKEN}`);
  assert.match(saved(h).token_ciphertext, /^v1\.[^.]+\.[^.]+$/);
  assert.equal(JSON.stringify(saved(h)).includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  assert.equal(await token.getInstagramAccessToken(h.env, NOW), h.env.INSTAGRAM_ACCESS_TOKEN);
});

test("the first 24 hours cannot refresh, and daily checks continue before a renewal is due", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  await h.db.prepare("UPDATE instagram_tokens SET next_refresh_at = ?").bind(NOW).run();
  await token.maintainInstagramAccessToken(h.env, NOW + DAY - 1);
  assert.equal(refreshCalls(h).length, 0, "A premature due date cannot bypass Meta's minimum age");
  await h.db.prepare("UPDATE instagram_tokens SET next_refresh_at = ?").bind(NOW + 2 * DAY).run();
  await token.maintainInstagramAccessToken(h.env, NOW + DAY);
  assert.equal(refreshCalls(h).length, 0);
  assert.equal(h.calls.length, 3, "Each maintenance run still validates /me");
});

test("renewal persists encrypted credentials, uses Meta's expiry, and sends use the replacement", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  const refreshedAt = NOW + 2 * DAY;
  const status = await token.maintainInstagramAccessToken(h.env, refreshedAt);
  assert.equal(refreshCalls(h).length, 1);
  assert.equal(refreshCalls(h)[0].url.origin, "https://graph.instagram.com");
  assert.equal(refreshCalls(h)[0].url.searchParams.get("grant_type"), "ig_refresh_token");
  assert.equal(refreshCalls(h)[0].url.searchParams.get("access_token"), h.env.INSTAGRAM_ACCESS_TOKEN);
  assert.equal(status.lastRefreshedAt, new Date(refreshedAt).toISOString());
  assert.equal(status.expiresAt, new Date(refreshedAt + 60 * DAY).toISOString());
  assert.equal(status.nextRefreshAt, new Date(refreshedAt + 30 * DAY).toISOString());
  assert.equal(await token.getInstagramAccessToken(h.env, refreshedAt), "renewed-instagram-token");
  for (const secret of [h.env.INSTAGRAM_ACCESS_TOKEN, "renewed-instagram-token"]) {
    assert.equal(JSON.stringify(saved(h)).includes(secret), false);
    assert.equal(JSON.stringify(status).includes(secret), false);
  }
  await token.maintainInstagramAccessToken(h.env, refreshedAt + DAY);
  assert.equal(h.calls.at(-1).headers.get("authorization"), "Bearer renewed-instagram-token");
  assert.equal(refreshCalls(h).length, 1, "Daily health check does not needlessly renew");
});

test("a temporary renewal error retains the working token and exact expiry, then retries tomorrow", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  await token.maintainInstagramAccessToken(h.env, NOW + 2 * DAY);
  const previous = saved(h);
  const failedAt = NOW + 32 * DAY;
  h.setResponder((call) => call.url.pathname.endsWith("/me")
    ? Response.json({ user_id: h.env.IG_USER_ID, username: "test_owner" })
    : Response.json({ error: { code: 2, message: "raw-sensitive-provider-response" } }, { status: 503 }));
  const failed = await token.maintainInstagramAccessToken(h.env, failedAt);
  assert.equal(failed.state, "error");
  assert.equal(failed.needsReconnect, false);
  assert.equal(failed.nextRefreshAt, new Date(failedAt + DAY).toISOString());
  assert.equal(saved(h).token_ciphertext, previous.token_ciphertext);
  assert.equal(saved(h).expires_at, previous.expires_at);
  assert.equal(await token.getInstagramAccessToken(h.env, failedAt), "renewed-instagram-token");
  assert.equal(JSON.stringify(failed).includes("raw-sensitive"), false);
  h.setResponder((call) => call.url.pathname.endsWith("/me")
    ? Response.json({ user_id: h.env.IG_USER_ID, username: "test_owner" })
    : Response.json({ access_token: "renewed-twice", expires_in: 5183944 }));
  const recovered = await token.maintainInstagramAccessToken(h.env, failedAt + DAY);
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.error, null);
  assert.equal(recovered.expiresAt, new Date(failedAt + DAY + 5183944 * 1000).toISOString());
  assert.equal(await token.getInstagramAccessToken(h.env, failedAt + DAY), "renewed-twice");
  assert.equal(refreshCalls(h).at(-1).url.searchParams.get("access_token"), "renewed-instagram-token");
});

test("expired or revoked tokens require reconnect without falling back to the seed secret", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  await token.maintainInstagramAccessToken(h.env, NOW + 2 * DAY);
  h.setResponder(() => Response.json({ error: { code: 190, message: `Expired ${h.env.INSTAGRAM_ACCESS_TOKEN}` } }, { status: 400 }));
  const revoked = await token.maintainInstagramAccessToken(h.env, NOW + 3 * DAY);
  assert.equal(revoked.state, "reconnect");
  assert.equal(revoked.needsReconnect, true);
  assert.equal(revoked.nextRefreshAt, null);
  assert.equal(JSON.stringify(revoked).includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  await assert.rejects(token.getInstagramAccessToken(h.env, NOW + 3 * DAY), /Reconnect/);
  await h.db.prepare("UPDATE instagram_tokens SET needs_reconnect = 0, safe_error = NULL").run();
  const expired = await token.getInstagramTokenStatus(h.env, NOW + 62 * DAY);
  assert.equal(expired.state, "reconnect");
  assert.match(expired.error, /expired/);
  const calls = h.calls.length;
  await assert.rejects(token.getInstagramAccessToken(h.env, NOW + 62 * DAY), /expired/);
  await token.maintainInstagramAccessToken(h.env, NOW + 62 * DAY);
  assert.equal(h.calls.length, calls, "Known expired credentials are never sent back to Meta");
});

test("a rotated Cloudflare secret starts fresh without decrypting or overwriting the previous secret's state", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  await token.maintainInstagramAccessToken(h.env, NOW + 2 * DAY);
  const oldRow = saved(h);
  const rotated = { ...h.env, INSTAGRAM_ACCESS_TOKEN: "manually-regenerated-token" };
  assert.equal((await token.getInstagramTokenStatus(rotated, NOW + 3 * DAY)).state, "pending");
  assert.equal(await token.getInstagramAccessToken(rotated, NOW + 3 * DAY), rotated.INSTAGRAM_ACCESS_TOKEN);
  const status = await token.maintainInstagramAccessToken(rotated, NOW + 3 * DAY);
  assert.equal(status.state, "healthy");
  assert.equal(h.query("SELECT COUNT(*) AS count FROM instagram_tokens").count, 2);
  assert.deepEqual(h.query("SELECT * FROM instagram_tokens WHERE seed_fingerprint = ?", oldRow.seed_fingerprint), oldRow);
  assert.equal(await token.getInstagramAccessToken(rotated, NOW + 3 * DAY), rotated.INSTAGRAM_ACCESS_TOKEN);
  assert.equal(await token.getInstagramAccessToken(h.env, NOW + 3 * DAY), "renewed-instagram-token");
});

test("overlapping maintenance claims can issue only one renewal", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const identityStarted = new Promise((resolve) => { entered = resolve; });
  h.setResponder(async (call) => {
    if (call.url.pathname.endsWith("/me")) {
      entered();
      await blocked;
      return Response.json({ user_id: h.env.IG_USER_ID, username: "test_owner" });
    }
    return Response.json({ access_token: "concurrent-renewal-token", expires_in: 60 * 24 * 60 * 60 });
  });
  const first = token.maintainInstagramAccessToken(h.env, NOW + 2 * DAY);
  await identityStarted;
  const second = await token.maintainInstagramAccessToken(h.env, NOW + 2 * DAY);
  assert.equal(second.lastRefreshedAt, null);
  assert.equal(refreshCalls(h).length, 0);
  release();
  await first;
  assert.equal(refreshCalls(h).length, 1);
  assert.equal(await token.getInstagramAccessToken(h.env, NOW + 2 * DAY), "concurrent-renewal-token");
  assert.equal(saved(h).lease_owner, null);
});

test("wrong-account credentials are blocked before renewal", async (t) => {
  const h = await fixture(t);
  h.setResponder(() => Response.json({ user_id: "another-instagram-account", username: "someone_else" }));
  const status = await token.maintainInstagramAccessToken(h.env, NOW);
  assert.equal(status.state, "reconnect");
  assert.match(status.error, /different Instagram account/);
  assert.equal(refreshCalls(h).length, 0);
  await assert.rejects(token.getInstagramAccessToken(h.env, NOW), /different Instagram account/);
});

test("corrupted encrypted state cannot silently fall back to a stale bootstrap secret", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  await h.db.prepare("UPDATE instagram_tokens SET token_ciphertext = 'v1.invalid.invalid'").run();
  await assert.rejects(token.getInstagramAccessToken(h.env, NOW), /could not be read/);
  const calls = h.calls.length;
  const status = await token.maintainInstagramAccessToken(h.env, NOW + DAY);
  assert.equal(status.state, "reconnect");
  assert.equal(h.calls.length, calls);
});

test("renewal rejects nonofficial API hosts and redacts transport errors", async (t) => {
  const h = await fixture(t);
  const badHost = { ...h.env, GRAPH_API_BASE: "https://graph.instagram.com.evil.example/v25.0" };
  const rejected = await token.maintainInstagramAccessToken(badHost, NOW);
  assert.equal(rejected.state, "error");
  assert.equal(h.calls.length, 0);
  h.setResponder(() => { throw new Error(`Sensitive transport failure: ${h.env.INSTAGRAM_ACCESS_TOKEN}`); });
  const unavailable = await token.maintainInstagramAccessToken(h.env, NOW + DAY);
  assert.equal(unavailable.state, "error");
  assert.match(unavailable.error, /could not be reached/);
  assert.equal(JSON.stringify(unavailable).includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
});

test("a transient check failure cannot re-enable a token already rejected by Meta", async (t) => {
  const h = await fixture(t);
  h.setResponder(() => Response.json({ error: { code: 190 } }, { status: 400 }));
  const rejected = await token.maintainInstagramAccessToken(h.env, NOW);
  assert.equal(rejected.needsReconnect, true);
  h.setResponder(() => Response.json({ error: { code: 2 } }, { status: 503 }));
  const failedCheck = await token.maintainInstagramAccessToken(h.env, NOW + DAY);
  assert.equal(failedCheck.needsReconnect, true);
  assert.equal(failedCheck.error, rejected.error);
  await assert.rejects(token.getInstagramAccessToken(h.env, NOW + DAY), /Reconnect/);
  h.setResponder(() => Response.json({ user_id: h.env.IG_USER_ID, username: "test_owner" }));
  const recovered = await token.maintainInstagramAccessToken(h.env, NOW + DAY + 1);
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.needsReconnect, false);
  assert.equal(await token.getInstagramAccessToken(h.env, NOW + DAY + 1), h.env.INSTAGRAM_ACCESS_TOKEN);
});

test("an overdue daily check is visible without disabling a token with time left", async (t) => {
  const h = await fixture(t);
  await token.maintainInstagramAccessToken(h.env, NOW);
  const overdue = await token.getInstagramTokenStatus(h.env, NOW + 4 * DAY);
  assert.equal(overdue.state, "error");
  assert.match(overdue.error, /overdue/);
  assert.equal(overdue.needsReconnect, false);
  assert.equal(await token.getInstagramAccessToken(h.env, NOW + 4 * DAY), h.env.INSTAGRAM_ACCESS_TOKEN);
});

test("Graph redirects are rejected without forwarding credentials or exposing the destination", async (t) => {
  const h = await fixture(t);
  const mockedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(init.redirect, "manual", "The Workers runtime supports manual or follow redirects");
    return mockedFetch(input, init);
  };
  const destination = `https://untrusted.example/${h.env.INSTAGRAM_ACCESS_TOKEN}`;
  h.setResponder(() => new Response(null, { status: 302, headers: { location: destination } }));
  const status = await token.maintainInstagramAccessToken(h.env, NOW);
  assert.equal(status.state, "error");
  assert.match(status.error, /unexpected redirect/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.hostname, "graph.instagram.com");
  assert.equal(JSON.stringify(status).includes(destination), false);
  assert.equal(JSON.stringify(saved(h)).includes(destination), false);
});

test("a system-user token on graph.facebook.com is checked against the account and never renewed", async (t) => {
  const h = await createHarness({}, { GRAPH_API_BASE: "https://graph.facebook.com/v25.0" });
  t.after(() => h.dispose());
  h.setResponder(() => Response.json({ id: h.env.IG_USER_ID, username: "test_owner" }));
  await token.maintainInstagramAccessToken(h.env, NOW);
  await h.db.prepare("UPDATE instagram_tokens SET next_refresh_at = ?").bind(NOW).run();
  const status = await token.maintainInstagramAccessToken(h.env, NOW + 3 * DAY);
  assert.equal(status.state, "healthy");
  assert.equal(status.username, "test_owner");
  assert.equal(status.expiresAt, null);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(call.url.host, "graph.facebook.com");
    assert.equal(call.url.pathname, `/v25.0/${h.env.IG_USER_ID}`);
    assert.equal(call.url.searchParams.get("fields"), "username");
  }
  assert.equal(await token.getInstagramAccessToken(h.env, NOW + 3 * DAY), h.env.INSTAGRAM_ACCESS_TOKEN);
});

test("a system-user token for another Instagram account asks to reconnect", async (t) => {
  const h = await createHarness({}, { GRAPH_API_BASE: "https://graph.facebook.com/v25.0" });
  t.after(() => h.dispose());
  h.setResponder(() => Response.json({ id: "999", username: "someone_else" }));
  const status = await token.maintainInstagramAccessToken(h.env, NOW);
  assert.equal(status.state, "reconnect");
  assert.equal(status.needsReconnect, true);
});
