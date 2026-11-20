'use strict';
// Unique hex prefixes for 16-hex ids (videos, scenes), as git does for commits: "2623" stands for 2623dc131e744dd0
// when no other id starts with it. Ambiguous or unknown prefixes are an error, never a guess.
//   resolve(given, ids, { tool, arg, noun }) -> the full id, or null when given is not a hex prefix (the caller's
//   own error applies). ids: the known ids, newest first (the example in an ambiguity error is the newest match).
const FULL = /^[0-9a-f]{16}$/, PART = /^[0-9a-f]{1,15}$/;
const uerr = m => Object.assign(new Error(m), { userError: true });
function shortest(id, ids, min) {
  for (let n = Math.max(4, min); n < 16; n++) if (ids.filter(x => x.startsWith(id.slice(0, n))).length === 1) return id.slice(0, n);
  return id;
}
function resolve(given, ids, { tool, arg, noun }) {
  const g = String(given).trim().toLowerCase();
  if (FULL.test(g)) return g;
  if (!PART.test(g)) return null;
  const all = [...new Set(ids)], hits = all.filter(x => x.startsWith(g));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw uerr(`error ${tool}.${arg}: no ${noun} starts with "${g}"; give "latest", a full 16-hex id or a unique start of one`);
  const shown = hits.slice(0, 5).join(', ') + (hits.length > 5 ? `, and ${hits.length - 5} more` : '');
  throw uerr(`error ${tool}.${arg}: "${g}" matches ${hits.length} ${noun}s (${shown}); for example "${shortest(hits[0], all, g.length + 1)}"`);
}
module.exports = { resolve, shortest, FULL, PART };
