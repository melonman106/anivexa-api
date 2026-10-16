/**
 * The single door every AniList request goes through.
 *
 * Why this exists: AniList blocks IP addresses that send too many requests ("You have been manually blocked").
 * Before this file, the API called AniList from a dozen places, mostly uncached, with no limit, and fell back to
 * logging into anilist.co like a browser when the API said no. This module replaces all of that with polite behaviour:
 *
 *   - one honest User-Agent (no browser impersonation, no Origin spoofing, no website fallback);
 *   - answers are cached (in memory, and in smartcache/Redis when that is enabled), identical in-flight requests are shared;
 *   - requests are sent one at a time with a minimum gap (default ≈ 27 per minute, under AniList's current 30/min ceiling);
 *   - 429 → wait for Retry-After; "blocked" / 403 → stop calling AniList entirely for 15 min, then 1 h, 6 h, 24 h,
 *     probing with a single request when the pause ends;
 *   - while paused, or when AniList errors, a stale cached answer (up to 7 days old) is served instead of failing.
 *
 * Nothing here tries to get around a block. If AniList blocks the server, the only fix is to ask AniList (their Discord)
 * to lift it; this code just makes sure we stop adding to the problem and keep working from cache in the meantime.
 */
import { getAsync, setAsync, isFresh } from "./smartcache.js";

const ENDPOINT = "https://graphql.anilist.co";

const readEnv = (name) => { try { return typeof process !== "undefined" ? process.env?.[name] : undefined; } catch { return undefined; } };
const envNum = (name, fallback) => { const n = Number(readEnv(name)); return Number.isFinite(n) && n > 0 ? n : fallback; };

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const USER_AGENT = readEnv("ANILIST_USER_AGENT") || "Anivexa-API/2.3 (+https://github.com/melonman106/anivexa-api)";
const MIN_GAP_MS = envNum("ANILIST_MIN_INTERVAL_MS", 2200);
const MAX_QUEUE = envNum("ANILIST_MAX_QUEUE", 25);
const REQUEST_TIMEOUT_MS = envNum("ANILIST_TIMEOUT_MS", 15000);
const DEFAULT_TTL_MS = 6 * HOUR;
const STALE_MS = 7 * DAY;
const MAX_CACHE = 600;
const BLOCK_STEPS_MS = [15 * MIN, HOUR, 6 * HOUR, DAY];
const BLOCKED_RE = /manually blocked|you have been blocked|principal'?s office/i;

export class AniListError extends Error {
  constructor(message, o = {}) {
    super(message);
    this.name = "AniListError";
    this.status = o.status ?? 502;
    this.blocked = !!o.blocked;
    this.limited = !!o.limited;
    this.retryAfter = o.retryAfter ?? 0; // seconds
  }
}

/* ── cache ── */
const cache = new Map(); // key → { data, at, fresh }

// Short, filesystem/Redis-safe key for the optional persistent layer.
function l2Key(key) {
  if (key.length <= 64 && /^[\w:.|-]+$/.test(key)) return "anilist:" + key;
  let a = 2166136261, b = 5381;
  for (let i = 0; i < key.length; i++) { a = Math.imul(a ^ key.charCodeAt(i), 16777619); b = (Math.imul(b, 33) + key.charCodeAt(i)) | 0; }
  return "anilist:h" + (a >>> 0).toString(36) + (b >>> 0).toString(36) + key.length.toString(36);
}

