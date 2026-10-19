// Tests for the account of API.md 3: sign-up as a data partner, the partner
// key, the file upload, the review by the operator, and sign-out.
//
// Run from openpinsheet/:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";

import worker, { reviewMessage } from "../src/worker.js";
import { addChannel, addKey, createEnv, hashKey } from "./fakes.mjs";

const BASE = "https://api.openpinsheet.com";
const NOW = "2027-04-12T12:00:00Z";
const DATE = "2027-04-12";
const SECRET = "test-review-secret";

function setup(now = NOW) {
  const env = createEnv(now);
  env.REVIEW_SECRET = SECRET;
  addChannel(env, "openyardage", "OpenYardage");
  addKey(env, "openyardage", "opp_openyardage_key", 1);
  return env;
}

function fakeGithub(t, id = 7777, login = "octo") {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_token" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id, login });
    }
    throw new Error("unexpected fetch to " + url);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

async function login(env) {
  env.DB.startInvocation();
  const response = await worker.fetch(new Request(BASE + "/v1/auth/github/callback?code=abc&state=st", {
    headers: { Cookie: "ops_state=st" },
  }), env);
  const line = response.headers.getSetCookie().find((value) => value.startsWith("ops_session="));
  const body = await response.text();
  return {
    cookie: "ops_session=" + /^ops_session=([^;]+)/.exec(line)[1],
    csrf: /name="csrf" value="([^"]+)"/.exec(body)[1],
  };
}

function postForm(env, path, session, fields) {
  env.DB.startInvocation();
  return worker.fetch(new Request(BASE + path, {
    method: "POST",
    headers: { Cookie: session.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.assign({ csrf: session.csrf }, fields)).toString(),
  }), env);
}

async function signUp(env, session, name = "Golfclub Wannsee") {
  const response = await postForm(env, "/v1/account/partner", session, {
    name, website: "https://gc.example", terms: "yes",
  });
  const body = await response.text();
  const match = /opp_[A-Za-z0-9_-]{43}/.exec(body);
  return { response, body, key: match ? match[0] : null };
}

function submit(env, key, group, date = DATE) {
  env.DB.startInvocation();
  return worker.fetch(new Request(BASE + "/v1/submissions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ format: 1, group, date, pins: [{ hole: "1", lat: 52.1, lon: 13.1, source: "mapped" }] }),
  }), env);
}

test("the account without a session asks to sign in with GitHub", async () => {
  const env = setup();
  env.DB.startInvocation();
  const response = await worker.fetch(new Request(BASE + "/v1/account"), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /href="\/v1\/auth\/github"/);
});

test("signing up makes a partner waiting for review and a key that delivers", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  const { response, key } = await signUp(env, session);
  assert.equal(response.status, 200);
  assert.ok(key, "no partner key on the page");

  const channel = await env.DB.prepare(
    "SELECT id, name, website, github_id, login, terms, archive_from FROM channels WHERE github_id = 7777",
  ).first();
  assert.deepEqual(channel, {
    id: "golfclub-wannsee", name: "Golfclub Wannsee", website: "https://gc.example/",
    github_id: 7777, login: "octo", terms: NOW.replace("Z", ".000Z"), archive_from: null,
  });
  const keyRow = await env.DB.prepare("SELECT channel, active, prefix FROM keys WHERE key_sha256 = ?")
    .bind(hashKey(key)).first();
  assert.deepEqual(keyRow, { channel: "golfclub-wannsee", active: 1, prefix: key.slice(0, 12) });

  const delivered = await submit(env, key, "g1");
  assert.equal(delivered.status, 200);
});

test("the channel id from a partner name passes FORMAT.md 5, leading digits dropped", async (t) => {
  // The rule of tools/validate.py, CHANNEL_RE. Until 19.10.2026 it allowed no
  // "-", and every id built here from a name of two words failed the files.
  const rule = /^(?=.{2,40}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  const { response } = await signUp(env, session, "1. Golfclub  Berlin-Wannsee e.V.");
  assert.equal(response.status, 200);
  const row = await env.DB.prepare("SELECT id FROM channels WHERE github_id = 7777").first();
  assert.equal(row.id, "golfclub-berlin-wannsee-e-v");
  assert.match(row.id, rule);
});

test("without the licence, with a taken or a reserved name, nobody becomes a partner", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  const noTerms = await postForm(env, "/v1/account/partner", session, { name: "Club A" });
  assert.match(await noTerms.text(), /accept the licence/);
  const taken = await signUp(env, session, "openyardage");
  assert.equal(taken.key, null);
  assert.match(taken.body, /is taken/);
  const reserved = await signUp(env, session, "Test");
  assert.equal(reserved.key, null);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM channels").first();
  assert.equal(count.n, 1);
});

