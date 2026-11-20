'use strict';
// The one JSON scene the agent edits: an Ink Studio diorama spec (K.diorama). Every edit is a pure function
// spec -> new spec; an edit that leaves the scene with any checker error is refused (the old scene is kept) and
// the errors, with their "did you mean" hints, are returned. Solids are named by a stable "id".
const { K } = require('./core.js');
const DIO = K.diorama;

const WRAPS = ['fold', 'warp', 'shell', 'swell', 'rough', 'bubbles'];
const JOINS = Object.keys(K.sdf.JOIN);
const MOTIONS = ['spin', 'bob', 'turn', 'squash'];
const OUTER_KEYS = ['id', 'mat', 'res', 'part', 'group', 'carve', 'ghost', 'hold'];
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

class EditError extends Error {
  constructor(message, problems) {
    super(message);
    this.problems = problems || [];
  }
}

const clone = o => JSON.parse(JSON.stringify(o));

function blank() {
  return {
    id: 'splat-scene',
    name: 'Untitled',
    seed: 1,
    style: 'slate',
    camera: { target: [0, 1, 0], dist: 12, pitch: 0.25, yaw: 0.5 },
    solids: []
  };
}

// checker problems that matter for an edit (an empty solids list is how every new scene starts)
function problems(spec) {
  // mesh solids: the asset library decides which names exist (the models themselves are only loaded to build)
  const A = require('./assets.js'), env = { assets: {} }, meshes = [];
  const visitMesh = (s, path) => {
    if (!isObj(s)) return;
    if (s.kind === 'mesh') { meshes.push([s, path]); if (A.has(s.asset)) env.assets[s.asset] = true; }
    for (const k of ['of', 'a', 'b']) visitMesh(s[k], path + '.' + k);
  };
  (Array.isArray(spec.solids) ? spec.solids : []).forEach((s, i) => visitMesh(s, `solids[${i}]`));
  const list = DIO.check(spec, env).filter(p => !(p.path === 'solids' && Array.isArray(spec.solids) && !spec.solids.length) && !/^no mesh called /.test(p.problem));
  for (const [s, path] of meshes)
    if (typeof s.asset === 'string' && !A.has(s.asset)) {
      const names = Object.keys(A.index()), base = s.asset.toLowerCase().split('/').pop();
      const near = names.filter(n => n.toLowerCase().split('/')[1].includes(base) || base.includes(n.toLowerCase().split('/')[1])).slice(0, 5);
      list.push({ level: 'error', path: path + '.asset', problem: `no model called "${s.asset}" in the asset library`, hint: near.length ? 'did you mean ' + near.join(', ') + '?' : 'search with list_assets' });
    }
  // this Ink build's checker accepts a warp taper, but its engine cannot build one (the scene stops building)
  const look = (s, path) => {
    if (!isObj(s)) return;
    if (s.kind === 'warp' && s.taper !== undefined)
      list.push({ level: 'error', path: path + '.taper', problem: 'a warp taper cannot be built in this Ink version', hint: 'use twist or bend, or make the tapering shape with a lathe profile or a cone' });
    for (const k of ['of', 'a', 'b']) look(s[k], path + '.' + k);
  };
  (Array.isArray(spec.solids) ? spec.solids : []).forEach((s, i) => look(s, `solids[${i}]`));
  return list;
}
const errorsOf = spec => problems(spec).filter(p => p.level === 'error');

function report(list) {
  return list.map(p => `${p.level === 'error' ? 'error' : 'warning'} ${p.path || '(top)'}: ${p.problem}${p.hint ? '; ' + p.hint : ''}`).join('\n');
}

