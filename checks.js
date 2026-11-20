'use strict';
// Build checks for the 3D bot, taken from the anymachine pipeline's machine checks (github.com/apekshik/anymachine:
// sweep every moving part for overlaps, re-import the export and compare, list differences) and adapted to Ink scenes.
// Runs on the engine thread. Uses each top-level solid's own signed-distance function (world.made[id].sd) and
// surface samples (world.made[id].sample), and the rig's per-splat part ids for moving parts.
//   floating(w, spec)   solids not connected to the ground through touching solids (gap > tolerance)
//   clashes(w, spec)    moving parts that go INTO other solids during their motion (beyond how far they sit in at rest)
//   roundTrip(file, w)  re-read the exported .ply and compare every row with the world it came from
//   diff(base, spec)    which solids were added, removed or updated (Ink's words) compared with the scene it was based on
const C = require('./core.js');

const MAX_PTS = 1500;
const thin = (pts, n) => (pts.length <= n ? pts : pts.filter((_, i) => i % Math.ceil(pts.length / n) === 0));
const solidsOf = (w, spec) =>
  (spec.solids || []).filter(s => s.id && !s.carve && !s.ghost && w.made[s.id] && typeof w.made[s.id].sd === 'function').map(s => ({ s, m: w.made[s.id] }));

function surface(m) {
  const pts = [];
  m.sample((x, y, z) => pts.push([x, y, z]));
  return thin(pts, MAX_PTS);
}
// smallest signed distance from any of pts to solid m (bounding-sphere skip when clearly apart)
function minSd(pts, m, tol) {
  let best = Infinity;
  for (const p of pts) {
    if (m.br < 1e8) {
      const lb = Math.hypot(p[0] - m.bc[0], p[1] - m.bc[1], p[2] - m.bc[2]) - m.br;   // sd >= this outside the sphere
      if (lb > tol || lb >= best) continue;
    }
    const d = m.sd(p[0], p[1], p[2]);
    if (d < best) best = d;
  }
  return best;
}

function floating(w, spec) {
  const all = solidsOf(w, spec);
  if (all.length < 2) return [];
  const S = all.map(({ s, m }) => ({ id: s.id, kind: s.kind, part: s.part, m, tol: 1.5 * (m.res || 0.1), pts: s.kind === 'ground' ? null : surface(m) }));
  const pts = S.filter(x => x.pts && x.pts.length);
  const floorY = Math.min(...pts.flatMap(x => x.pts.map(p => p[1])));
  const ground = new Set(S.filter(x => x.kind === 'ground').map(x => x.id));
  // with no ground solid, whatever reaches the lowest point is the base
  if (!ground.size) for (const x of pts) if (Math.min(...x.pts.map(p => p[1])) <= floorY + x.tol) ground.add(x.id);
  const touch = (a, b) => {
    const tol = Math.max(a.tol, b.tol);
    return (a.pts && minSd(a.pts, b.m, tol) <= tol) || (b.pts && minSd(b.pts, a.m, tol) <= tol);
  };
  const reached = new Set(ground), todo = [...ground];
  while (todo.length) {
    const id = todo.pop(), a = S.find(x => x.id === id);
    for (const b of S) if (!reached.has(b.id) && touch(a, b)) (reached.add(b.id), todo.push(b.id));
  }
  // the solids left over, as groups of solids that touch each other (one line per floating group)
  const left = S.filter(x => !reached.has(x.id)), groups = [], seen = new Set();
  for (const x of left) {
    if (seen.has(x.id)) continue;
    const g = [x], q = [x];
    seen.add(x.id);
    while (q.length) {
      const a = q.pop();
      for (const b of left) if (!seen.has(b.id) && touch(a, b)) (seen.add(b.id), g.push(b), q.push(b));
    }
    groups.push(g);
  }
  return groups.map(g => {
    const ids = new Set(g.map(x => x.id)), others = S.filter(o => !ids.has(o.id));
    const gap = Math.min(...g.map(x => Math.min(...others.map(o => minSd(x.pts || [], o.m, Infinity)))));
    return { ids: g.map(x => x.id), parts: [...new Set(g.map(x => x.part).filter(Boolean))], gap: Math.round(gap * 100) / 100, bottom: Math.round(Math.min(...g.flatMap(x => x.pts.map(p => p[1]))) * 100) / 100 };
  });
}