test("a partner waiting for review delivers at most 20 grounds a day, replacing one is fine", async (t) => {
  const env = setup();
  fakeGithub(t);
  const { key } = await signUp(env, await login(env));
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await submit(env, key, "g" + index)).status, 200);
  }
  const over = await submit(env, key, "g20");
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, "partner_limit");
  assert.equal((await submit(env, key, "g3")).status, 200);
  // A reviewed partner has no such limit.
  for (let index = 0; index < 21; index += 1) {
    assert.equal((await submit(env, "opp_openyardage_key", "r" + index)).status, 200);
  }
});

test("pins of a partner waiting for review stay out of the files; after the review open days go in", async (t) => {
  const env = setup();
  fakeGithub(t);
  const { key } = await signUp(env, await login(env));
  assert.equal((await submit(env, key, "early", "2027-04-12")).status, 200);
  assert.equal((await submit(env, "opp_openyardage_key", "oy", "2027-04-12")).status, 200);

  // Two days later: 04-12 is still open, so the review takes it in.
  env.NOW_ISO = "2027-04-14T12:00:00Z";
  const message = await reviewMessage(env, { id: "golfclub-wannsee", name: "Golfclub Wannsee",
    website: null, login: "octo", created: NOW });
  const link = /https:\/\/api\.openpinsheet\.com\/v1\/review\?channel=golfclub-wannsee&sig=([0-9a-f]{64})/.exec(message);
  assert.ok(link, "no review link in the mail");
  assert.match(message, /^From: OpenPinsheet <partners@openpinsheet\.com>\r\nTo: info@openyardage\.com\r\n/);

  env.DB.startInvocation();
  const wrong = await worker.fetch(new Request(BASE + "/v1/review?channel=golfclub-wannsee&sig=" + "0".repeat(64)), env);
  assert.equal(wrong.status, 403);
  env.DB.startInvocation();
  const look = await worker.fetch(new Request(BASE + "/v1/review?channel=golfclub-wannsee&sig=" + link[1]), env);
  assert.equal(look.status, 200);
  assert.match(await look.text(), /waiting for review/);

  env.DB.startInvocation();
  const confirmed = await worker.fetch(new Request(BASE + "/v1/review", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channel: "golfclub-wannsee", sig: link[1], action: "confirm" }).toString(),
  }), env);
  assert.equal(confirmed.status, 200);
  const channel = await env.DB.prepare("SELECT archive_from FROM channels WHERE id = 'golfclub-wannsee'").first();
  assert.equal(channel.archive_from, "2027-04-12");

  env.NOW_ISO = "2027-04-15T04:00:00Z";
  env.DB.startInvocation();
  await worker.scheduled({}, env);
  const file = await env.BUCKET.get("v1/days/2027-04-12.csv");
  const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  assert.match(text, /golfclub-wannsee/);
  assert.match(text, /openyardage/);
});

test("a day that closes before the review is written without the partner", async (t) => {
  const env = setup();
  fakeGithub(t);
  const { key } = await signUp(env, await login(env));
  assert.equal((await submit(env, key, "early", "2027-04-12")).status, 200);
  assert.equal((await submit(env, "opp_openyardage_key", "oy", "2027-04-12")).status, 200);
  env.NOW_ISO = "2027-04-15T04:00:00Z";
  env.DB.startInvocation();
  await worker.scheduled({}, env);
  const file = await env.BUCKET.get("v1/days/2027-04-12.csv");
  const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  assert.doesNotMatch(text, /golfclub-wannsee/);
  assert.match(text, /openyardage/);
});

