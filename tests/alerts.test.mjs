import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildModule, buildWorker, commentPayload, createHarness, createRule } from "./worker-harness.mjs";

// Telegram alerts for failed DMs and a broken Instagram connection, and the daily
// deletion of old comments and DMs.
let built;
let retention;
before(async () => {
  built = await buildWorker();
  retention = await buildModule("src/retention.ts");
});
after(async () => {
  await built?.dispose();
  await retention?.dispose();
});

const TELEGRAM = { TELEGRAM_BOT_TOKEN: "test-telegram-token", TELEGRAM_CHAT_ID: "12345" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const alerts = (h) => h.calls.filter((call) => call.url.host === "api.telegram.org");
const day = 24 * 60 * 60 * 1000;

async function fixture(t, overrides = {}, responder) {
  const h = await createHarness(built.worker, { KEYWORD: "", ...overrides });
  t.after(() => h.dispose());
  h.setResponder(responder ?? ((call) => call.url.host === "api.telegram.org" ? json({ ok: true }) : json({ error: { message: "nope" } }, 500)));
  const cookie = await h.login();
  await createRule(h, cookie, { label: "Recept", keywords: "recept", reply_text: "Hier is het recept.", channels: ["comments"] });
  return h;
}

test("a failed DM sends one Telegram alert per cooldown", async (t) => {
  const h = await fixture(t, TELEGRAM);
  await h.webhook(commentPayload("c-1", "recept", "reader-one"));
  await h.webhook(commentPayload("c-2", "recept", "reader-two"));
  assert.equal(h.query("SELECT status FROM comment_events WHERE comment_id = ?", "c-1").status, "send_error");
  assert.equal(alerts(h).length, 1);
  const [alert] = alerts(h);
  assert.equal(alert.url.pathname, "/bottest-telegram-token/sendMessage");
  assert.equal(alert.body.chat_id, "12345");
  assert.match(alert.body.text, /DM kon niet worden verstuurd/);
  assert.equal(alert.body.text.includes("reader-one"), false);
});

test("nothing is sent to Telegram without its secrets, and an alert failure changes nothing", async (t) => {
  const quiet = await fixture(t);
  await quiet.webhook(commentPayload("c-3", "recept"));
  assert.equal(alerts(quiet).length, 0);
  assert.equal(quiet.query("SELECT status FROM comment_events WHERE comment_id = ?", "c-3").status, "send_error");

  const broken = await fixture(t, TELEGRAM, () => json({ error: { message: "nope" } }, 500));
  await broken.webhook(commentPayload("c-4", "recept"));
  assert.equal(alerts(broken).length, 1);
  assert.equal(broken.query("SELECT status FROM comment_events WHERE comment_id = ?", "c-4").status, "send_error");
});

test("a broken Instagram connection sends an alert from the daily check", async (t) => {
  const h = await fixture(t, TELEGRAM, (call) => call.url.host === "api.telegram.org"
    ? json({ ok: true })
    : json({ error: { message: "Session has expired" } }, 401));
  await assert.rejects(() => built.worker.scheduled({ scheduledTime: Date.now(), cron: "0 6 * * *" }, h.env));
  assert.equal(alerts(h).length, 1);
  assert.match(alerts(h)[0].body.text, /Instagram-koppeling/);
  assert.equal(alerts(h)[0].body.text.includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
});

test("old comments and DMs are deleted by the daily run, recent ones stay", async (t) => {
  const h = await fixture(t, { DRY_RUN: "true" });
  const at = (days) => new Date(Date.now() - days * day).toISOString();
  for (const [id, days] of [["old", 31], ["recent", 29]]) {
    await h.db.prepare("INSERT INTO comment_events (comment_id, username, comment_text, status, received_at) VALUES (?, 'someone', 'recept', 'sent', ?)").bind(id, at(days)).run();
    await h.db.prepare("INSERT INTO message_events (message_id, sender_id, message_text, status, received_at) VALUES (?, 'sender', 'hoi', 'sent', ?)").bind(id, at(days)).run();
  }
  await built.worker.scheduled({ scheduledTime: Date.now(), cron: "0 6 * * *" }, h.env);
  assert.deepEqual(h.queryAll("SELECT comment_id FROM comment_events").map((row) => row.comment_id), ["recent"]);
  assert.deepEqual(h.queryAll("SELECT message_id FROM message_events").map((row) => row.message_id), ["recent"]);
  assert.equal(h.calls.length, 0);
});

test("RETENTION_DAYS 0 keeps everything and a bad value falls back to 30 days", async (t) => {
  const { retentionDays } = retention.module;
  assert.equal(retentionDays("0"), 0);
  assert.equal(retentionDays("14"), 14);
  assert.equal(retentionDays(undefined), 30);
  assert.equal(retentionDays(""), 30);
  assert.equal(retentionDays("abc"), 30);
  assert.equal(retentionDays("-5"), 30);
  assert.equal(retentionDays("1.5"), 30);

  const h = await fixture(t, { DRY_RUN: "true", RETENTION_DAYS: "0" });
  await h.db.prepare("INSERT INTO comment_events (comment_id, status, received_at) VALUES ('ancient', 'sent', ?)").bind(new Date(Date.now() - 400 * day).toISOString()).run();
  await built.worker.scheduled({ scheduledTime: Date.now(), cron: "0 6 * * *" }, h.env);
  assert.equal(h.queryAll("SELECT comment_id FROM comment_events").length, 1);
});
