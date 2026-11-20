'use strict';
// VGGT-Omega for the 3D bot: the same queued dell-annotate "vggt" stage and resumable copy that Vision's reconstruct_3d
// uses (shared ~/Code/dell-annotate-client), plus a layout summary of each shot's point cloud in scene terms (Y up) so
// the 3D bot can block out a scene from a real video. Outputs go to ~/splats/vggt/<dell job id>/; the keyless viewer
// is /r/<token>/ on the splat service (LAN only).
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const HOME = os.homedir();
const mkClient = require(path.join(HOME, 'Code', 'dell-annotate-client'));
const ENV_FILE = process.env.SPLAT_DELL_ENV || path.join(HOME, '.hermes', 'profiles', 'splat', '.env');
const DA = mkClient({ envFile: ENV_FILE, waitMs: 12 * 60 * 1000 });   // under the 15 min MCP call timeout (config.yaml timeout 900)
const WAIT_DEFAULT_S = 720, WAIT_MAX_S = 840;
// a client that waits wait_s seconds for this call (the shared client is unchanged; Vision keeps its own)
const clientFor = waitS => (waitS === WAIT_DEFAULT_S ? DA : mkClient({ envFile: ENV_FILE, waitMs: Math.max(1, waitS * 1000) }));
const MEDIA = ['vggt.mp4', 'vggt_preview.jpg'];   // what Mo is shown; cameras/layout/ply stay files
const uerr = m => Object.assign(new Error(m), { userError: true });
const IDS = require('./ids.js');
// Vision's job dirs (same Dell job ids) count for prefixes too: reconstruct_3d accepts a Vision job id
const VISION_DIR = process.env.SPLAT_VISION_DIR || path.join(HOME, 'vision');
const ROOT = process.env.SPLAT_VGGT_DIR || path.join(process.env.SPLAT_DIR || path.join(HOME, 'splats'), 'vggt');
const jobDir = id => { if (!DA.JOB_RE.test(id || '')) throw uerr(`error reconstruct_3d.video: "${id}" is not a video id; give "latest", the 16-hex id from upload_video or a unique start of it, for example "2623"`); return path.join(ROOT, id); };
function token(id) {
  const f = path.join(jobDir(id), 'view.token');
  if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(18).toString('hex'), { mode: 0o600 }); }
  return fs.readFileSync(f, 'utf8').trim();
}
function byToken(t) {
  if (!/^[0-9a-f]{36}$/.test(t) || !fs.existsSync(ROOT)) return null;
  for (const id of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, id, 'view.token');
    if (DA.JOB_RE.test(id) && fs.existsSync(f) && crypto.timingSafeEqual(Buffer.from(fs.readFileSync(f, 'utf8').trim()), Buffer.from(t))) return id;
  }
  return null;
}