test("blocking stops the key and deletes the pins of open days", async (t) => {
  const env = setup();
  fakeGithub(t);
  const { key } = await signUp(env, await login(env));
  assert.equal((await submit(env, key, "g1")).status, 200);
  const sig = /sig=([0-9a-f]{64})/.exec(await reviewMessage(env, { id: "golfclub-wannsee", name: "x",
    website: null, login: "octo", created: NOW }))[1];
  env.DB.startInvocation();
  const blocked = await worker.fetch(new Request(BASE + "/v1/review", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channel: "golfclub-wannsee", sig, action: "block" }).toString(),
  }), env);
  assert.equal(blocked.status, 200);
  const pins = await env.DB.prepare("SELECT COUNT(*) AS n FROM pins WHERE channel = 'golfclub-wannsee'").first();
  assert.equal(pins.n, 0);
  assert.equal((await submit(env, key, "g2")).status, 401);
});

test("an uploaded CSV is stored under the partner; a file with problems stores nothing", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  await signUp(env, session);

  const upload = (name, text) => {
    const form = new FormData();
    form.set("csrf", session.csrf);
    form.set("date", DATE);
    form.set("source", "surveyed");
    form.set("accuracy_m", "0.02");
    form.set("file", new File([text], name, { type: "text/csv" }));
    env.DB.startInvocation();
    return worker.fetch(new Request(BASE + "/v1/account/upload", {
      method: "POST", headers: { Cookie: session.cookie }, body: form,
    }), env);
  };

  const good = await upload("pins.csv", "Name,Latitude,Longitude\nPin 1,52.1000001,13.1000001\nPin 2,52.1010001,13.1010001\n");
  assert.equal(good.status, 200);
  assert.match(await good.text(), /2 pins/);
  const rows = await env.DB.prepare(
    "SELECT hole, source, accuracy_m FROM pins WHERE channel = 'golfclub-wannsee' ORDER BY hole",
  ).all();
  assert.deepEqual(rows.results, [
    { hole: "1", source: "surveyed", accuracy_m: 0.02 },
    { hole: "2", source: "surveyed", accuracy_m: 0.02 },
  ]);

  const bad = await upload("pins.csv", "Name,Latitude\nPin 3,52.1\n");
  assert.match(await bad.text(), /Nothing was stored/);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pins WHERE channel = 'golfclub-wannsee'").first();
  assert.equal(count.n, 2);
});

test("New partner key replaces the old one at once", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  const { key: first } = await signUp(env, session);
  const page = await postForm(env, "/v1/account/partner-key", session, {});
  const second = /opp_[A-Za-z0-9_-]{43}/.exec(await page.text())[0];
  assert.notEqual(first, second);
  assert.equal((await submit(env, first, "g1")).status, 401);
  assert.equal((await submit(env, second, "g1")).status, 200);
});

test("signing out ends the session, and the nightly run drops expired ones", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  const out = await postForm(env, "/v1/account/logout", session, {});
  assert.match(out.headers.getSetCookie().join("\n"), /ops_session=;.*Max-Age=0/);
  env.DB.startInvocation();
  const after = await worker.fetch(new Request(BASE + "/v1/account", { headers: { Cookie: session.cookie } }), env);
  assert.match(await after.text(), /Sign in with GitHub/);

  await login(env);
  env.NOW_ISO = "2027-05-20T04:00:00Z";
  env.DB.startInvocation();
  await worker.scheduled({}, env);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first();
  assert.equal(left.n, 0);
});

test("a blocked partner gets no new key, a replayed confirm changes nothing", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  await signUp(env, session);
  const sig = /sig=([0-9a-f]{64})/.exec(await reviewMessage(env, { id: "golfclub-wannsee", name: "x",
    website: null, login: "octo", created: NOW }))[1];
  const review = (action) => {
    env.DB.startInvocation();
    return worker.fetch(new Request(BASE + "/v1/review", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel: "golfclub-wannsee", sig, action }).toString(),
    }), env);
  };
  assert.equal((await review("block")).status, 200);
  const page = await postForm(env, "/v1/account/partner-key", session, {});
  assert.equal(/opp_[A-Za-z0-9_-]{43}/.test(await page.text()), false, "a blocked partner got a key");
  assert.equal((await review("confirm")).status, 409);
  const channel = await env.DB.prepare("SELECT archive_from, blocked FROM channels WHERE id = 'golfclub-wannsee'").first();
  assert.deepEqual(channel, { archive_from: null, blocked: 1 });
});

