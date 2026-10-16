const __name = (fn, _) => fn;
import { anilist, invalidate } from "./anilist-gate.js";

var resolved = new Map(); // id → { media, at }
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var MEDIA_TTL_MS = 6 * 60 * 60 * 1000;

const AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

const MEDIA_QUERY = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} status format episodes seasonYear startDate{year} genres synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
const mediaKey = (id) => `media:${id}`;

// All AniList traffic goes through ./anilist-gate.js (cache, one-at-a-time sending, rate-limit + block handling).
// There is deliberately no fallback that talks to anilist.co as a browser: if the API refuses us we stop and use the cache.
async function fetchFromAniList(id) {
  const data = await anilist(MEDIA_QUERY, { id }, { key: mediaKey(id), ttl: MEDIA_TTL_MS });
  return data?.Media ?? null;
}

async function getMedia(anilistId) {
  const id = Number(anilistId);
  const memo = resolved.get(id);
  if (memo && Date.now() - memo.at < MEDIA_TTL_MS) return memo.media;
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    const [arm, al] = await Promise.all([
      fetch(`${ARM}?source=anilist&id=${id}`, {
        headers: { "User-Agent": UA, "Accept": "application/json" }
      }).then((r) => {
        if (!r.ok) return null;
        return r.json();
      }).catch(() => null),
      fetchFromAniList(id),
    ]);
    if (!al) throw new Error(`No data found for AniList ID ${id}`);
    const media = {
      id,
      idMal: al.idMal ?? arm?.myanimelist ?? null,
      title: {
        english: al.title?.english ?? null,
        romaji: al.title?.romaji ?? null,
        native: al.title?.native ?? null,
      },
      status: AL_STATUS_MAP[al.status] ?? "RELEASING",
      format: al.format ?? null,
      episodes: al.episodes ?? null,
      seasonYear: al.seasonYear ?? null,
      startDate: al.startDate ?? null,
      genres: Array.isArray(al.genres) ? al.genres : [],
      nextAiringEpisode: al.nextAiringEpisode ?? null,
      synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
    };
    resolved.set(id, { media, at: Date.now() });
    return media;
  })().finally(() => inflight.delete(id));
  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

/** Ask for fresh data next time. The old copy is kept as a fallback in case AniList can't be reached. */
function forgetMedia(anilistId) {
  const id = Number(anilistId);
  resolved.delete(id);
  invalidate(mediaKey(id));
}

export { getMedia, forgetMedia };