// walk every solid (top-level and nested), calling fn(solid, parentList, index, depth)
function walk(spec, fn) {
  const visit = (s, depth) => {
    if (!s || typeof s !== 'object') return;
    fn(s, depth);
    for (const k of ['a', 'b', 'of']) if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) visit(s[k], depth + 1);
  };
  for (const s of spec.solids || []) visit(s, 0);
}
function allIds(spec) {
  const ids = [];
  walk(spec, s => s.id !== undefined && ids.push(s.id));
  return ids;
}
function nearestId(spec, id) {
  const ids = allIds(spec);
  let best = null,
    bd = 4;
  for (const w of ids) {
    const d = lev(id, w);
    if (d < bd) ((bd = d), (best = w));
  }
  return best;
}
function lev(a, b) {
  a = String(a);
  b = String(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function find(spec, id) {
  let hit = null;
  walk(spec, (s, depth) => {
    if (s.id === id && !hit) hit = { s, depth };
  });
  if (!hit) {
    const n = nearestId(spec, id),
      ids = allIds(spec);
    throw new EditError(`no solid with id "${id}"` + (n ? ` (did you mean "${n}"?)` : ids.length ? ` (ids: ${ids.join(', ')})` : ' (the scene has no solids yet)'));
  }
  return hit;
}
function topIndex(spec, id) {
  const i = spec.solids.findIndex(s => s.id === id);
  if (i < 0) {
    find(spec, id); // throws "no solid" with a hint when it does not exist at all
    throw new EditError(`"${id}" is inside another solid; only top-level solids can be used here (top-level: ${spec.solids.map(s => s.id).join(', ')})`);
  }
  return i;
}
function freshId(spec, base) {
  base = String(base || 'solid').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '') || 'solid';
  base = base.slice(0, 32);
  const ids = new Set(allIds(spec));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) if (!ids.has(base + '-' + n)) return base + '-' + n;
}
function checkId(spec, id) {
  if (!ID_RE.test(id)) throw new EditError(`id "${id}" must be small letters, digits and dashes, starting with a letter (max 40)`);
  if (allIds(spec).includes(id)) throw new EditError(`a solid with id "${id}" already exists`);
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function plainParams(params, name) {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) throw new EditError(`${name || 'params'} must be an object of fields, e.g. {"at": [0, 1, 0], "r": 0.5}`);
  return params;
}

// commit: refuse if the new spec has any checker error
function commit(before, after, what) {
  const errs = errorsOf(after);
  if (errs.length) throw new EditError(`refused (${what}); the scene is unchanged. Fix and try again:\n${report(errs)}`, errs);
  const warns = problems(after).filter(p => p.level === 'warning');
  return { spec: after, note: warns.length ? report(warns) : '' };
}

