// End-to-end: what the API does when AniList says "You have been manually blocked".
// node test/api-blocked-test.mjs   (fake fetch; nothing leaves the machine)
import assert from "node:assert/strict";
process.env.ANILIST_MIN_INTERVAL_MS = "10";
const alCalls = [];
let alMode = "blocked";
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://graphql.anilist.co")) {
    alCalls.push(init?.headers);
    if (alMode === "blocked") return new Response("You have been manually blocked. Please come to the principal's office.", { status: 403 });
    const q = JSON.parse(init.body).query;
    if (/relations/.test(q)) return new Response(JSON.stringify({ data: { Media: { id: 55, synonyms: [], relations: { edges: [] } } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { Media: { id: 55, idMal: 9, title: { english: "Show", romaji: "Show R", native: "N" }, status: "FINISHED", format: "TV", episodes: 12, seasonYear: 2020, startDate: { year: 2020 }, genres: [], synonyms: [], nextAiringEpisode: null } } }), { status: 200 });
  }
  if (u.includes("arm.haglund.dev")) return new Response(JSON.stringify({ myanimelist: 9, thetvdb: 1 }), { status: 200 });
  return new Response("{}", { status: 404 });
};
const api = (await import("../index.js")).default;
const gate = await import("../core/anilist-gate.js");
const get = (p) => api.fetch(new Request("https://api.test" + p), {});
let pass = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  ok  ", n); } catch (e) { console.log("  FAIL", n, e.stack || e); process.exitCode = 1; } };

await t("/map/:id while blocked → still answers (200), AniList is contacted at most once", async () => {
  const r = await get("/map/55");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.mappings.malId, 9);
  assert.ok(alCalls.length <= 1, "calls: " + alCalls.length);
});
await t("many more requests while blocked → zero additional AniList calls", async () => {
  const n = alCalls.length;
  for (let i = 0; i < 20; i++) await get("/map/" + (100 + i));
  assert.equal(alCalls.length, n);
});
await t("/anilist-status reports the block and the pause", async () => {
  const s = await (await get("/anilist-status")).json();
  assert.equal(s.blocked, true); assert.equal(s.state, "blocked");
  assert.ok(s.pausedForSeconds > 0);
  assert.match(s.lastMessage, /manually blocked/i);
});
await t("every AniList call carried the honest UA and no spoofed Origin", async () => {
  for (const h of alCalls) { assert.match(h["User-Agent"], /^Anivexa-API/); assert.equal(h.Origin, undefined); }
});
await t("after AniList lifts the block and the pause ends, normal service resumes", async () => {
  const realNow = Date.now; Date.now = () => realNow() + 16 * 60 * 1000;
  try {
    alMode = "ok";
    const r = await get("/map/56");
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.mappings.title, "Show");
    assert.equal((await (await get("/anilist-status")).json()).state, "ok");
  } finally { Date.now = realNow; }
});
console.log(`\n${pass} passed`);
