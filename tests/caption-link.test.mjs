import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildModule, buildWorker, commentPayload, createHarness, createRule } from "./worker-harness.mjs";

// {link} in a reply becomes the link to the allowed host found in the post caption.
let built;
let linker;
before(async () => {
  built = await buildWorker();
  linker = await buildModule("src/caption-link.ts");
});
after(async () => {
  await built?.dispose();
  await linker?.dispose();
});

const HOST = "keukenliefde.nl";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("only links to the allowed host are taken from a caption", () => {
  const { extractCaptionLink, fillLink } = linker.module;
  const yes = [
    ["Reageer met recept! keukenliefde.nl/recept/appeltaart", "https://keukenliefde.nl/recept/appeltaart"],
    ["Het recept staat op https://www.keukenliefde.nl/recept/soep.", "https://www.keukenliefde.nl/recept/soep"],
    ["Link: (http://keukenliefde.nl/x?y=1#z)", "https://keukenliefde.nl/x?y=1#z"],
    ["Eerst iets anders https://example.com en dan KEUKENLIEFDE.NL/a", "https://keukenliefde.nl/a"],
    ["twee links keukenliefde.nl/een keukenliefde.nl/twee", "https://keukenliefde.nl/een"],
    ["Staat op Keukenliefde.nl, of klik op de link in bio. Recept: https://www.keukenliefde.nl/zelfgemaakte-friet/", "https://www.keukenliefde.nl/zelfgemaakte-friet/"],
  ];
  for (const [caption, expected] of yes) assert.equal(extractCaptionLink(caption, HOST), expected, caption);
  const no = [
    "geen link hier", "https://example.com/keukenliefde.nl", "keukenliefde.nl.evil.com/recept", "evilkeukenliefde.nl/recept",
    "https://keukenliefde.nl@evil.com/recept", "@keukenliefde.nl", "", null, undefined,
    "Het recept vind je op Keukenliefde.nl, of klik op de link in bio.", "https://www.keukenliefde.nl/",
  ];
  for (const caption of no) assert.equal(extractCaptionLink(caption, HOST), null, String(caption));
  assert.equal(extractCaptionLink("keukenliefde.nl/a", undefined), null);
  assert.equal(fillLink("Recept: {link} en nogmaals {link}", "https://keukenliefde.nl/a"), "Recept: https://keukenliefde.nl/a en nogmaals https://keukenliefde.nl/a");
  assert.equal(fillLink("Geen plaatshouder", "https://keukenliefde.nl/a"), "Geen plaatshouder");
});

async function fixture(t, caption, { mediaStatus = 200, rule = {}, overrides = {} } = {}) {
  const h = await createHarness(built.worker, { CAPTION_LINK_HOST: HOST, KEYWORD: "", ...overrides });
  t.after(() => h.dispose());
  h.setResponder((call) => call.method === "GET" && call.url.pathname.endsWith("/media-1")
    ? json(mediaStatus === 200 ? { caption, id: "media-1" } : { error: { message: "boom" } }, mediaStatus)
    : json({ message_id: "outgoing-test-id" }));
  const cookie = await h.login();
  await createRule(h, cookie, { label: "Recept", keywords: "recept", reply_text: "Hier is het recept: {link}", channels: ["comments"], ...rule });
  return h;
}

const sends = (h) => h.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/messages"));
const lookups = (h) => h.calls.filter((call) => call.method === "GET" && call.url.pathname.endsWith("/media-1"));

test("the DM carries the link from the post caption", async (t) => {
  const h = await fixture(t, "Appeltaart! Reageer met recept. keukenliefde.nl/recept/appeltaart");
  await h.webhook(commentPayload("c-1", "Recept!"));
  assert.equal(lookups(h).length, 1);
  assert.equal(lookups(h)[0].url.searchParams.get("fields"), "caption");
  assert.equal(sends(h).length, 1);
  assert.equal(sends(h)[0].body.message.text, "Hier is het recept: https://keukenliefde.nl/recept/appeltaart");
});

test("a rule with a button points the button at the caption link", async (t) => {
  const h = await fixture(t, "keukenliefde.nl/recept/soep", {
    rule: { reply_text: "Hier is je recept.", link_url: "https://keukenliefde.nl/alle-recepten/", link_button_label: "Naar het recept" },
  });
  await h.webhook(commentPayload("c-2", "recept"));
  const button = sends(h)[0].body.message.attachment.payload.buttons[0];
  assert.equal(button.url, "https://keukenliefde.nl/recept/soep");
});

test("without a link in the caption the rule's link, then the homepage, is used", async (t) => {
  const withRuleLink = await fixture(t, "Een post zonder link", {
    rule: { link_url: "https://keukenliefde.nl/alle-recepten/", link_button_label: "Alle recepten" },
  });
  await withRuleLink.webhook(commentPayload("c-3", "recept"));
  assert.equal(sends(withRuleLink)[0].body.message.attachment.payload.text, "Hier is het recept: https://keukenliefde.nl/alle-recepten/");

  const homepage = await fixture(t, "Een lookalike keukenliefde.nl.evil.com/recept");
  await homepage.webhook(commentPayload("c-4", "recept"));
  assert.equal(sends(homepage)[0].body.message.text, "Hier is het recept: https://keukenliefde.nl/");
});

test("a failed caption lookup never blocks the DM", async (t) => {
  const h = await fixture(t, null, { mediaStatus: 500 });
  await h.webhook(commentPayload("c-5", "recept"));
  assert.equal(sends(h).length, 1);
  assert.equal(sends(h)[0].body.message.text, "Hier is het recept: https://keukenliefde.nl/");
  assert.equal(h.query("SELECT status FROM comment_events WHERE comment_id = ?", "c-5").status, "sent");
});

test("the feature is off without CAPTION_LINK_HOST and in test mode nothing is sent", async (t) => {
  const off = await fixture(t, "keukenliefde.nl/recept/x", { overrides: { CAPTION_LINK_HOST: "" } });
  await off.webhook(commentPayload("c-6", "recept"));
  assert.equal(lookups(off).length, 0);
  assert.equal(sends(off)[0].body.message.text, "Hier is het recept: ");

  const dry = await fixture(t, "keukenliefde.nl/recept/x", { overrides: { DRY_RUN: "true" } });
  await dry.webhook(commentPayload("c-7", "recept"));
  assert.equal(sends(dry).length, 0);
  assert.equal(dry.query("SELECT status FROM comment_events WHERE comment_id = ?", "c-7").status, "dry_run_matched");
});
