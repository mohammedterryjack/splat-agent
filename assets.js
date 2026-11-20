'use strict';
// Asset library for the 3D bot: ready-made low-poly models (Kenney Nature Kit 2.1 and Furniture Kit, CC0, colours from
// their materials) placed as Ink "mesh" solids: {"kind": "mesh", "asset": "nature/tree_oak", "at": [x, y, z], "size": 3}.
// Ink turns each mesh into a signed-distance solid, so it joins, carves and splats like any other solid.
// Names are "<kit>/<file>" (kit = the folder under assets/ without "kenney-"). index.json caches sizes and colours.
// Ink keys fitted meshes by asset name, so two placements of one asset would share the first one's position: every
// build therefore gets a copy of the spec whose mesh solids use a per-solid key ("nature/tree_oak#oak-1").
const fs = require('fs'), path = require('path');
const DIR = process.env.SPLAT_ASSETS || path.join(__dirname, 'assets');
const NAME_RE = /^[a-z]+\/[A-Za-z0-9_]+$/;
let K = null;
const kit = () => K || (K = require('./core.js').K);
let INDEX = null;
const loaded = new Map();

const fileOf = name => {
  if (!NAME_RE.test(name)) return null;
  const [k, n] = name.split('/'), f = path.join(DIR, 'kenney-' + k, n + '.glb');
  return fs.existsSync(f) ? f : null;
};
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const f = fileOf(name);
  if (!f) throw new Error(`no asset called "${name}"`);
  const m = kit().mesh.glb(new Uint8Array(fs.readFileSync(f)));
  loaded.set(name, m);
  return m;
}
// { name: { kit, size: [x, y, z] as modelled, tris, colours } }, rebuilt when a kit folder is newer than index.json
function index() {
  if (INDEX) return INDEX;
  const idx = path.join(DIR, 'index.json'), kits = fs.readdirSync(DIR).filter(d => d.startsWith('kenney-'));
  const newest = Math.max(...kits.map(d => fs.statSync(path.join(DIR, d)).mtimeMs));
  if (fs.existsSync(idx) && fs.statSync(idx).mtimeMs > newest) return (INDEX = JSON.parse(fs.readFileSync(idx, 'utf8')));
  const out = {};
  for (const d of kits)
    for (const f of fs.readdirSync(path.join(DIR, d)).filter(f => f.endsWith('.glb')).sort()) {
      const name = d.slice(7) + '/' + f.slice(0, -4), m = load(name), inf = kit().mesh.info(m);
      out[name] = { kit: d, size: inf.hi.map((h, a) => Math.round((h - inf.lo[a]) * 100) / 100), tris: inf.tris, colours: m.mats.filter(x => x.name !== 'default').map(x => x.name) };
      loaded.delete(name);
    }
  fs.writeFileSync(idx + '.tmp', JSON.stringify(out));
  fs.renameSync(idx + '.tmp', idx);
  return (INDEX = out);
}
const has = name => typeof name === 'string' && !!index()[name];
// words in the query must all appear in the name or its colours; "kits" lists the kits and counts
function list(q) {
  const I = index(), names = Object.keys(I);
  q = String(q || '').trim().toLowerCase();
  if (!q || q === 'kits') {
    const by = {};
    for (const n of names) by[n.split('/')[0]] = (by[n.split('/')[0]] || 0) + 1;
    return `${names.length} models: ${Object.entries(by).map(([k, c]) => `${k} (${c})`).join(', ')}. Search with words, e.g. list_assets("tree"), list_assets("chair"), list_assets("rock large").`;
  }
  const words = q.split(/[\s,]+/).filter(Boolean);
  const hits = names.filter(n => words.every(w => (n + ' ' + I[n].colours.join(' ')).toLowerCase().includes(w)));
  if (!hits.length) return `no model matches "${q}". Try one word (tree, rock, plant, fence, path, chair, table, lamp, bed, kitchen, ...).`;
  const shown = hits.slice(0, 40).map(n => `${n}: modelled ${I[n].size.join(' x ')} (w x h x d), colours ${I[n].colours.join('/') || '-'}`);
  return shown.join('\n') + (hits.length > 40 ? `\n... and ${hits.length - 40} more: narrow the search` : '') +
    '\nPlace one with add_solid kind "mesh": params {"asset": name, "at": [x, 0, z] (base centre), "size": largest side in scene units, "spin": turn about Y in radians}. Leave mat out to keep its own colours. All its fields: catalog("mesh").';
}
// the spec as built: mesh solids get per-solid keys; env carries those meshes
function forBuild(spec) {
  const s = JSON.parse(JSON.stringify(spec)), assets = {};
  const visit = (x, top) => {
    if (!x || typeof x !== 'object') return;
    if (x.kind === 'mesh' && typeof x.asset === 'string' && has(x.asset)) {
      const key = x.asset + '#' + (x.id || 'n' + Object.keys(assets).length);
      assets[key] = load(x.asset);
      x.asset = key;
    }
    for (const k of ['a', 'b', 'of']) visit(x[k], false);
  };
  (s.solids || []).forEach(x => visit(x, true));
  return { spec: s, env: { assets } };
}
module.exports = { DIR, index, list, has, load, forBuild, fileOf, NAME_RE };