// ---- layout: per shot, the cloud in a Y-up frame from the mean camera axes (OpenCV: x right, y down, z forward)
function readCloud(file, maxPts) {
  const buf = fs.readFileSync(file), end = buf.indexOf('end_header\n');
  const head = buf.slice(0, end).toString();
  if (!/binary_little_endian/.test(head) || !/property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue/.test(head))
    throw new Error(`${path.basename(file)}: unexpected ply layout`);
  const n = +/element vertex (\d+)/.exec(head)[1], off = end + 11, step = Math.max(1, Math.floor(n / maxPts)), out = [];
  for (let i = 0; i < n; i += step) { const q = off + i * 15; out.push([buf.readFloatLE(q), buf.readFloatLE(q + 4), buf.readFloatLE(q + 8), buf[q + 12], buf[q + 13], buf[q + 14]]); }
  return { n, pts: out };
}
const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pct = (arr, p) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]; };
const r2 = v => Math.round(v * 100) / 100;
const hex = c => '#' + c.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
function layout(dir, cams, shot, grid = 8) {
  const cs = cams.filter(c => c.shot === shot.shot);
  const mean = k => norm([0, 1, 2].map(a => cs.reduce((s, c) => s + c.extrinsic_cam_from_world[k][a], 0)));
  const up = mean(1).map(x => -x), fwd0 = mean(2);
  const fwd = norm(fwd0.map((x, a) => x - dot(fwd0, up) * up[a])), right = norm([up[1] * fwd[2] - up[2] * fwd[1], up[2] * fwd[0] - up[0] * fwd[2], up[0] * fwd[1] - up[1] * fwd[0]]);
  // scene frame: X = right, Y = up, Z = towards the camera (so the camera looks down -Z, like the Ink camera at yaw 0)
  const tf = p => [dot(p, right), dot(p, up), -dot(p, fwd)];
  const { n, pts } = readCloud(path.join(dir, shot.ply), 200000);
  const P = pts.map(p => tf(p));
  const lo = [0, 1, 2].map(a => pct(P.map(p => p[a]), 2)), hi = [0, 1, 2].map(a => pct(P.map(p => p[a]), 98));
  const W = Math.max(hi[0] - lo[0], hi[2] - lo[2]), s = 10 / W;   // scale so the shot is ~10 scene units across
  const cells = Array.from({ length: grid * grid }, () => ({ h: [], c: [0, 0, 0], k: 0 }));
  pts.forEach((p, i) => {
    const q = P[i];
    if (q[0] < lo[0] || q[0] > hi[0] || q[2] < lo[2] || q[2] > hi[2] || q[1] < lo[1] || q[1] > hi[1]) return;
    const gx = Math.min(grid - 1, Math.floor(((q[0] - lo[0]) / (hi[0] - lo[0])) * grid)), gz = Math.min(grid - 1, Math.floor(((q[2] - lo[2]) / (hi[2] - lo[2])) * grid));
    const c = cells[gz * grid + gx]; c.h.push((q[1] - lo[1]) * s); c.k++; for (let a = 0; a < 3; a++) c.c[a] += p[3 + a];
  });
  const camPos = cs.map(c => tf(c.centre).map((v, a) => r2((v - (a === 1 ? lo[1] : (lo[a] + hi[a]) / 2)) * s)));
  return {
    shot: shot.shot, frames: shot.frames, points: n, sampled_points: pts.length,
    scale_to_scene: r2(s), note: 'scene units: X right, Y up from the floor (2nd percentile), Z towards the camera; centred on X/Z; relative scale, not metres',
    size: [r2((hi[0] - lo[0]) * s), r2((hi[1] - lo[1]) * s), r2((hi[2] - lo[2]) * s)],
    camera_start: camPos[0], camera_end: camPos[camPos.length - 1],
    grid: { cells: grid, cell_size: [r2(((hi[0] - lo[0]) * s) / grid), r2(((hi[2] - lo[2]) * s) / grid)], rows_far_to_near: Array.from({ length: grid }, (_, gz) =>
      Array.from({ length: grid }, (_, gx) => { const c = cells[gz * grid + gx]; return c.k < 20 ? null : { top: r2(pct(c.h, 95)), colour: hex(c.c.map(x => x / c.k)) }; })) }
  };
}
const gridText = L => L.grid.rows_far_to_near.map(r => r.map(c => (c ? `${c.top.toFixed(1).padStart(4)}${c.colour}` : '   .   ...')).join(' ')).join('\n');