function remember(key, data, fresh) {
  cache.delete(key);
  cache.set(key, { data, at: Date.now(), fresh });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

/** Mark an entry stale without deleting it: the next caller refreshes it, but it is still served if AniList is unavailable. */
export function invalidate(key) {
  const e = cache.get(key);
  if (e) e.fresh = 0;
}

/* ── circuit breaker ── */
const breaker = { until: 0, level: 0, reason: "", since: 0, message: "", probing: false };
const stats = { requests: 0, ok: 0, cacheHits: 0, staleServed: 0, lastStatus: 0, lastAt: 0, lastMessage: "", consecutiveFailures: 0 };

function breakerOpen() { return Date.now() < breaker.until; }
function retryAfterSeconds() { return Math.max(1, Math.ceil((breaker.until - Date.now()) / 1000)); }

function openBreaker(reason, ms, message) {
  breaker.reason = reason;
  breaker.until = Date.now() + ms;
  breaker.since = Date.now();
  breaker.message = String(message || "").slice(0, 200);
  persistBreaker();
  console.warn(`[anilist] ${reason}: pausing AniList requests for ${Math.round(ms / 1000)}s (${breaker.message})`);
}

function blockedBreaker(message) {
  breaker.level = Math.min(breaker.level + 1, BLOCK_STEPS_MS.length);
  openBreaker("blocked", BLOCK_STEPS_MS[breaker.level - 1], message);
}

function noteSuccess() {
  stats.ok += 1; stats.consecutiveFailures = 0;
  if (breaker.level > 0 || breaker.reason) {
    console.log("[anilist] request succeeded; resuming normal operation");
    breaker.level = 0; breaker.reason = ""; breaker.until = 0; breaker.message = "";
    persistBreaker();
  }
}

function breakerError() {
  const blocked = breaker.reason === "blocked";
  const secs = retryAfterSeconds();
  return new AniListError(
    blocked
      ? `AniList has blocked this server's requests. Requests are paused for about ${Math.ceil(secs / 60)} min; cached data is still served.`
      : `AniList is limiting requests. Retrying in about ${secs}s; cached data is still served.`,
    { status: blocked ? 503 : 429, blocked, limited: !blocked, retryAfter: secs }
  );
}

/* The breaker survives restarts when smartcache is enabled (Redis / disk). */
let restored = false;
async function restoreBreaker() {
  if (restored) return;
  restored = true;
  try {
    const e = await getAsync("anilist:breaker");
    if (e && isFresh(e) && e.data && e.data.until > Date.now()) Object.assign(breaker, e.data);
  } catch { /* optional */ }
}
function persistBreaker() {
  const remaining = breaker.until - Date.now();
  setAsync("anilist:breaker", { until: breaker.until, level: breaker.level, reason: breaker.reason, message: breaker.message, since: breaker.since }, Math.max(remaining, 0) + DAY).catch(() => {});
}

/* ── one-at-a-time sender ── */
const queue = [];
let pumping = false;
let lastStart = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendOnce(query, variables) {
  stats.requests += 1;
  let res, text;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    stats.consecutiveFailures += 1;
    stats.lastStatus = 0; stats.lastAt = Date.now(); stats.lastMessage = String(e?.message || e).slice(0, 160);
    if (stats.consecutiveFailures >= 3) openBreaker("unavailable", 30 * 1000, "network errors");
    throw new AniListError("AniList did not respond", { status: 504 });
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON (block pages) */ }
  const message = (json && json.errors && json.errors[0] && json.errors[0].message) || (typeof text === "string" ? text.slice(0, 200) : "");
  stats.lastStatus = res.status; stats.lastAt = Date.now(); stats.lastMessage = String(message).slice(0, 160);

  if (res.status === 429) {
    const secs = Math.min(Math.max(Number(res.headers.get("retry-after")) || 60, 5), 10 * 60);
    openBreaker("limited", secs * 1000 + Math.floor(Math.random() * 1500), "429 Too Many Requests");
    throw new AniListError("AniList rate limit reached", { status: 429, limited: true, retryAfter: secs });
  }
  if (res.status === 403 || BLOCKED_RE.test(String(message))) {
    blockedBreaker(message || "HTTP " + res.status);
    throw new AniListError(String(message) || "AniList has blocked this server", { status: 503, blocked: true, retryAfter: retryAfterSeconds() });
  }
  if (!res.ok) {
    stats.consecutiveFailures += 1;
    if (res.status >= 500 && stats.consecutiveFailures >= 3) openBreaker("unavailable", 30 * 1000, "HTTP " + res.status);
    throw new AniListError(`AniList HTTP ${res.status}`, { status: res.status >= 500 ? 502 : res.status });
  }
  if (json && json.errors && json.errors.length && !json.data) {
    // A bad query is our bug, not AniList being unhappy: don't trip the breaker.
    throw new AniListError(`AniList: ${json.errors[0].message}`, { status: Number(json.errors[0].status) || 400 });
  }
  if (!json || !json.data) throw new AniListError("AniList returned an empty response", { status: 502 });
  noteSuccess();
  return json.data;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      if (breakerOpen()) {
        const err = breakerError();
        while (queue.length) queue.shift().reject(err);
        break;
      }
      const wait = lastStart + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      if (breakerOpen()) continue;
      const job = queue.shift();
      lastStart = Date.now();
      try { job.resolve(await sendOnce(job.query, job.variables)); } catch (e) { job.reject(e); }
    }
  } finally { pumping = false; }
}

