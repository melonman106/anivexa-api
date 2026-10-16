// Tests for core/anilist-gate.js — run with: node test/gate-test.mjs
// Uses a fake global fetch, so nothing here talks to AniList.
import assert from "node:assert/strict";
process.env.ANILIST_MIN_INTERVAL_MS = "20";   // fast tests; production default is 2200
process.env.ANILIST_MAX_QUEUE = "5";

const { anilist, anilistStatus, AniListError, invalidate, _reset } = await import("../core/anilist-gate.js");

let passed = 0, failed = 0;
async function t(name, fn) {
  _reset();
  try { await fn(); passed++; console.log("  ok  ", name); }
  catch (e) { failed++; console.log("  FAIL", name, "\n      ", e && e.stack || e); }
}

const realFetch = globalThis.fetch;
let calls = [];
function fake(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body, at: Date.now() });
    return handler(calls.length, body, init);
  };
}
const ok = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
const blocked = () => new Response("You have been manually blocked. Please come to the principal's office.", { status: 403 });
const blockedJson = () => new Response(JSON.stringify({ errors: [{ message: "You have been manually blocked. Please come to the principal's office.", status: 403 }] }), { status: 403 });
const limited = (secs = 7) => new Response(JSON.stringify({ errors: [{ message: "Too Many Requests.", status: 429 }] }), { status: 429, headers: { "retry-after": String(secs) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = "query($id:Int){Media(id:$id){id}}";

console.log("anilist-gate");

await t("sends one honest request: no browser UA, no Origin/Referer, correct endpoint", async () => {
  fake(() => ok({ Media: { id: 1 } }));
  const d = await anilist(Q, { id: 1 }, { key: "a" });
  assert.deepEqual(d, { Media: { id: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://graphql.anilist.co");
  const h = calls[0].init.headers;
  assert.match(h["User-Agent"], /^Anivexa-API\//);
  assert.ok(!/mozilla|chrome|firefox/i.test(h["User-Agent"]));
  assert.equal(h.Origin, undefined);
  assert.equal(h.Referer, undefined);
});

await t("caches answers (second call makes no request)", async () => {
  fake(() => ok({ Media: { id: 2 } }));
  await anilist(Q, { id: 2 }, { key: "k2" });
  await anilist(Q, { id: 2 }, { key: "k2" });
  assert.equal(calls.length, 1);
  assert.equal(anilistStatus().cacheHits, 1);
});

await t("default key = query + variables (different variables → different requests)", async () => {
  fake((n) => ok({ Media: { id: n } }));
  await anilist(Q, { id: 1 });
  await anilist(Q, { id: 2 });
  await anilist(Q, { id: 1 });
  assert.equal(calls.length, 2);
});

await t("identical in-flight requests are shared", async () => {
  fake(async () => { await sleep(30); return ok({ Media: { id: 3 } }); });
  const r = await Promise.all([1, 2, 3, 4].map(() => anilist(Q, { id: 3 }, { key: "k3" })));
  assert.equal(calls.length, 1);
  assert.ok(r.every((x) => x.Media.id === 3));
});

await t("requests are serialised with a minimum gap", async () => {
  fake(() => ok({ Media: { id: 0 } }));
  await Promise.all([1, 2, 3, 4].map((i) => anilist(Q, { id: i }, { key: "s" + i })));
  assert.equal(calls.length, 4);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 15, `gap ${calls[i].at - calls[i - 1].at}ms`);
});

await t("queue cap: excess lookups fail fast with a 429-style error instead of piling up", async () => {
  fake(async () => { await sleep(40); return ok({ Media: { id: 0 } }); });
  const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => anilist(Q, { id: 100 + i }, { key: "q" + i })));
  const rejected = res.filter((r) => r.status === "rejected");
  assert.ok(rejected.length >= 5, "expected overflow rejections, got " + rejected.length);
  assert.ok(rejected.every((r) => r.reason instanceof AniListError && r.reason.status === 429));
});

await t("'manually blocked' (plain text, 403) opens the breaker and stops ALL further requests", async () => {
  fake(() => blocked());
  await assert.rejects(anilist(Q, { id: 1 }, { key: "b1" }), (e) => e.blocked === true && e.status === 503);
  const before = calls.length;
  for (let i = 2; i < 12; i++) await assert.rejects(anilist(Q, { id: i }, { key: "b" + i }), (e) => e.blocked === true);
  assert.equal(calls.length, before, "no requests may be sent while blocked");
  const st = anilistStatus();
  assert.equal(st.blocked, true);
  assert.equal(st.state, "blocked");
  assert.ok(st.pausedForSeconds > 14 * 60 && st.pausedForSeconds <= 15 * 60);
  assert.equal(st.blockLevel, 1);
});

await t("'manually blocked' as GraphQL error JSON is detected too (even with HTTP 200-ish bodies)", async () => {
  fake(() => blockedJson());
  await assert.rejects(anilist(Q, { id: 1 }, { key: "bj" }), (e) => e.blocked === true);
  assert.equal(anilistStatus().blocked, true);
});

await t("block message in a 200 response is still treated as blocked", async () => {
  fake(() => new Response(JSON.stringify({ errors: [{ message: "You have been manually blocked." }] }), { status: 200 }));
  await assert.rejects(anilist(Q, { id: 1 }, { key: "b200" }), (e) => e.blocked === true);
  assert.equal(anilistStatus().blocked, true);
});

await t("while blocked, stale cached data is served instead of an error", async () => {
  fake(() => ok({ Media: { id: 9, title: "cached" } }));
  await anilist(Q, { id: 9 }, { key: "st", ttl: 1 });   // fresh for 1 ms
  await sleep(5);
  fake(() => blocked());
  const d = await anilist(Q, { id: 9 }, { key: "st", ttl: 1 });
  assert.equal(d.Media.title, "cached");
  assert.equal(anilistStatus().staleServed, 1);
  const n = calls.length;
  const d2 = await anilist(Q, { id: 9 }, { key: "st", ttl: 1 });   // breaker now open → no request
  assert.equal(d2.Media.title, "cached");
  assert.equal(calls.length, n);
});

await t("invalidate() forces a refresh but keeps the old copy as a fallback", async () => {
  fake(() => ok({ Media: { id: 5, v: 1 } }));
  await anilist(Q, { id: 5 }, { key: "inv" });
  invalidate("inv");
  fake(() => ok({ Media: { id: 5, v: 2 } }));
  assert.equal((await anilist(Q, { id: 5 }, { key: "inv" })).Media.v, 2);
  invalidate("inv");
  fake(() => blocked());
  assert.equal((await anilist(Q, { id: 5 }, { key: "inv" })).Media.v, 2, "fell back to the stale copy");
});

await t("429 respects Retry-After and does not count as a block", async () => {
  fake(() => limited(7));
  await assert.rejects(anilist(Q, { id: 1 }, { key: "r1" }), (e) => e.limited === true && e.status === 429 && e.retryAfter === 7);
  const n = calls.length;
  await assert.rejects(anilist(Q, { id: 2 }, { key: "r2" }), (e) => e.limited === true);
  assert.equal(calls.length, n, "no request while rate-limited");
  const st = anilistStatus();
  assert.equal(st.blocked, false);
  assert.equal(st.state, "limited");
  assert.ok(st.pausedForSeconds >= 6 && st.pausedForSeconds <= 10);
});

await t("breaker escalates 15 min → 1 h → 6 h → 24 h on repeated blocks, and resets after a success", async () => {
  // We can't wait 15 minutes; move the clock instead.
  const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
  try {
    fake(() => blocked());
    await assert.rejects(anilist(Q, { id: 1 }, { key: "e1" }));
    assert.equal(anilistStatus().blockLevel, 1);
    const expect = [[2, 3600], [3, 6 * 3600], [4, 24 * 3600], [4, 24 * 3600]];
    for (const [lvl, secs] of expect) {
      offset += 25 * 3600 * 1000;                                // jump past the pause
      assert.equal(anilistStatus().state, "ok");
      await assert.rejects(anilist(Q, { id: 1 }, { key: "e" + lvl + offset }));   // the probe is blocked again
      const st = anilistStatus();
      assert.equal(st.blockLevel, lvl);
      assert.ok(Math.abs(st.pausedForSeconds - secs) < 5, `level ${lvl}: ${st.pausedForSeconds}s vs ${secs}s`);
    }
    offset += 25 * 3600 * 1000;
    fake(() => ok({ Media: { id: 1 } }));                        // AniList lifted the block
    await anilist(Q, { id: 1 }, { key: "recovered" });
    const st = anilistStatus();
    assert.equal(st.state, "ok"); assert.equal(st.blockLevel, 0);
  } finally { Date.now = realNow; }
});

await t("only ONE probe request is sent when the pause ends and it is blocked again", async () => {
  const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
  try {
    fake(() => blocked());
    await assert.rejects(anilist(Q, { id: 1 }, { key: "p0" }));
    offset += 16 * 60 * 1000;
    calls.length = 0;
    const res = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => anilist(Q, { id: 10 + i }, { key: "p" + (i + 1) })));
    assert.ok(res.every((r) => r.status === "rejected"));
    assert.equal(calls.length, 1, "only the probe may go out");
  } finally { Date.now = realNow; }
});

await t("a bad query (GraphQL validation error) is our bug: error is surfaced, breaker stays closed", async () => {
  fake(() => new Response(JSON.stringify({ errors: [{ message: "Cannot query field \"nope\"", status: 400 }] }), { status: 400 }));
  await assert.rejects(anilist(Q, { id: 1 }, { key: "bad" }), (e) => !e.blocked && !e.limited);
  assert.equal(anilistStatus().state, "ok");
});

await t("network failures: 3 in a row pause for 30 s, nothing is called in the meantime", async () => {
  fake(() => { throw new TypeError("fetch failed"); });
  for (let i = 0; i < 3; i++) await assert.rejects(anilist(Q, { id: i }, { key: "n" + i }));
  assert.equal(anilistStatus().state, "unavailable");
  const n = calls.length;
  await assert.rejects(anilist(Q, { id: 99 }, { key: "n99" }));
  assert.equal(calls.length, n);
});

await t("5xx responses do not open the 'blocked' state", async () => {
  fake(() => new Response("oops", { status: 502 }));
  await assert.rejects(anilist(Q, { id: 1 }, { key: "x1" }), (e) => !e.blocked);
  assert.equal(anilistStatus().blocked, false);
});

await t("the gate never contacts anilist.co (website) and never sets a browser User-Agent, even after a block", async () => {
  fake(() => blocked());
  await assert.rejects(anilist(Q, { id: 1 }, { key: "w1" }));
  await assert.rejects(anilist(Q, { id: 2 }, { key: "w2" }));
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.url === "https://graphql.anilist.co"));
});

