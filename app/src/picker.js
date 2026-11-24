'use strict';
// Finds live channels on Twitch that could be raided. With a website, the website chooses
// among them. Without one, choose() below uses the same sizes.
const MAX_PAGES = 50; // 100 channels per page, biggest first
const SEND = 150; // the most that are offered to choose from
const TIERS = [0.5, 1, 2]; // ±50%, ±100%, ±200%

function range(viewers, tier) {
  const base = Math.max(1, viewers);
  return [Math.max(0, Math.ceil(base * (1 - tier))), Math.floor(base * (1 + tier))];
}

const inside = (s, [low, high]) => s.viewer_count >= low && s.viewer_count <= high;

// Reads from the biggest channel down, until it is past the best size.
async function collect(api, filter, viewers) {
  const [low] = range(viewers, TIERS[0]);
  const [, most] = range(viewers, TIERS[2]);
  const found = new Map(); // channels can appear on two pages while we read
  let after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, cursor } = await api.liveStreams({ ...filter, after });
    for (const s of data) if (s.type === 'live' && s.viewer_count <= most) found.set(s.user_id, s);
    after = cursor;
    if (!after || !data.length || data[data.length - 1].viewer_count < low) break;
  }
  return [...found.values()];
}

const nearest = (list, viewers) => [...list].sort((a, b) => Math.abs(a.viewer_count - viewers) - Math.abs(b.viewer_count - viewers)).slice(0, SEND);

// Same category. Your language first; everyone else only if nobody fits ±50%.
async function findCandidates(api, mine, exclude) {
  const keep = (list) => list.filter((s) => !exclude.has(s.user_id));
  const v = mine.viewer_count;
  const same = mine.language ? keep(await collect(api, { gameId: mine.game_id, language: mine.language }, v)).map((s) => ({ ...s, same: true })) : [];
  if (same.some((s) => inside(s, range(v, TIERS[0])))) return nearest(same, v);
  const known = new Set(same.map((s) => s.user_id));
  const others = keep(await collect(api, { gameId: mine.game_id }, v)).filter((s) => !known.has(s.user_id));
  return nearest([...same, ...others], v);
}

// Which of the network's live members Twitch also says are live, with their viewers.
async function findNetworkCandidates(api, mine, members, exclude) {
  const ids = members.filter((id) => !exclude.has(id));
  if (!ids.length) return [];
  const live = (await api.streamsOf(ids)).filter((s) => s.type === 'live' && !exclude.has(s.user_id));
  return nearest(live.map((s) => ({ ...s, same: s.game_id === mine.game_id })), mine.viewer_count);
}

// Only for copies without a website.
function choose(list, viewers, rng = Math.random) {
  for (const tier of TIERS) {
    const fits = list.filter((s) => inside(s, range(viewers, tier)));
    const same = fits.filter((s) => s.same);
    const from = same.length ? same : fits;
    if (from.length) return from[Math.floor(rng() * from.length)];
  }
  return null;
}

module.exports = { findCandidates, findNetworkCandidates, choose, range, TIERS };