// ---- arguments: new Ink-style names, old names still accepted (both given and different = error, no guessing)
function pick(a, tool, name, old) {
  const has = k => a[k] !== undefined && a[k] !== null && a[k] !== '';
  if (has(name) && has(old) && a[name] !== a[old]) throw uerr(`error ${tool}.${name}: give ${name} or its old name ${old}, not both`);
  return has(name) ? a[name] : has(old) ? a[old] : undefined;
}
const KNOWN = { upload_video: ['path', 'url', 'start', 'duration', 'name'], reconstruct_3d: ['video', 'frames', 'trim', 'wait_s', 'job_id', 'max_frames', 'conf_percentile'] };
function known(a, tool) {
  const bad = Object.keys(a).filter(k => !KNOWN[tool].includes(k));
  if (bad.length) throw uerr(`error ${tool}.${bad[0]}: nothing is called "${bad[0]}" here; what may be written: ${KNOWN[tool].slice(0, tool === 'reconstruct_3d' ? 4 : 5).join(', ')}`);
}
function knownIds() {
  const ours = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter(id => DA.JOB_RE.test(id) && fs.existsSync(path.join(ROOT, id, 'view.token'))) : [];
  ours.sort((x, y) => fs.statSync(path.join(ROOT, y, 'view.token')).mtimeMs - fs.statSync(path.join(ROOT, x, 'view.token')).mtimeMs);
  const vis = fs.existsSync(VISION_DIR) ? fs.readdirSync(VISION_DIR).filter(id => DA.JOB_RE.test(id) && !ours.includes(id)) : [];
  vis.sort((x, y) => fs.statSync(path.join(VISION_DIR, y)).mtimeMs - fs.statSync(path.join(VISION_DIR, x)).mtimeMs);
  return ours.concat(vis);
}
function newest() {
  const ids = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter(id => DA.JOB_RE.test(id) && fs.existsSync(path.join(ROOT, id, 'view.token'))) : [];
  ids.sort((x, y) => fs.statSync(path.join(ROOT, y, 'view.token')).mtimeMs - fs.statSync(path.join(ROOT, x, 'view.token')).mtimeMs);
  return ids[0];
}
function nameOf(d) {
  for (const f of ['job.json', 'upload.json']) {
    const p = path.join(d, f);
    if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.clip && j.clip.name) return j.clip.name; }
  }
  return null;
}

// ---- one engine at a time (Mo 18:21 20 Nov): a rebuild asked for while Articraft holds the 3D bot is queued here
// (<video dir>/.engine-wait.json with its frames/trim) and started by the service's tick as soon as Articraft is free,
// whether or not the 3D bot calls again. From the Dell POST until its files are here the video is "active"
// (.engine-active.json): ink.json lists it, so Articraft waits for it. A failure while nobody was waiting is kept in
// .engine-error.json and told on the next reconstruct_3d call for that video.
const WAITF = '.engine-wait.json', ACTF = '.engine-active.json', ERRF = '.engine-error.json';
const POLL_MS = +(process.env.SPLAT_ENGINE_POLL_MS || 2000), TICK_MS = +(process.env.SPLAT_ENGINE_TICK_MS || 15000);
let eng = { gate: () => null, onChange: () => {}, log: () => {} };
const mk = (id, f) => path.join(ROOT, id, f);
const readM = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const writeM = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
const rmM = f => fs.rmSync(f, { force: true });
const withMarker = f => (fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter(id => DA.JOB_RE.test(id) && fs.existsSync(mk(id, f))) : []);
const active = () => withMarker(ACTF);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const calls = new Map();   // video id -> the Dell call running for it now (one at a time per video)
function dellCall(id, params, waitS) {
  const p = (async () => {
    writeM(mk(id, ACTF), { params, since: Date.now() / 1000 });
    rmM(mk(id, WAITF));
    eng.onChange();
    try {
      const r = await clientFor(waitS).vggt(id, params, jobDir(id));
      rmM(mk(id, ACTF));
      eng.onChange();
      return r;
    } catch (e) {
      if (!(e instanceof DA.Pending)) { rmM(mk(id, ACTF)); eng.onChange(); }
      throw e;
    }
  })();
  calls.set(id, p);
  const clr = () => calls.get(id) === p && calls.delete(id);
  p.then(clr, clr);
  return p;
}
// the service's tick: start queued rebuilds once Articraft is free; finish the copies of active ones nobody waits on
async function tick() {
  for (const id of withMarker(WAITF).concat(active())) {
    if (calls.has(id)) continue;
    const w = readM(mk(id, WAITF)), a = readM(mk(id, ACTF));
    if (w && eng.gate()) continue;
    dellCall(id, (w || a).params, 0).then(() => eng.log('vggt', id, 'done (started by the tick)'), e => {
      if (e instanceof DA.Pending) return;
      writeM(mk(id, ERRF), { error: e.message, at: Date.now() / 1000 });
      eng.log('vggt', id, 'FAILED (started by the tick):', e.message);
    });
  }
}
function setEngine(o) {
  eng = Object.assign(eng, o);
  setInterval(() => tick().catch(e => eng.log('vggt tick error:', e.message)), TICK_MS).unref();
}