// one cycle of every motion: spin 2*pi/speed, the others their period (default 4 s); 16 steps over the longest
function cycle(spec) {
  let T = 0;
  for (const m of spec.motion || []) T = Math.max(T, m.do === 'spin' ? (2 * Math.PI) / Math.max(0.05, Math.abs(m.speed || 1)) : m.period || 4);
  return Math.min(T || 4, 20);
}
function clashes(w, spec) {
  const rig = w.lab && w.lab.rig;
  if (!rig || !rig.bid || !(spec.motion || []).length) return [];
  // water is left out: boats, pads and ducks sit in it and bob through its surface on purpose
  const roleOf = m => (typeof m === 'string' ? m : m && m.role);
  const all = solidsOf(w, spec), statics = all.filter(x => !x.s.part && roleOf(x.s.mat) !== 'water');
  const T = cycle(spec), steps = 16;
  // one sweep forward in time for every part together (stateful worlds cannot be posed backwards)
  const parts = [...new Set(spec.motion.map(m => m.part))].map(part => {
    const pi = rig.names.indexOf(part), idx = [];
    if (pi >= 0) for (let i = 0; i < w.count; i++) if (rig.bid[i] === pi) idx.push(i);
    const res = Math.max(0.03, ...all.filter(x => x.s.part === part).map(x => x.m.res || 0.1));
    return { part, pick: thin(idx, MAX_PTS), tol: 0.5 * res, worst: null };   // deeper than half a splat counts (thin walls are ~2 res)
  }).filter(p => p.pick.length);
  const inside = P => {
    const hit = {};
    let n = 0;
    for (const i of P.pick) {
      const q = i * 16, p = [w.data[q], w.data[q + 1], w.data[q + 2]];
      for (const { s, m } of statics) if (minSd([p], m, P.tol) < -P.tol) { n++; hit[s.id] = (hit[s.id] || 0) + 1; break; }
    }
    return { n, hit };
  };
  C.pose(w, 0);
  for (const P of parts) P.rest = inside(P);
  for (let k = 1; k <= steps; k++) {
    const t = (k / steps) * T;
    C.pose(w, t);
    for (const P of parts) {
      const r = inside(P), extra = r.n - P.rest.n;
      if (extra > Math.max(4, 0.04 * P.pick.length) && (!P.worst || extra > P.worst.extra))
        P.worst = { t: Math.round(t * 100) / 100, extra, into: Object.keys(r.hit).filter(id => r.hit[id] > (P.rest.hit[id] || 0)) };
    }
  }
  return parts.filter(P => P.worst).map(P => ({ part: P.part, at_t: P.worst.t, share: Math.round((100 * P.worst.extra) / P.pick.length), into: P.worst.into, depth_tol: Math.round(P.tol * 100) / 100 }));
}

// the .ply on disk must be exactly the visible splats of the world (same rows, same order, all finite)
function roundTrip(file, w) {
  const r = C.readPly(file), P = C.PLY_PROPS.length;
  if (r.props.join(',') !== C.PLY_PROPS.join(',')) throw new Error(`round-trip: properties ${r.props.join(',')} are not the 3DGS set`);
  C.pose(w, 0);
  const row = new Float64Array(P), f32 = new Float32Array(P);
  let j = 0;
  for (let i = 0; i < w.count; i++) {
    if (!C.visible(w.data, i * 16)) continue;
    if (j >= r.n) throw new Error(`round-trip: the file has ${r.n} splats, the world has more visible ones`);
    C.splatToRow(w.data, i * 16, row, 0);
    f32.set(row);
    for (let k = 0; k < P; k++) {
      const v = r.data[j * P + k];
      if (!Number.isFinite(v) || v !== f32[k]) throw new Error(`round-trip: splat ${j} ${C.PLY_PROPS[k]} is ${v} in the file, ${f32[k]} in the world`);
    }
    j++;
  }
  if (j !== r.n) throw new Error(`round-trip: the file has ${r.n} splats, the world ${j} visible`);
  return { splats: j, ok: true };
}

function diff(base, spec) {
  const by = l => Object.fromEntries((l || []).filter(s => s.id).map(s => [s.id, JSON.stringify(s)]));
  const a = by(base.solids), b = by(spec.solids);
  const updated = Object.keys(b).filter(id => id in a && a[id] !== b[id]);
  const out = { added: Object.keys(b).filter(id => !(id in a)), removed: Object.keys(a).filter(id => !(id in b)), updated };
  for (const k of ['style', 'camera', 'light', 'motion', 'parts']) if (JSON.stringify(base[k]) !== JSON.stringify(spec[k])) out.updated.push('(' + k + ')');
  return out;
}

// Ink-style check lines: "warning <path>: <problem>; <fix>", one per open warning, then the changes line, then a
// summary. items() gives the same warnings as {id, problem, fix} for finish (which lists them for Mo without the fix).
function items(r) {
  const out = [];
  for (const f of r.floating)
    out.push({ path: f.ids.map(id => 'solids.' + id).join(', '), id: f.ids.join(', '), kind: 'floating',
      problem: `floating${f.ids.length > 1 ? ' (together)' : ''}${f.parts.length ? ' (moving part ' + f.parts.join(', ') + ')' : ''}, ${f.gap} from the nearest other solid (bottom at y ${f.bottom}); it does not rest on or touch anything that leads to the ground`,
      fix: `for example move("${f.ids[0]}", [0, -${f.gap}, 0])${f.ids.length > 1 ? ' and the rest of the group with it' : ''}, or join it to what holds it; leave it only if it is meant to hover (a cloud, a bird, a spinning star)` });
  for (const c of r.clashes)
    out.push({ path: 'motion.' + c.part, id: c.part, kind: 'clash',
      problem: `moving part passes through ${c.into.join(', ')} during its motion (${c.share}% of its splats inside, worst at t=${c.at_t} s)`,
      fix: 'move its joint, shrink the motion (amount or axis), or move the part clear' });
  return out;
}
function report(r) {
  const it = items(r), L = it.map(x => `warning ${x.path}: ${x.problem}; ${x.fix}`);
  if (r.diff) L.push(`changes from ${r.diff.base}: added ${r.diff.added.join(', ') || 'none'}; removed ${r.diff.removed.join(', ') || 'none'}; updated ${r.diff.updated.join(', ') || 'none'}. Check that only what the request asked for changed.`);
  L.push(it.length ? `build checks: ${it.length} warning(s) (floating ${r.floating.length}, clashes ${r.clashes.length})` : 'build checks: sound (nothing floating, no moving-part clashes)');
  return L;
}
module.exports = { floating, clashes, roundTrip, diff, report, items, cycle };
