<div align="center">


<img src="docs/logo.svg" width="80" height="80"/>


# Anivexa API

**Anime streaming aggregator API — one endpoint, all your sources.**

![Views](https://visitor-badge.laobi.icu/badge?page_id=walterwhite-69.Anivexa-API)
[![GitHub stars](https://img.shields.io/github/stars/walterwhite-69/Anivexa-API?style=flat-square&color=yellow)](https://github.com/walterwhite-69/Anivexa-API/stargazers)

[Join the Discord](https://discord.gg/MARQ9z9QSX) (Not affiliated with or connected to this API; not a support server.)

</div>

---

## What is this?

A single API that aggregates anime episode lists and streaming links from multiple providers. Give it an AniList ID, get back everything — episodes, sources, and stream URLs — all in one place.

## Notice!
***This API intentionally uses AniList as its catalog and identity layer. When AniList is unavailable, the API may be partially unavailable or unstable as well. If you do not want an AniList-backed catalog, this simply is not the API for your use case!. So dont bother using it.***

---

## Providers

All listed providers are active. Coverage and stream availability vary by title.

| Provider | Highlights |
|---|---|
| **MKissa** | Large catalog; captcha retries can slow requests |
| **Reanime** | Broad catalog |
| **AniKoto** | Broad catalog |
| **AnimeGG** | Fuzzy title matching |
| **AnimeNoSub** | Sub and dub episodes |
| **AniZone** | Sub, HLS, and subtitles |
| **AniWaves** | HLS, MP4, and embed fallbacks |
| **Senshi** | Episode mapping and streams |
| **Kickassanime** | Fuzzy title matching |
| **AnimeDunya** | MAL-backed; sub, HLS, and subtitles |
| **AnimeOnsen** | AniList/MAL matching; sub, DASH, and subtitles |
| **Ani.pm** | Soft-sub and hard-sub variants |

---

## Routes

```
GET /map/:anilistId
```
Returns cross-platform ID mappings — MAL, TVDB, TMDB, Kitsu, AniDB, and more.

```
GET /episodes/:anilistId
GET /episodes/:provider[/:provider...]/:anilistId
```
Returns episode lists in a single response with smart background refresh. Pass one or more provider names in the path to filter results — e.g. `/episodes/anizone/mkissa/16498` returns only those two. Omit providers to get all of them.

```
GET /watch/:provider/:anilistId/sub|dub/:provider-:ep
```
Returns stream URLs for a specific episode from a specific provider.

```
GET /stream/reanime/:id/sub|dub/:ep
```
302 redirect directly to the HLS stream.

<a id="reanime-flixcloud-playback"></a>
## ReAnime / FlixCloud playback notes

<details>
<summary>Click to see playback/decryption guide</summary>

ReAnime uses FlixCloud for some streams. The returned `url` can be a signed HLS master URL, but FlixCloud may return the manifest as a Base64 + XOR payload instead of plaintext `#EXTM3U`.

For those streams, use the returned `playlist_key` or `key` field to decode the master playlist and any child playlists before handing them to an HLS player.

```js
function decryptFlixManifest(bodyBuffer, playlistKey) {
  const raw = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
  const trimmed = raw.toString("utf8").trim();

  if (trimmed.startsWith("#EXTM3U")) return trimmed;

  const key = Buffer.from(playlistKey, "base64");
  let payload = Buffer.from(trimmed, "base64");
  const out = Buffer.alloc(payload.length);

  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i] ^ key[i % key.length];
  }

  const text = out.toString("utf8").trim();
  if (!text.startsWith("#EXTM3U")) throw new Error("FlixCloud manifest decrypt failed");
  return text;
}

function getManifestUrls(m3u8Text) {
  return m3u8Text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function fetchAndDecryptFlixManifest(manifestUrl, playlistKey) {
  const res = await fetch(manifestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://flixcloud.cc/",
      "Origin": "https://flixcloud.cc"
    }
  });

  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);

  const body = Buffer.from(await res.arrayBuffer());
  return decryptFlixManifest(body, playlistKey);
}
```

`HD-1` commonly uses AES-keyed HLS playlists. `HD-2` commonly uses image-wrapped `.png`/`.webp` segment URLs, so a custom proxy/player may need to unwrap those segment bytes before playback.

For HD-2 style image-wrapped segments, fetch the segment through your proxy, unwrap it, and return it as `video/mp2t`.

```js
const flixImageSegmentXorKey = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197
]);

function unwrapFlixImageSegment(bodyBuffer) {
  const body = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer);
  let offset = 0;
  let needsXor = false;

  const isWebp =
    body.length > 12 &&
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50;

  const isPng =
    body.length > 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a;

  if (isWebp) {
    offset = 12;
    needsXor = body[offset] !== 0x47;
  } else if (isPng) {
    offset = 8;
    needsXor = body[offset] !== 0x47;
  }

  if (!offset) return { body, unwrapped: false };

  const out = Buffer.from(body.subarray(offset));
  if (needsXor) {
    for (let i = 0; i < out.length; i++) {
      out[i] ^= flixImageSegmentXorKey[i % flixImageSegmentXorKey.length];
    }
  }

  return { body: out, unwrapped: true };
}
```

The API does not expose a public ReAnime `/proxy` route. If you need direct custom-player playback, use the returned `embed` URL or implement the manifest decode/proxy flow above.

***Removed the ReAnime `/proxy` endpoint since it was unnecessary and did not handle the Flixcloud playback flow anyway.***

</details>

---

## Self-hosted

```bash
git clone https://github.com/walterwhite-69/Anivexa-API
cd Anivexa-API
npm install
cp .env.example .env
node server.js
```

Runs on Node.js. No build step needed.

### Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable | Default | Notes |
|---|---|---|
| `CACHE_ENABLED` | `false` | Set to `true` to enable caching (memory + disk + Redis). |
| `UPSTASH_REDIS_REST_URL` | — | From [upstash.com](https://upstash.com). Only used when `CACHE_ENABLED=true`. |
| `UPSTASH_REDIS_REST_TOKEN` | — | From [upstash.com](https://upstash.com). Only used when `CACHE_ENABLED=true`. |
| `DEFAULT_REDIS_TTL` | `900` | Seconds. Fallback expiry for Redis writes when a per-item TTL isn't computed. Most cache entries use their own smart TTLs based on anime status (finished/airing/etc.) — this is just the safety-net default. |
| `ANILIST_MIN_INTERVAL_MS` | `2200` | Minimum gap between requests sent to AniList (≈ 27/min, under AniList's current 30/min limit). |
| `ANILIST_MAX_QUEUE` | `25` | Lookups allowed to wait for their turn. Extra ones fail fast instead of piling up. |
| `ANILIST_TIMEOUT_MS` | `15000` | Timeout for one AniList request. |
| `ANILIST_USER_AGENT` | `Anivexa-API/2.3 (+repo url)` | Sent to AniList. Put a contact (site URL or email) in it if you can. |
| `PORT` | `4000` | Local dev server port (`server.js` only — ignored on Vercel/serverless). Change it if `4000` is already in use, then hit `http://localhost:PORT`. |

On Vercel (or Railway/Render), set these as regular project environment variables instead of committing `.env`.

### AniList rate limits and blocks

AniList blocks IP addresses that send too many requests (the page says *"You have been manually blocked. Please come to the principal's office."*). All AniList traffic therefore goes through one place, `core/anilist-gate.js`, which:

- sends one request at a time with a minimum gap, using an honest `User-Agent` (no browser impersonation, no `Origin` spoofing, no website fallback);
- caches answers (memory, plus Redis/disk when `CACHE_ENABLED=true`) and shares identical in-flight lookups;
- on `429` waits for `Retry-After`; on a block (`403` / the "manually blocked" message) it **stops calling AniList entirely** for 15 min, then 1 h, 6 h, 24 h, and probes with a single request when each pause ends;
- while paused, or when AniList errors, serves the saved answer (up to 7 days old) instead of failing.

`GET /anilist-status` shows the current state (`ok`, `limited` or `blocked`, seconds until the next attempt, cache hit counts).

**This code cannot lift a block.** If `/anilist-status` says `blocked`, the block is on AniList's side: ask AniList to lift it (their community Discord server is the usual place; there is no automatic appeal) and tell them which server/IP it is and what changed. Check from another network (a phone on mobile data) to find out whether it is this server's IP or your own that is blocked. Turning on `CACHE_ENABLED=true` with Upstash makes the API remember answers across restarts, which cuts AniList traffic a lot on hosts that restart often (e.g. Render's free tier).

---

## Deploying on Vercel

> ⚠️ **Not recommended.** Vercel runs on shared datacenter IPs that are widely blocked by anime streaming sites. Most providers will fail silently or return errors — the API will technically run but you'll get little to no data back. Use a self-hosted VPS or use railway, render etc etc.

---

## Contributing

> **Only request providers that self-host their content. No scrapers of third-party sites.**

Got a provider you'd like added? Open an issue.

This project is community-kept-alive — if it helps you, please:

- ⭐ **Star the repo** so others can find it
- 🛠️ **Open a PR** if you want to add or fix something

---

<div align="center">

hope it helped :3

</div>