console.log("modules");

await t("core/anilist.js getMedia: maps AniList data, memoises, and survives a block via cache", async () => {
  const { getMedia, forgetMedia } = await import("../core/anilist.js");
  const media = { id: 777, idMal: 5, title: { english: "E", romaji: "R", native: "N" }, status: "RELEASING", format: "TV", episodes: 12, seasonYear: 2025, startDate: { year: 2025 }, genres: ["Action"], synonyms: ["S"], nextAiringEpisode: null };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("arm.haglund.dev")) return new Response(JSON.stringify({ myanimelist: 5 }), { status: 200 });
    return ok({ Media: media });
  };
  calls = [];
  const a = await getMedia(777);
  assert.equal(a.title.english, "E"); assert.equal(a.idMal, 5); assert.deepEqual(a.synonyms, ["S"]);
  await getMedia(777);
  assert.equal(calls.filter((c) => c.url === "https://graphql.anilist.co").length, 1, "memoised");
  // AniList now blocks us: forget → refresh attempt fails → stale copy is used
  forgetMedia(777);
  globalThis.fetch = async (url) => String(url).includes("arm.haglund.dev") ? new Response("{}", { status: 200 }) : blocked();
  const b = await getMedia(777);
  assert.equal(b.title.english, "E");
  assert.equal(anilistStatus().blocked, true);
});

await t("no source file outside the gate talks to graphql.anilist.co or anilist.co directly", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join, relative, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const offenders = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      if (f === "node_modules" || f === ".git" || f === "docs" || f === "test") continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(f)) continue;
      const src = readFileSync(p, "utf8");
      const rel = relative(root, p);
      if (rel === join("core", "anilist-gate.js")) continue;
      if (/https?:\/\/graphql\.anilist\.co/.test(src)) offenders.push(rel + " → graphql.anilist.co");
      if (/fetch\([^)]*https?:\/\/(www\.)?anilist\.co\b/.test(src)) offenders.push(rel + " → anilist.co");
      if (/Origin"?\s*:\s*"https:\/\/anilist\.co"/.test(src)) offenders.push(rel + " spoofs Origin");
    }
  })(root);
  assert.deepEqual(offenders, []);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