async function upload_video(a) {
  known(a, 'upload_video');
  if (!!a.path === !!a.url) throw uerr(`error upload_video.${a.path ? 'url' : 'path'}: ${a.path ? 'give path or url, not both' : 'give path (a file on this machine) or url (http/https)'}; for example path "/home/mohammed/.hermes/image_cache/clip.mp4"`);
  for (const k of ['start', 'duration']) if (a[k] != null && !(typeof a[k] === 'number' && a[k] >= 0)) throw uerr(`error upload_video.${k}: must be seconds, 0 or more; for example 2.5`);
  const j = await DA.startJob(a);
  const d = jobDir(j.job);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'upload.json'), JSON.stringify({ job: j.job, clip: j.clip, uploaded: new Date().toISOString() }, null, 1));
  token(j.job);
  const c = j.clip || {};
  return { text: `${j.job}: uploaded "${c.name || a.name || 'clip'}"${c.duration_s != null ? ` (${c.duration_s} s, ${c.width}x${c.height})` : ''}. Next: reconstruct_3d with video "${j.job}".` };
}
async function reconstruct_3d(a) {
  known(a, 'reconstruct_3d');
  let id = pick(a, 'reconstruct_3d', 'video', 'job_id');
  const frames = pick(a, 'reconstruct_3d', 'frames', 'max_frames'), trim = pick(a, 'reconstruct_3d', 'trim', 'conf_percentile');
  const waitS = a.wait_s === undefined || a.wait_s === null ? WAIT_DEFAULT_S : a.wait_s;
  if (frames !== undefined && !(Number.isInteger(frames) && frames >= 1 && frames <= 100)) throw uerr('error reconstruct_3d.frames: must be a whole number 1..100 (frames per shot); for example 60');
  if (trim !== undefined && !(typeof trim === 'number' && trim >= 0 && trim <= 99)) throw uerr('error reconstruct_3d.trim: must be 0..99 (percent of least confident points dropped); for example 20');
  if (!(Number.isInteger(waitS) && waitS >= 0 && waitS <= WAIT_MAX_S)) throw uerr(`error reconstruct_3d.wait_s: must be a whole number 0..${WAIT_MAX_S}; for example ${WAIT_DEFAULT_S}`);
  if (id === undefined || String(id).trim().toLowerCase() === 'latest') {
    id = newest();
    if (!id) throw uerr('error reconstruct_3d.video: there is no video yet; call upload_video first');
  }
  id = IDS.resolve(id, knownIds(), { tool: 'reconstruct_3d', arg: 'video', noun: 'video' }) || String(id).trim().toLowerCase();
  const d = jobDir(id);
  fs.mkdirSync(d, { recursive: true }); token(id);
  const t0 = Date.now();
  const err = readM(mk(id, ERRF));
  if (err) {
    rmM(mk(id, ERRF));
    throw uerr(`error reconstruct_3d: the queued rebuild of ${id} failed on the Dell: ${err.error}. Call reconstruct_3d again with video "${id}" to run it again`);
  }
  let params = { max_frames: frames, conf_percentile: trim };
  const w = readM(mk(id, WAITF));
  if (w) params = w.params;   // queued earlier: keep the frames/trim it was queued with
  let g = calls.has(id) || fs.existsSync(mk(id, ACTF)) ? null : eng.gate();
  if (g || w) {
    if (!w) { writeM(mk(id, WAITF), { params, since: Date.now() / 1000, waiting_on: g.job_id }); eng.onChange(); }
    while ((g = eng.gate()) && Date.now() - t0 < waitS * 1000) await sleep(POLL_MS);
    if (g)
      throw new DA.Pending(`${id}: queued here, waiting for ${g.brief}; the 3D bot runs one engine at a time. ` +
        `It starts by itself when that job finishes and is not lost: check with articraft_status ${g.job_id}, and call reconstruct_3d again with video "${id}" to keep waiting.`);
  }
  const left = Math.max(0, Math.round(waitS - (Date.now() - t0) / 1000));
  let s;
  try {
    while (calls.has(id)) await calls.get(id).catch(() => {});   // the tick's call for this video ends first
    ({ stage: s } = await dellCall(id, params, left));
  } catch (e) {
    if (e instanceof DA.Pending) throw new DA.Pending(`${id}: ${e.message.replace(/after \d+ min\. .*$/, `after ${waitS} s.`)} This is not a failure: call reconstruct_3d again with video "${id}" to keep waiting (it never runs twice).`);
    throw e;
  }
  const cams = JSON.parse(fs.readFileSync(path.join(d, 'vggt_cameras.json'), 'utf8'));
  const L = cams.shots.map(sh => layout(d, cams.cameras, sh));
  fs.writeFileSync(path.join(d, 'vggt_layout.json'), JSON.stringify(L, null, 1));
  const name = nameOf(d) || id, used = (s.params && s.params.max_frames) || 60;
  const lines = [`${id}: reconstructed "${name}" (${cams.shots.length} shot${cams.shots.length > 1 ? 's' : ''}, ${cams.shots.map(x => x.sampled).join('/')} frames sampled, up to ${used} per shot, ${s.secs} s on the Dell)`, `Viewer: ${viewerUrl(id)}`];
  if (frames !== undefined && frames !== used) lines.push(`note: this video was already reconstructed with frames ${used}; that stored result is returned (a reconstruction is never re-run)`);
  for (const l of L)
    lines.push(`Shot ${l.shot} (frames ${l.frames.join('-')}, ${l.points} points): size in scene units ${JSON.stringify(l.size)} (x, height, depth); camera from ${JSON.stringify(l.camera_start)} to ${JSON.stringify(l.camera_end)}. ` +
      `Top-down ${l.grid.cells}x${l.grid.cells} grid (rows far to near, left to right; each cell = ${l.grid.cell_size.join(' x ')}): height of the top surface and its mean colour, "." = empty:\n${gridText(l)}`);
  lines.push('To build a scene from it: start_scene, then block out the big masses from a shot\'s grid (ground, walls, furniture at those heights and colours), then refine with render/turn against the preview.');
  lines.push(`Files: ${d}/ (vggt_cameras.json, vggt_layout.json, vggt_depth.npz, ${cams.shots.map(x => x.ply).join(', ')})`);
  lines.push('To show Mo, reply with exactly these lines:', `Viewer: ${viewerUrl(id)}`, ...MEDIA.map(n => 'MEDIA:' + path.join(d, n)));
  return { text: lines.join('\n'), image: path.join(d, 'vggt_preview.jpg') };
}
// the last 10 videos here, newest first: local state only (no Dell call)
function list_reconstructions(a) {
  if (Object.keys(a || {}).length) throw uerr(`error list_reconstructions.${Object.keys(a)[0]}: this tool takes no arguments`);
  const ids = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter(id => DA.JOB_RE.test(id) && fs.existsSync(path.join(ROOT, id, 'view.token'))) : [];
  if (!ids.length) return { text: 'No videos yet.' };
  const at = id => fs.statSync(path.join(ROOT, id, 'view.token')).mtimeMs;
  ids.sort((x, y) => at(y) - at(x));
  const when = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 16);
  return { text: ids.slice(0, 10).map(id => {
    const d = path.join(ROOT, id), files = fs.readdirSync(d);
    let state, shots = '';
    if (files.includes(WAITF)) state = 'waiting for Articraft (queued here)';
    else if (files.some(n => /^\.pull-[a-z0-9_]+\.json$/.test(n))) state = 'copying';
    else if (files.includes('vggt_layout.json') && MEDIA.every(n => files.includes(n))) {
      state = 'done';
      const n = JSON.parse(fs.readFileSync(path.join(d, 'vggt_cameras.json'), 'utf8')).shots.length;
      shots = `: ${n} shot${n > 1 ? 's' : ''}`;
    } else state = 'not reconstructed here yet';
    return `${id} ${state} "${nameOf(d) || id}", ${when(at(id))} London${shots}, viewer ${viewerUrl(id)}`;
  }).join('\n') };
}
let bind = null;
const viewerUrl = id => `http://${bind.host}:${bind.port}/r/${token(id)}/`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function page(id) {
  const d = jobDir(id), files = fs.readdirSync(d).filter(n => n !== 'view.token' && !n.startsWith('.') && !n.endsWith('.part')).sort();
  const j = fs.existsSync(path.join(d, 'job.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'job.json'), 'utf8')) : {};
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>3D bot · VGGT ${esc(id)}</title>
<style>body{background:#000;color:#ddd;font:14px/1.4 system-ui,sans-serif;margin:0;padding:12px}video,img{max-width:100%;border:1px solid #333}a{color:#8cf}</style>
<h3>3D bot · VGGT-Omega · ${esc(j.clip ? j.clip.name : id)}</h3>${files.includes('vggt.mp4') ? '<video src="vggt.mp4" controls loop autoplay muted playsinline></video>' : '<p>Not reconstructed yet.</p>'}
${files.includes('vggt_preview.jpg') ? '<p><a href="vggt_preview.jpg"><img src="vggt_preview.jpg"></a></p>' : ''}<p>${files.map(n => `<a href="${esc(n)}">${esc(n)}</a>`).join(' · ')}</p>`;
}
const TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.json': 'application/json', '.npz': 'application/octet-stream', '.ply': 'application/octet-stream' };
// HTTP: GET /r/<token>/ (page) and /r/<token>/<file> with ranges; returns false if the path is not ours
function serve(req, res, pathname) {
  const m = /^\/r\/([0-9a-f]+)\/(.*)$/.exec(pathname);
  if (!m) return false;
  const id = byToken(m[1]);
  if (!id) { res.writeHead(404); res.end('not found\n'); return true; }
  if (!m[2]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(id)); return true; }
  const f = path.join(jobDir(id), m[2]);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(m[2]) || m[2] === 'view.token' || !fs.existsSync(f)) { res.writeHead(404); res.end('not found\n'); return true; }
  const size = fs.statSync(f).size, type = TYPES[path.extname(f)] || 'application/octet-stream', r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) { const s = r[1] ? +r[1] : size - +r[2], e = r[1] && r[2] ? +r[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' }); if (req.method === 'HEAD') res.end(); else fs.createReadStream(f, { start: s, end: e }).pipe(res); return true; }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' }); if (req.method === 'HEAD') res.end(); else fs.createReadStream(f).pipe(res);
  return true;
}
module.exports = { setEngine, active, tick, upload_video, video_job: upload_video, reconstruct_3d, list_reconstructions, serve, setBind: (host, port) => (bind = { host, port }), resume: log => DA.resumePulls(ROOT, log), Pending: DA.Pending, layout, ROOT };