function enqueue(query, variables) {
  if (breakerOpen()) return Promise.reject(breakerError());
  if (queue.length >= MAX_QUEUE) return Promise.reject(new AniListError("Too many AniList lookups queued; try again shortly", { status: 429, limited: true, retryAfter: 30 }));
  return new Promise((resolve, reject) => { queue.push({ query, variables, resolve, reject }); pump(); });
}

/* ── public API ── */
const inflight = new Map();

/**
 * Run a GraphQL query against AniList. Resolves with `data`.
 * opts: { key, ttl } — `key` identifies the answer in the cache (defaults to the query + variables), `ttl` is how long it
 * counts as fresh. Stale answers are returned (instead of an error) whenever AniList can't be asked.
 */
export async function anilist(query, variables = {}, opts = {}) {
  await restoreBreaker();
  const q = String(query).replace(/\s+/g, " ").trim();
  const key = opts.key || q + "|" + JSON.stringify(variables);
  const fresh = opts.ttl ?? DEFAULT_TTL_MS;

  let hit = cache.get(key);
  if (!hit) {
    try {
      const l2 = await getAsync(l2Key(key));
      if (l2 && l2.data !== undefined) { hit = { data: l2.data, at: l2.cachedAt || Date.now(), fresh }; cache.set(key, hit); }
    } catch { /* optional */ }
  }
  if (hit && Date.now() - hit.at < hit.fresh) { stats.cacheHits += 1; return hit.data; }
  if (inflight.has(key)) return inflight.get(key);

  const staleOk = hit && Date.now() - hit.at < STALE_MS;
  const p = (async () => {
    try {
      const data = await enqueue(q, variables);
      remember(key, data, fresh);
      setAsync(l2Key(key), data, STALE_MS).catch(() => {});
      return data;
    } catch (err) {
      if (staleOk) { stats.staleServed += 1; return hit.data; }
      throw err;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** For /anilist-status and logs. */
export function anilistStatus() {
  const open = breakerOpen();
  return {
    state: open ? breaker.reason : "ok",
    blocked: open && breaker.reason === "blocked",
    pausedForSeconds: open ? retryAfterSeconds() : 0,
    blockLevel: breaker.level,
    lastMessage: stats.lastMessage,
    lastStatus: stats.lastStatus,
    lastAt: stats.lastAt || null,
    queued: queue.length,
    cached: cache.size,
    requests: stats.requests,
    ok: stats.ok,
    cacheHits: stats.cacheHits,
    staleServed: stats.staleServed,
    minIntervalMs: MIN_GAP_MS,
  };
}

// test hook
export function _reset() { cache.clear(); inflight.clear(); queue.length = 0; Object.assign(breaker, { until: 0, level: 0, reason: "", since: 0, message: "", probing: false }); Object.assign(stats, { requests: 0, ok: 0, cacheHits: 0, staleServed: 0, lastStatus: 0, lastAt: 0, lastMessage: "", consecutiveFailures: 0 }); lastStart = 0; restored = true; }