// ---------------- the edits ----------------
const ops = {
  add_solid(spec, { kind, params, mat, part, id }) {
    const s = clone(spec),
      p = clone(plainParams(params));
    if (typeof kind !== 'string') throw new EditError('kind is required (catalog("kinds") lists them)');
    // a, b and of are nested solids only when they are objects (a fence's a and b are end points)
    for (const k of ['kind', 'id', 'mat', 'part', 'a', 'b', 'of'])
      if (k in p && (!['a', 'b', 'of'].includes(k) || isObj(p[k]))) throw new EditError(`put "${k}" in its own argument, not in params` + (['a', 'b', 'of'].includes(k) ? ' (use join or wrap to combine solids)' : ''));
    if (kind !== 'mesh' && mat === undefined) throw new EditError('mat is required (every kind except mesh, which keeps its model\'s colours)');
    const nid = id ? String(id) : freshId(s, kind);
    checkId(s, nid);
    const solid = Object.assign({ kind, id: nid }, p);
    if (mat !== undefined) solid.mat = mat;
    if (part) solid.part = String(part);
    s.solids.push(solid);
    return Object.assign(commit(spec, s, `add_solid ${nid}`), { id: nid });
  },
  join(spec, { how, a, b, params, id }) {
    const s = clone(spec),
      p = clone(plainParams(params));
    if (!JOINS.includes(how)) {
      let best = null,
        bd = 3;
      for (const j of JOINS) if (lev(how, j) < bd) ((bd = lev(how, j)), (best = j));
      throw new EditError(`no way of joining called "${how}"` + (best ? ` (did you mean "${best}"?)` : '') + `; ways: ${JOINS.join(', ')}`);
    }
    if (a === b) throw new EditError('join needs two different solids');
    const ia = topIndex(s, a),
      ib = topIndex(s, b);
    const A = s.solids[ia],
      B = s.solids[ib];
    const outer = { kind: 'join', how };
    for (const k of OUTER_KEYS) if (A[k] !== undefined) outer[k] = A[k];
    if (outer.part === undefined && B.part !== undefined) outer.part = B.part;
    if (outer.mat === undefined && B.mat !== undefined) outer.mat = B.mat;
    for (const S of [A, B]) for (const k of OUTER_KEYS) delete S[k];
    Object.assign(outer, p);
    outer.id = id ? String(id) : a;
    outer.a = A;
    outer.b = B;
    s.solids = s.solids.filter((_, i) => i !== ia && i !== ib);
    if (id) checkId(s, outer.id);
    s.solids.splice(Math.min(ia, ib), 0, outer);
    return Object.assign(commit(spec, s, `join ${how} ${a} ${b}`), { id: outer.id });
  },
  wrap(spec, { op, id, params }) {
    const s = clone(spec),
      p = clone(plainParams(params));
    if (!WRAPS.includes(op)) throw new EditError(`no wrap called "${op}"; wraps: ${WRAPS.join(', ')}`);
    const i = topIndex(s, id),
      inner = s.solids[i],
      outer = { kind: op };
    for (const k of OUTER_KEYS) if (inner[k] !== undefined) outer[k] = inner[k];
    for (const k of OUTER_KEYS) delete inner[k];
    Object.assign(outer, p, { id, of: inner });
    s.solids[i] = outer;
    return Object.assign(commit(spec, s, `wrap ${op} ${id}`), { id });
  },
  edit_part(spec, { id, params }) {
    const s = clone(spec),
      p = clone(plainParams(params)),
      { s: solid, depth } = find(s, id);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'id' || k === 'kind') throw new EditError(`"${k}" cannot be changed; remove the solid and add a new one`);
      if (['a', 'b', 'of'].includes(k) && isObj(solid[k])) throw new EditError(`"${k}" is a nested solid; edit it by its own id`);
      if (k === 'part' && depth > 0) throw new EditError('only a top-level solid can be a moving part');
      if (v === null) delete solid[k];
      else solid[k] = v;
    }
    return commit(spec, s, `edit_part ${id}`);
  },
  remove_part(spec, { id }) {
    const s = clone(spec),
      i = topIndex(s, id),
      gone = s.solids[i];
    s.solids.splice(i, 1);
    // drop a moving part (and its motions) that no solid belongs to any more
    if (gone.part && !s.solids.some(q => q.part === gone.part)) {
      if (s.parts) delete s.parts[gone.part];
      if (s.motion) s.motion = s.motion.filter(m => m.part !== gone.part);
      if (s.motion && !s.motion.length) delete s.motion;
      if (s.parts && !Object.keys(s.parts).length) delete s.parts;
    }
    return commit(spec, s, `remove_part ${id}`);
  },
  move(spec, { id, by }) {
    if (!isVec(by, 3)) throw new EditError('by must be [dx, dy, dz]');
    const s = clone(spec),
      { s: solid } = find(s, id);
    shift(solid, by);
    if (solid.part && s.parts && s.parts[solid.part] && s.parts[solid.part].joint && s.solids.filter(q => q.part === solid.part).length === 1)
      s.parts[solid.part].joint = s.parts[solid.part].joint.map((v, k) => v + by[k]);
    return commit(spec, s, `move ${id}`);
  },
  spin(spec, { id, turn }) {
    if (!isVec(turn, 3)) throw new EditError('turn must be [yaw, tilt, roll] in radians (a fixed orientation; for motion use add_motion)');
    const s = clone(spec),
      { s: solid } = find(s, id);
    if (turn.every(v => v === 0)) delete solid.turn;
    else solid.turn = turn;
    return commit(spec, s, `spin ${id}`);
  },
  set_material(spec, { id, mat }) {
    const s = clone(spec),
      { s: solid } = find(s, id);
    if (mat === undefined || mat === null) throw new EditError('mat is required: a role name like "stone" or {"role": "wood", "noise": 0.2}');
    solid.mat = mat;
    return commit(spec, s, `set_material ${id}`);
  },
  set_style(spec, { style, roles, palette }) {
    const s = clone(spec);
    if (style !== undefined) s.style = style;
    if (roles !== undefined) {
      if (roles === null) delete s.roles;
      else s.roles = Object.assign({}, s.roles, roles);
    }
    if (palette !== undefined) {
      if (palette === null) delete s.palette;
      else s.palette = palette.map(c => (typeof c === 'string' ? parseInt(c.replace(/^#|^0x/, ''), 16) : c));
    }
    return commit(spec, s, 'set_style');
  },
  set_light(spec, { sun, amb, sky }) {
    const s = clone(spec);
    s.light = Object.assign({}, s.light);
    if (sun !== undefined) s.light.sun = sun;
    if (amb !== undefined) s.light.amb = amb;
    if (sky !== undefined) s.light.sky = sky;
    return commit(spec, s, 'set_light');
  },
  set_camera(spec, { target, dist, pitch, yaw }) {
    const s = clone(spec);
    s.camera = Object.assign({}, s.camera);
    if (target !== undefined) s.camera.target = target;
    if (dist !== undefined) s.camera.dist = dist;
    if (pitch !== undefined) s.camera.pitch = pitch;
    if (yaw !== undefined) s.camera.yaw = yaw;
    for (const [k, v] of Object.entries(s.camera))
      if (k === 'target' ? !isVec(v, 3) : typeof v !== 'number' || !Number.isFinite(v)) throw new EditError(`camera.${k} is not valid: ${JSON.stringify(v)}`);
    if (s.camera.dist <= 0) throw new EditError('camera.dist must be above 0');
    return commit(spec, s, 'set_camera');
  },
  add_motion(spec, { do: what, part, params, joint }) {
    if (!MOTIONS.includes(what)) throw new EditError(`no motion called "${what}"; motions: ${MOTIONS.join(', ')}`);
    const s = clone(spec),
      p = clone(plainParams(params)),
      members = s.solids.filter(q => q.part === part);
    if (!members.length) {
      const names = [...new Set(s.solids.map(q => q.part).filter(Boolean))];
      throw new EditError(`no solid is marked as part "${part}"` + (names.length ? ` (parts: ${names.join(', ')})` : '') + '; give a solid "part" with add_solid or edit_part first');
    }
    s.parts = Object.assign({}, s.parts);
    const pj = Object.assign({}, s.parts[part]);
    if (joint !== undefined) pj.joint = joint;
    if (!pj.joint) pj.joint = centroid(members);
    s.parts[part] = pj;
    s.motion = (s.motion || []).concat([Object.assign({ do: what, part }, p)]);
    return commit(spec, s, `add_motion ${what} ${part}`);
  },
  remove_motion(spec, { part }) {
    const s = clone(spec);
    const before = (s.motion || []).length;
    s.motion = (s.motion || []).filter(m => m.part !== part);
    if (s.motion.length === before) throw new EditError(`no motion on part "${part}"`);
    if (!s.motion.length) delete s.motion;
    return commit(spec, s, `remove_motion ${part}`);
  }
};

function isVec(v, n) {
  return Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x));
}
// shift every position in a solid (and the solids inside it) by d
function shift(s, d) {
  const add = v => v.map((x, k) => x + d[k]);
  for (const k of ['at', 'centre']) if (isVec(s[k], 3)) s[k] = add(s[k]);
  if (Array.isArray(s.pts)) s.pts = s.pts.map(p => (isVec(p, 3) ? add(p) : p));
  for (const k of ['a', 'b']) {
    if (isVec(s[k], 3)) s[k] = add(s[k]);
    else if (isObj(s[k])) shift(s[k], d);
  }
  if (isObj(s.of)) shift(s.of, d);
}
function centroid(solids) {
  const pts = [];
  const take = s => {
    if (isVec(s.at, 3)) pts.push(s.at);
    else if (Array.isArray(s.pts)) s.pts.filter(p => isVec(p, 3)).forEach(p => pts.push(p));
    for (const k of ['a', 'b', 'of']) if (isObj(s[k])) take(s[k]);
  };
  solids.forEach(take);
  if (!pts.length) return [0, 0, 0];
  return [0, 1, 2].map(k => Math.round((pts.reduce((a, p) => a + p[k], 0) / pts.length) * 1000) / 1000);
}

// a short outline of the scene for the model
function outline(spec) {
  const one = s => {
    const bits = [s.kind + (s.how ? ':' + s.how : '')];
    if (s.at) bits.push('at ' + JSON.stringify(s.at));
    if (s.mat !== undefined) bits.push('mat ' + (typeof s.mat === 'string' ? s.mat : JSON.stringify(s.mat)));
    if (s.part) bits.push('part ' + s.part);
    const inner = ['a', 'b', 'of'].filter(k => isObj(s[k])).map(k => `${k}=${s[k].id || s[k].kind}`);
    return `${s.id || '(no id)'}: ${bits.concat(inner).join(', ')}`;
  };
  const lines = (spec.solids || []).map(one);
  return [
    `style ${typeof spec.style === 'string' ? spec.style : 'custom'}; camera ${JSON.stringify(spec.camera)}`,
    lines.length ? 'solids:\n  ' + lines.join('\n  ') : 'no solids yet',
    spec.motion ? 'motion: ' + spec.motion.map(m => `${m.do} ${m.part}`).join('; ') : ''
  ].filter(Boolean).join('\n');
}

module.exports = { ops, blank, problems, errorsOf, report, outline, EditError, WRAPS, JOINS, MOTIONS, find, allIds, shift, centroid };