test("the partner key of a blocked GitHub reader stops working", async (t) => {
  const env = setup();
  fakeGithub(t);
  const { key } = await signUp(env, await login(env));
  assert.equal((await submit(env, key, "g1")).status, 200);
  env.DB.prepare("UPDATE readers SET active = 0 WHERE github_id = 7777").run();
  assert.equal((await submit(env, key, "g2")).status, 401);
});

test("an upload above 1 MB is refused also without Content-Length", async (t) => {
  const env = setup();
  fakeGithub(t);
  const session = await login(env);
  await signUp(env, session);
  const chunk = new TextEncoder().encode("x".repeat(65536));
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= 20) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
  env.DB.startInvocation();
  const response = await worker.fetch(new Request(BASE + "/v1/account/upload", {
    method: "POST",
    headers: { Cookie: session.cookie, "Content-Type": "multipart/form-data; boundary=x" },
    body,
    duplex: "half",
  }), env);
  assert.equal(response.status, 413);
  assert.ok(sent < 20, "the whole body was read");
});

test("the admin sees every partner and confirms in the account; nobody else can", async (t) => {
  const env = setup();
  env.ADMIN_GITHUB_IDS = "9999, 1234";
  fakeGithub(t, 7777, "octo");
  const partner = await login(env);
  await signUp(env, partner);

  env.DB.startInvocation();
  const own = await worker.fetch(new Request(BASE + "/v1/account", { headers: { Cookie: partner.cookie } }), env);
  assert.doesNotMatch(await own.text(), /\(admin\)/);
  const refused = await postForm(env, "/v1/account/review", partner, { channel: "golfclub-wannsee", action: "confirm" });
  assert.equal(refused.status, 403);

  fakeGithub(t, 9999, "boss");
  const admin = await login(env);
  env.DB.startInvocation();
  const list = await (await worker.fetch(new Request(BASE + "/v1/account", { headers: { Cookie: admin.cookie } }), env)).text();
  assert.match(list, /Data partners <span class="small">\(admin\)<\/span>/);
  assert.match(list, /1 partner waits for review/);
  assert.match(list, /Golfclub Wannsee/);

  const confirmed = await postForm(env, "/v1/account/review", admin, { channel: "golfclub-wannsee", action: "confirm" });
  assert.equal(confirmed.status, 200);
  assert.match(await confirmed.text(), /Confirmed/);
  const channel = await env.DB.prepare("SELECT archive_from FROM channels WHERE id = 'golfclub-wannsee'").first();
  assert.equal(channel.archive_from, "2027-04-10");

  const noCsrf = await postForm(env, "/v1/account/review", { cookie: admin.cookie, csrf: "x" }, { channel: "golfclub-wannsee", action: "block" });
  assert.equal(noCsrf.status, 403);
  const still = await env.DB.prepare("SELECT blocked FROM channels WHERE id = 'golfclub-wannsee'").first();
  assert.equal(still.blocked, 0);
});

test("the admin opens a partner's statistics; a partner cannot", async (t) => {
  const env = setup();
  env.ADMIN_GITHUB_IDS = "9999";
  fakeGithub(t, 7777, "octo");
  const partner = await login(env);
  const { key } = await signUp(env, partner);
  assert.equal((await submit(env, key, "g1")).status, 200);

  const open = (session) => {
    env.DB.startInvocation();
    return worker.fetch(new Request(BASE + "/v1/account/partners/golfclub-wannsee", {
      headers: { Cookie: session.cookie },
    }), env);
  };
  assert.equal((await open(partner)).status, 403);

  fakeGithub(t, 9999, "boss");
  const admin = await login(env);
  const page = await open(admin);
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /Golfclub Wannsee/);
  assert.match(text, /Where it delivers/);
  assert.match(text, /Last 30 days/);
  assert.match(text, /openstreetmap\.org\/\?mlat=52\.1&amp;mlon=13\.1|openstreetmap\.org\/\?mlat=52\.1&mlon=13\.1/);
  env.DB.startInvocation();
  const missing = await worker.fetch(new Request(BASE + "/v1/account/partners/nobody", { headers: { Cookie: admin.cookie } }), env);
  assert.equal(missing.status, 404);
});
