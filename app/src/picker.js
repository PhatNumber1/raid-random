'use strict';
// Finds live channels on Twitch that could be raided. With a website, the website chooses
// among them. Without one, choose() below uses the same sizes.
const MAX_PAGES = 50; // 100 channels per page, biggest first
const ELSEWHERE_GAMES = 8;
const ELSEWHERE_PAGES = 6;
const CLOSEST = 10;
const SEND = 150; // the most that are offered to choose from
const TIERS = [0.5, 1, 2]; // ±50%, ±100%, ±200%

function range(viewers, tier) {
  const base = Math.max(1, viewers);
  return [Math.max(0, Math.ceil(base * (1 - tier))), Math.floor(base * (1 + tier))];
}

const inside = (s, [low, high]) => s.viewer_count >= low && s.viewer_count <= high;

// Reads from the biggest channel down, until it is past the best size.
async function collect(api, filter, viewers, pages = MAX_PAGES) {
  const [low] = range(viewers, TIERS[0]);
  const found = new Map(); // channels can appear on two pages while we read
  let after;
  for (let page = 0; page < pages; page++) {
    const { data, cursor } = await api.liveStreams({ ...filter, after });
    for (const s of data) if (s.type === 'live') found.set(s.user_id, s);
    after = cursor;
    if (!after || !data.length || data[data.length - 1].viewer_count < low) break;
  }
  return [...found.values()];
}

const nearest = (list, viewers) => [...list].sort((a, b) => Math.abs(a.viewer_count - viewers) - Math.abs(b.viewer_count - viewers)).slice(0, SEND);

// Same category, everyone found. Your language first; others only if nobody fits ±50%.
async function findCandidates(api, mine, exclude) {
  const keep = (list) => list.filter((s) => !exclude.has(s.user_id));
  const v = mine.viewer_count;
  const same = mine.language ? keep(await collect(api, { gameId: mine.game_id, language: mine.language }, v)).map((s) => ({ ...s, same: true })) : [];
  if (same.some((s) => inside(s, range(v, TIERS[0])))) return same;
  const known = new Set(same.map((s) => s.user_id));
  const others = keep(await collect(api, { gameId: mine.game_id }, v)).filter((s) => !known.has(s.user_id));
  return [...same, ...others];
}

// What is offered at each step: similar size only, or any size with the closest first.
function forStage(list, viewers, stage) {
  const [, most] = range(viewers, TIERS[2]);
  return nearest(stage === 1 ? list.filter((s) => s.viewer_count <= most) : list, viewers);
}

// The last resort: a few random other categories. Twitch cannot give a random streamer directly.
async function findElsewhere(api, mine, exclude, rng = Math.random) {
  const games = [];
  let after;
  for (let page = 0; page < 3; page++) {
    const { data, cursor } = await api.topGames({ after });
    games.push(...data.filter((g) => g.id !== mine.game_id));
    after = cursor;
    if (!after) break;
  }
  for (let k = games.length - 1; k > 0; k--) { const r = Math.floor(rng() * (k + 1)); [games[k], games[r]] = [games[r], games[k]]; }
  const found = [];
  for (const game of games.slice(0, ELSEWHERE_GAMES)) {
    const filter = { gameId: game.id, ...(mine.language ? { language: mine.language } : {}) };
    found.push(...(await collect(api, filter, mine.viewer_count, ELSEWHERE_PAGES)).filter((s) => !exclude.has(s.user_id)));
    if (found.some((s) => inside(s, range(mine.viewer_count, TIERS[0])))) break;
  }
  return found;
}

// Which of the network's live members Twitch also says are live, with their viewers.
async function findNetworkCandidates(api, mine, members, exclude) {
  const ids = members.filter((id) => !exclude.has(id));
  if (!ids.length) return [];
  const live = (await api.streamsOf(ids)).filter((s) => s.type === 'live' && !exclude.has(s.user_id));
  return nearest(live.map((s) => ({ ...s, same: s.game_id === mine.game_id })), mine.viewer_count);
}

// Only for copies without a website. The same steps as there.
function choose(list, viewers, rng = Math.random, stage = 1, tiers = TIERS.length) {
  const one = (some) => {
    const same = some.filter((s) => s.same);
    const from = same.length ? same : some;
    return from[Math.floor(rng() * from.length)];
  };
  if (stage === 2) return list.length ? one(nearest(list, viewers).slice(0, CLOSEST)) : null;
  for (const tier of stage === 1 ? TIERS.slice(0, tiers) : TIERS) {
    const fits = list.filter((s) => inside(s, range(viewers, tier)));
    if (fits.length) return one(fits);
  }
  return stage === 3 && list.length ? one(list) : null;
}

module.exports = { findCandidates, findElsewhere, findNetworkCandidates, forStage, choose, range, TIERS };
