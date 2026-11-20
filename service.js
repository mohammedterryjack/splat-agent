'use strict';
// splat-agent service: the 3D bot's scenes, one at a time. The 3D bot (Hermes profile "splat") drives it through
// mcp.js; GlaDOS only hands Mo's request to the 3D bot and relays its reply, so nothing here knows about GlaDOS.
//   * a unix socket (owner-only) for mcp.js and cancel.js: newline-delimited JSON requests
//       {op: "tool", name, args} | {op: "status"} | {op: "close_job", job_id?, reason} (the cancel) | {op: "job", job_id}
//   * HTTP on the LAN address only: the keyless viewer at /v/<token>/ (unguessable token per scene), and the scene
//     files at /files/<job_id>/<name> behind "Authorization: Bearer <SPLAT_AGENT_KEY>".
// Builds and renders run on a worker thread (engine.js). Cap: 250000 splats per scene (no step, time or render
// limit); hitting it fails the scene with the reason. The loop check (loopcheck.js) warns once, then fails a scene
// that keeps tearing down and rebuilding its parts. finish needs a turn(4) on the final scene, and answers with the
// lines the 3D bot replies with: title and summary, the viewer link, and MEDIA: lines for final.png, preview.mp4
// and scene.ply.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  net = require('net'),
  http = require('http'),
  crypto = require('crypto'),
  { Worker } = require('worker_threads');
const S = require('./scene.js');
const { TOOLS, KIND_NOTES, COMMON_NOTE, RECON_NOTE, ALIASES } = require('./tools.js');
const LC = require('./loopcheck.js');
const VG = require('./vggt.js');
const VG_TOOLS = ['upload_video', 'reconstruct_3d', 'list_reconstructions'];   // VGGT-Omega via dell-annotate (shared client with vision-agent)
const A = require('./assets.js');
const M = require('./mode.js');   // one engine at a time with Articraft (ink.json / articraft.json)
const IDS = require('./ids.js');   // unique hex prefixes for scene ids   // the model library (list_assets, mesh solids)

const need = k => { const v = process.env[k]; if (!v) throw new Error(k + ' is not set (see .env.example)'); return v; };
const HOME = os.homedir();
const CFG = {
  splats: process.env.SPLAT_DIR || path.join(HOME, 'splats'),
  sock: process.env.SPLAT_SOCK || path.join(HOME, '.hermes', 'splat-agent', 'worker.sock'),
  bind: need('SPLAT_BIND'),
  port: +(process.env.SPLAT_PORT || 8646),
  env: process.env.SPLAT_ENV_FILE || path.join(HOME, '.hermes', '.env'),
  maxSplats: 250000,
  // an open scene with no tool call for this long is closed (failed, "stale"), so a crashed 3D bot turn cannot keep
  // Articraft waiting forever
  staleS: +(process.env.SPLAT_STALE_S || 1800),
  staleCheckMs: +(process.env.SPLAT_STALE_CHECK_MS || 30000)
};
const JOB_ID_RE = /^[0-9a-f]{16}$/;
const FILES = { 'scene.ply': 'application/octet-stream', 'final.png': 'image/png', 'preview.mp4': 'video/mp4', 'scene.json': 'application/json', 'transcript.jsonl': 'application/x-ndjson' };

const log = (...a) => console.log(new Date().toISOString(), ...a);

function readKey() {
  const m = /^SPLAT_AGENT_KEY=(.+)$/m.exec(fs.readFileSync(CFG.env, 'utf8'));
  if (!m || m[1].trim().length < 32) throw new Error(`SPLAT_AGENT_KEY is missing or short in ${CFG.env}`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

// ---------------- the engine thread ----------------
let engine = null,
  seq = 0;
const waiting = new Map();
function startEngine() {
  engine = new Worker(path.join(__dirname, 'engine.js'));
  engine.on('message', m => {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.ok ? w.resolve(m.result) : w.reject(Object.assign(new Error(m.error), { cap: m.cap, count: m.count }));
  });
  engine.on('error', e => {
    log('engine thread error:', e.message);
    for (const w of waiting.values()) w.reject(new Error('engine thread crashed: ' + e.message));
    waiting.clear();
  });
  engine.on('exit', code => {
    log('engine thread exited', code);
    for (const w of waiting.values()) w.reject(new Error('engine thread exited with ' + code));
    waiting.clear();
    engine = null;
  });
}
function run(op, args) {
  if (!engine) startEngine();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    engine.postMessage({ id, op, args });
  });
}

// ---------------- jobs ----------------
let job = null; // the open job, or null
const jobDir = id => path.join(CFG.splats, id);
function saveJob(j) {
  const f = path.join(j.dir, 'job.json'),
    tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 1));
  fs.renameSync(tmp, f);
}
function loadJob(id) {
  return JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf8'));
}
function transcript(j, rec) {
  fs.appendFileSync(path.join(j.dir, 'transcript.jsonl'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n');
}
const userError = msg => Object.assign(new Error(msg), { userError: true });
let ended = null; // the scene that was failed or cancelled while open: the 3D bot's next call hears why, once
let lastCall = 0, inflight = 0;   // for the stale-scene timeout
// ink.json: the open scene and the video rebuilds in flight; Articraft starts a job only when both are empty
function writeMode() {
  M.write('ink', {
    stale_after_s: CFG.staleS,
    scene: job ? { job_id: job.job_id, started: job.started_at / 1000, last_call: lastCall / 1000, steps: job.steps } : null,
    reconstructions: VG.active()
  });
}

// the scene ends without a result (the splat cap, a cancel, a service stop)
function failJob(j, reason) {
  if (j.status !== 'open') return;
  j.status = 'failed';
  j.error = reason;
  j.finished_at = Date.now();
  saveJob(j);
  transcript(j, { event: 'failed', reason });
  log('job', j.job_id, 'FAILED:', reason);
  if (job === j) {
    job = null;
    ended = { job_id: j.job_id, reason };
    writeMode();
  }
}

function allJobs() {
  if (!fs.existsSync(CFG.splats)) return [];
  const out = [];
  for (const id of fs.readdirSync(CFG.splats)) {
    if (!JOB_ID_RE.test(id)) continue;
    try {
      out.push(loadJob(id));
    } catch (e) {}
  }
  return out.sort((a, b) => (b.finished_at || b.started_at || 0) - (a.finished_at || a.started_at || 0));
}
// "" for a new scene, the newest finished scene for "latest", or a checked finished scene id
function baseScene(based_on) {
  let b = String(based_on || '').trim().toLowerCase();
  if (!b) return null;
  if (b === 'latest') {
    const f = allJobs().find(k => k.status === 'finished');
    if (!f) throw userError('there is no finished scene yet to change');
    return f.job_id;
  }
  const ids = () => allJobs().map(k => k.job_id);
  b = IDS.resolve(b, ids(), { tool: 'start_scene', arg: 'based_on', noun: 'scene' }) || b;
  if (!JOB_ID_RE.test(b)) throw userError(`based_on must be "latest", a 16-hex scene id or a unique start of one, got "${based_on}"`);
  let k;
  try {
    k = loadJob(b);
  } catch (e) {
    throw userError(`there is no scene ${b}`);
  }
  if (k.status !== 'finished') throw userError(`scene ${b} is ${k.status}, not finished, so it cannot be changed`);
  return b;
}
function startScene({ request, based_on }) {
  if (job)
    throw userError(`another 3D scene is being made (scene ${job.job_id}, started ${Math.round((Date.now() - job.started_at) / 60000)} min ago, ${job.steps} steps so far); one at a time. Tell Mo; to stop it he can ask for it to be cancelled.`);
  if (typeof request !== 'string' || !request.trim()) throw userError("request is required: Mo's request in his words");
  const base = baseScene(based_on);
  const spec = base ? JSON.parse(fs.readFileSync(path.join(jobDir(base), 'scene.json'), 'utf8')) : S.blank();
  const job_id = crypto.randomBytes(8).toString('hex'),
    dir = jobDir(job_id);
  fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
  job = { job_id, dir, prompt: request.trim(), base_job: base, spec, steps: 0, renders: 0, turned: null, loop: LC.fresh(), status: 'open', started_at: Date.now(), token: crypto.randomBytes(24).toString('base64url') };
  ended = null;
  saveJob(job);
  transcript(job, { event: 'open', prompt: job.prompt, base_job: base });
  log('job', job_id, 'opened', base ? 'from ' + base : '');
  let t = `Scene ${job_id} started${base ? ` from scene ${base}` : ''}. Live viewer: ${viewerUrl(job)}`;
  if (base) t += `\nThe scene already holds scene ${base}'s solids: change only what the request asks for and keep the rest.\nCurrent scene:\n${S.outline(spec)}`;
  return { text: t };
}
function sceneLines(k) {
  const f = n => path.join(k.dir, n);
  return [`${k.title}: ${k.summary} (${k.splats} splats, scene ${k.job_id})`, `Viewer: ${viewerUrl(k)}`, ...['final.png', 'preview.mp4', 'scene.ply'].map(n => 'MEDIA:' + f(n))];
}
function listScenes() {
  const ks = allJobs().slice(0, 10);
  if (!ks.length) return { text: 'No scenes yet.' };
  return { text: ks.map(k => `${k.job_id} ${k.status}${k.title ? ' "' + k.title + '"' : ''}, ${new Date(k.finished_at || k.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${k.status === 'failed' ? k.error : k.prompt.slice(0, 100)}`).join('\n') };
}
function showScene({ scene }) {
  const b = String(scene || 'latest').trim().toLowerCase();
  const id = b === 'latest' ? (allJobs().find(k => k.status === 'finished') || {}).job_id : IDS.resolve(b, allJobs().map(k => k.job_id), { tool: 'show_scene', arg: 'scene', noun: 'scene' }) || b;
  if (!id) throw userError('there is no finished scene yet');
  if (!JOB_ID_RE.test(id)) throw userError(`scene must be "latest", a 16-hex scene id or a unique start of one, got "${scene}"`);
  let k;
  try {
    k = loadJob(id);
  } catch (e) {
    throw userError(`there is no scene ${id}`);
  }
  if (k.status !== 'finished') throw userError(`scene ${id} is ${k.status}${k.error ? ': ' + k.error : ''}`);
  return { text: 'Reply with exactly these lines, unchanged:\n' + sceneLines(k).join('\n') };
}
const viewerUrl = j => `http://${CFG.bind}:${CFG.port}/v/${j.token}/`;

// ---------------- catalog ----------------
function catalog(q) {
  q = String(q || '').trim().toLowerCase();
  const K = require('./core.js').K,
    kinds = K.diorama.kinds;
  const kindLine = k => {
    const d = kinds[k];
    return `${k}: ${KIND_NOTES[k] || ''}\n  needs ${JSON.stringify(d.need)}${d.may ? ' may ' + JSON.stringify(d.may) : ''}`;
  };
  const usable = Object.keys(kinds).filter(k => !['join', 'fold', 'warp', 'shell', 'swell', 'rough', 'bubbles'].includes(k));
  const sections = {
    kinds: () => usable.map(kindLine).join('\n') + '\n' + COMMON_NOTE,
    joins: () => `join how: ${S.JOINS.join(', ')}. union = merge, cut = a minus b, common = only the overlap, round/chamfer/stairs/columns = blended union with size, engrave/groove/tongue = details along the seam with size.`,
    wraps: () => ['fold', 'warp', 'shell', 'swell', 'rough', 'bubbles'].map(kindLine).join('\n'),
    materials: () => `roles: ${K.diorama.roles.join(', ')}. A material is a role name or {"role": r, "noise": 0..0.3 (mottling), "scale": n, "glow": true (emissive), "ramp": [palette indices dark-to-light], "over": {"role": r2, "patch": 0..1 (patchy cover), "above": 0..1 (only on top faces)}}.`,
    styles: () => Object.entries(K.diorama.styles).map(([n, s]) => `${n}: ${s.palette.length} colours; roles ${Object.entries(s.roles).map(([r, v]) => r + '=' + JSON.stringify(v)).join(' ')}`).join('\n'),
    motion: () => 'add_motion do: spin {axis, speed}, bob {axis, amount, period, phase}, turn {axis, amount (radians of swing), period, phase}, squash {axis, amount, period}. A moving part is every solid with that "part"; its joint is the pivot.',
    camera: () => 'camera: target [x, y, z] looked at, dist from it, pitch (radians, 0.15..0.5 looks down a little), yaw (radians round Y). Fit the whole scene in view; render shows what it sees.',
    reconstruction: () => RECON_NOTE,
    light: () => 'light: sun [x, y, z] direction towards the sun (e.g. [-0.5, 0.8, 0.45]), amb ambient 0..1 (~0.14), sky fill 0..1 (~0.26). Glowing materials ({"glow": true}) light themselves.'
  };
  if (!q || q === 'all' || q === 'help') return 'Sections: ' + Object.keys(sections).join(', ') + '. Solid kinds: ' + usable.join(', ') + '.';
  if (sections[q]) return sections[q]();
  if (kinds[q]) return kindLine(q) + '\n' + COMMON_NOTE;
  const hits = usable.filter(k => k.includes(q) || (KIND_NOTES[k] || '').toLowerCase().includes(q)).map(kindLine);
  const secHits = Object.entries(sections).filter(([n, f]) => f().toLowerCase().includes(q)).map(([n]) => n);
  if (!hits.length && !secHits.length) return `nothing matches "${q}". Sections: ${Object.keys(sections).join(', ')}. Kinds: ${usable.join(', ')}.`;
  return hits.join('\n') + (secHits.length ? `\nAlso see catalog sections: ${secHits.join(', ')}` : '');
}

// ---------------- tools ----------------
const EDITS = ['add_solid', 'join', 'wrap', 'edit_part', 'remove_part', 'move', 'spin', 'set_material', 'set_style', 'set_light', 'set_camera', 'add_motion', 'remove_motion'];
const statsLine = s => `${s.splats} splats (limit ${CFG.maxSplats}), extent ${JSON.stringify(s.extent.min)}..${JSON.stringify(s.extent.max)}, camera ${JSON.stringify(s.camera)}${s.moving_parts.length ? ', moving parts ' + s.moving_parts.join(', ') : ''}`;

async function overCap(j, e) {
  if (e.cap === 'splats') {
    failJob(j, `splat limit: the scene reached ${e.count} splats (limit ${CFG.maxSplats})`);
    ended = null;
    return { error: `JOB FAILED: the scene has ${e.count} splats, over the ${CFG.maxSplats} limit. The job is over; stop and reply with this reason.` };
  }
  // the engine itself could not build this scene: say so plainly (the scene is as the last edit left it)
  log('job', j.job_id, 'engine error:', e.message);
  return { error: `the engine could not build the scene: ${e.message}. Your last change most likely caused it: change or remove it, then render again.` };
}

async function tool(name, args) {
  inflight++;
  lastCall = Date.now();
  try {
    return await toolGated(name, args);
  } finally {
    inflight--;
    lastCall = Date.now();
    if (job) writeMode();
  }
}
async function toolGated(name, args) {
  args = args || {};
  if (ALIASES[name]) name = ALIASES[name];   // old names (video_job) still work; tools/list shows only the new ones
  if (!TOOLS.some(t => t.name === name)) throw new Error(`no tool called ${name}`);
  if (VG_TOOLS.includes(name)) {
    // not part of a scene: the Dell job queues FIFO; a long wait answers "still queued/running, call again"
    try {
      return await VG[name](args);
    } catch (e) {
      if (e instanceof VG.Pending) return { text: e.message };
      if (e.userError) return { error: e.message };
      log(name, 'error', e.message);
      return { error: `error ${name}: ${e.message}` };
    }
  }
  if (name === 'list_assets') return { text: A.list(args.query) };
  if (name === 'start_scene' && !job) {
    const a = M.articraft();   // one engine at a time: an Articraft job running or queued goes first
    if (a) return { error: M.busyText('start_scene', a) };
  }
  if (['start_scene', 'cancel_scene', 'list_scenes', 'show_scene'].includes(name)) {
    let out;
    try {
      if (name === 'start_scene') out = startScene(args);
      else if (name === 'list_scenes') out = listScenes();
      else if (name === 'show_scene') out = showScene(args);
      else {
        if (!job) throw userError('no scene is being made, so there is nothing to cancel');
        const id = job.job_id;
        failJob(job, 'cancelled: ' + (String(args.reason || '').trim() || 'Mo asked to cancel it'));
        ended = null;
        out = { text: `Scene ${id} cancelled.` };
      }
    } catch (e) {
      if (!e.userError) throw e;
      out = { error: e.message };
    }
    if (job && name === 'start_scene' && !out.error) writeMode();
    if (job && name === 'start_scene' && !out.error) transcript(job, { step: 0, tool: name, args, ok: true, result: out.text.slice(0, 2000) });
    return out;
  }
  const j = job;
  if (!j) {
    if (ended) {
      const e = ended;
      ended = null;
      return { error: `JOB FAILED: scene ${e.job_id} ended: ${e.reason}. Stop now and reply with this reason in one line.` };
    }
    const a = M.articraft();
    if (a) return { error: M.busyText(name, a, 'start_scene') };
    return { error: 'no scene is open: call start_scene with the request first' };
  }
  j.steps++;
  const tail = `\n[step ${j.steps}]`;
  let out;
  try {
    out = await toolBody(j, name, args);
  } catch (e) {
    if (e instanceof S.EditError || e.userError) out = { error: e.message };
    else throw e;
  }
  let loop = null;
  if (j.status === 'open') {
    loop = LC.observe(j.loop, j.steps, name, args, !out.error, out.newId);
    saveJob(j);
  }
  transcript(j, { step: j.steps, tool: name, args, ok: !out.error, result: (out.error || out.text || '').slice(0, 2000), image: out.image || undefined });
  if (loop && loop.warn) {
    transcript(j, { event: 'loop-warning', step: j.steps, text: loop.warn });
    log('job', j.job_id, 'loop warning at step', j.steps);
    out[out.error ? 'error' : 'text'] = (out.error || out.text || 'ok') + '\n' + loop.warn;
  }
  if (loop && loop.fail) {
    failJob(j, loop.fail);
    ended = null;
    return { error: `JOB FAILED: ${loop.fail}. The job is over; stop and reply with this reason in one line.` };
  }
  if (out.error) out.error += tail;
  else out.text = (out.text || 'ok') + tail;
  return out;
}

async function toolBody(j, name, args) {
  if (EDITS.includes(name)) {
    const r = S.ops[name](j.spec, args);
    j.spec = r.spec;
    return { text: `ok${r.id ? ': ' + r.id : ''}.${r.note ? '\nwarnings:\n' + r.note : ''}`, newId: r.id };
  }
  if (name === 'catalog') return { text: catalog(args.query) };
  if (name === 'validate') {
    const p = S.problems(j.spec);
    let t = (p.length ? S.report(p) : 'no problems') + '\n' + S.outline(j.spec);
    if (j.spec.solids.length && !p.some(x => x.level === 'error')) {
      let c;
      try {
        c = await buildChecks(j);
      } catch (e) {
        return overCap(j, e);
      }
      t += '\n' + c.lines.join('\n');
    }
    return { text: t };
  }
  if (!j.spec.solids.length && ['render', 'turn', 'stats', 'finish'].includes(name)) throw Object.assign(new Error('the scene has no solids yet; add some first'), { userError: true });
  if (name === 'render' || name === 'turn') {
    const file = path.join(j.dir, 'renders', `${String(j.steps).padStart(2, '0')}-${name}.png`);
    let r;
    try {
      r = await run(name, { spec: j.spec, yaw: args.yaw, pitch: args.pitch, t: args.t, n: 4, file });
    } catch (e) {
      return overCap(j, e);
    }
    j.renders++;
    let checkText = '';
    if (name === 'turn') {
      j.turned = require('./core.js').specHash(j.spec);
      // the build checks ride along with every turn (as Ink's authoring preview returns its checks with the image)
      const c = await buildChecks(j);
      checkText = '\n' + c.lines.join('\n');
    }
    return {
      text: (name === 'turn' ? 'Four views a quarter turn apart (labels give the yaw). Check each against the request: shape, proportions, colours, nothing floating or missing. ' : 'Rendered. ') + statsLine(r.stats) + checkText,
      image: file
    };
  }
  if (name === 'stats') {
    try {
      const r = await run('stats', { spec: j.spec });
      return { text: statsLine(r.stats) };
    } catch (e) {
      return overCap(j, e);
    }
  }
  if (name === 'finish') return finish(j, args);
  throw new Error('unhandled tool ' + name);
}

// floating / clash / changes-from-base checks (checks.js) on the engine thread, cached per job by the scene hash so
// validate, turn and finish on an unchanged scene do not rebuild them
const checkCache = new Map();
async function buildChecks(j) {
  const h = require('./core.js').specHash(j.spec), hit = checkCache.get(j.job_id);
  if (hit && hit.hash === h) return hit.c;
  const base = j.base_job ? JSON.parse(fs.readFileSync(path.join(jobDir(j.base_job), 'scene.json'), 'utf8')) : null;
  const c = await run('checks', { spec: j.spec, base, base_id: j.base_job });
  transcript(j, { event: 'checks', floating: c.floating, clashes: c.clashes, diff: c.diff, ms: c.ms });
  checkCache.clear();   // one open scene at a time: keep only its latest result
  checkCache.set(j.job_id, { hash: h, c });
  return c;
}
// finish's lines for Mo: the checks summary, then every open warning (one line each: id and problem), then the question
function finishCheckLines(c, rt) {
  const it = require('./checks.js').items(c);
  const head = `Checks: round-trip ok (${rt.splats} splats); floating ${c.floating.length}; clashes ${c.clashes.length}`;
  if (!it.length) return [head + '. Nothing floating, no moving parts passing through others.'];
  return [head + `. Open warning${it.length > 1 ? 's' : ''}:`, ...it.map(x => `- ${x.id}: ${x.problem}`), `Do you want me to refine ${it.length > 1 ? 'these' : 'this'}, or is it fine as it is?`];
}

async function finish(j, { title, summary }) {
  const C = require('./core.js');
  if (!title || !summary) throw Object.assign(new Error('finish needs a title and a summary'), { userError: true });
  if (j.turned !== C.specHash(j.spec))
    throw Object.assign(new Error('not finished: call turn after your last edit and check the four views first'), { userError: true });
  let checks;
  try {
    checks = await buildChecks(j);   // cached from the turn on this same scene
  } catch (e) {
    return overCap(j, e);
  }
  transcript(j, { event: 'export-start' });
  let r;
  try {
    r = await run('export', { spec: j.spec, dir: j.dir });
  } catch (e) {
    if (e.cap) return overCap(j, e);
    failJob(j, 'export failed: ' + e.message);
    ended = null;
    return { error: 'JOB FAILED: export failed: ' + e.message + '. Stop and reply with this reason.' };
  }
  const final = Object.assign({}, j.spec, { name: String(title).slice(0, 80) });
  fs.writeFileSync(path.join(j.dir, 'scene.json'), JSON.stringify(final, null, 1));
  j.spec = final;
  j.title = final.name;
  j.summary = String(summary).slice(0, 400);
  j.export = r;
  j.splats = r.ply.vertices;
  j.status = 'finished';
  j.finished_at = Date.now();
  saveJob(j);
  transcript(j, { event: 'finished', title: j.title, summary: j.summary, timings: r.timings, ply_vertices: r.ply.vertices });
  job = null;
  writeMode();
  log('job', j.job_id, 'finished', JSON.stringify(r.timings));
  const cl = finishCheckLines(checks, r.ply.round_trip), open = cl.length - 2;
  return {
    text: (open > 0
      ? `Finished with ${open} open check warning${open > 1 ? 's' : ''}. Reply to Mo with exactly these lines, unchanged, and nothing else: they pass the warnings on and ask him whether he wants them refined.\n`
      : 'Finished. Reply to Mo with exactly these lines, unchanged, and nothing else:\n') + sceneLines(j).concat(cl).join('\n')
  };
}

// ---------------- unix socket ----------------
async function handle(req) {
  if (req.op === 'status') return { open: job ? { job_id: job.job_id, steps: job.steps, started_at: job.started_at } : null };
  if (req.op === 'tool') return tool(req.name, req.args);
  if (req.op === 'close_job') {
    if (!job || (req.job_id && job.job_id !== req.job_id)) return { closed: false, why: 'not open' };
    const id = job.job_id;
    failJob(job, 'cancelled: ' + (req.reason || 'Mo asked to cancel it'));
    return { closed: true, job_id: id };
  }
  if (req.op === 'job') {
    if (!JOB_ID_RE.test(req.job_id || '')) throw new Error('bad job id');
    const k = loadJob(req.job_id);
    return { job_id: k.job_id, status: k.status, title: k.title, summary: k.summary, error: k.error, viewer: viewerUrl(k), dir: k.dir, steps: k.steps };
  }
  throw new Error('unknown op ' + req.op);
}
function serveSocket() {
  fs.mkdirSync(path.dirname(CFG.sock), { recursive: true, mode: 0o700 });
  if (fs.existsSync(CFG.sock)) fs.unlinkSync(CFG.sock);
  const srv = net.createServer(c => {
    let buf = '';
    c.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req;
        try {
          req = JSON.parse(line);
        } catch (e) {
          c.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
          continue;
        }
        handle(req).then(
          result => c.write(JSON.stringify({ ok: true, result }) + '\n'),
          e => c.write(JSON.stringify({ ok: false, error: e.message }) + '\n')
        );
      }
    });
    c.on('error', () => {});
  });
  srv.listen(CFG.sock, () => {
    fs.chmodSync(CFG.sock, 0o600);
    log('socket', CFG.sock);
  });
  return srv;
}

// ---------------- HTTP: viewer (keyless, unguessable link) and files (key) ----------------
let INK_JS = null;
function inkJs() {
  if (INK_JS) return INK_JS;
  const C = require('./core.js');
  const renderSrc = fs.readFileSync(path.join(C.INK, 'cli', 'render.js'), 'utf8');
  INK_JS = Buffer.from(
    '"use strict";\n' + C.studio.bundle() +
      '\nwindow.INK = { KIT, makeBuilder, makeSculpt, PixelLook };\n' +
      'const __INK_PIXEL_LOOK = PixelLook;\n(function () { const module = { exports: {} }; const require = () => __INK_PIXEL_LOOK;\n' + renderSrc + '\nwindow.INK.R = module.exports; })();\n'
  );
  return INK_JS;
}
function tokenJob(token) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  for (const id of fs.readdirSync(CFG.splats)) {
    if (!JOB_ID_RE.test(id)) continue;
    try {
      const j = loadJob(id);
      if (j.token && crypto.timingSafeEqual(Buffer.from(j.token), Buffer.from(token))) return j;
    } catch (e) {}
  }
  return null;
}
function serveHttp(key) {
  const keyBuf = Buffer.from('Bearer ' + key);
  const send = (res, code, type, body, extra) => {
    res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra));
    res.end(body);
  };
  const srv = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only\n');
      if (u.pathname === '/health') return send(res, 200, 'application/json', JSON.stringify({ ok: true, open_job: !!job }));
      if (u.pathname === '/viewer/ink.js') return send(res, 200, 'text/javascript', inkJs());
      if (VG.serve(req, res, u.pathname)) return;
      const ma = /^\/viewer\/assets\/([a-z]+\/[A-Za-z0-9_]+)\.glb$/.exec(u.pathname);
      if (ma) {
        const f = A.fileOf(ma[1]);   // the CC0 model library, the same for every scene
        if (!f) return send(res, 404, 'text/plain', 'not found\n');
        return send(res, 200, 'model/gltf-binary', fs.readFileSync(f), { 'Cache-Control': 'max-age=86400' });
      }
      let m = /^\/v\/([A-Za-z0-9_-]+)\/(scene\.json)?$/.exec(u.pathname);
      if (m) {
        const j = tokenJob(m[1]);
        if (!j) return send(res, 404, 'text/plain', 'not found\n');
        if (m[2]) return send(res, 200, 'application/json', JSON.stringify(A.forBuild(j.spec).spec));
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'viewer', 'index.html')));
      }
      m = /^\/files\/([0-9a-f]{16})\/([a-z.]+)$/.exec(u.pathname);
      if (m) {
        const auth = Buffer.from(req.headers.authorization || '');
        if (auth.length !== keyBuf.length || !crypto.timingSafeEqual(auth, keyBuf)) return send(res, 401, 'text/plain', 'key required\n', { 'WWW-Authenticate': 'Bearer' });
        const type = FILES[m[2]],
          f = path.join(jobDir(m[1]), m[2]);
        if (!type || !fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found\n');
        const st = fs.statSync(f);
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(f).pipe(res);
      }
      send(res, 404, 'text/plain', 'not found\n');
    } catch (e) {
      log('http error', e.message);
      send(res, 500, 'text/plain', 'error\n');
    }
  });
  srv.listen(CFG.port, CFG.bind, () => log('http', `${CFG.bind}:${CFG.port}`));
  return srv;
}

// the stale-scene timeout: no tool call (and none running) for CFG.staleS closes the scene and frees the 3D bot
function staleCheck() {
  if (job && !inflight && Date.now() - Math.max(lastCall, job.started_at) > CFG.staleS * 1000) {
    failJob(job, `stale: no tool call for ${Math.round(CFG.staleS / 60)} min, so the scene was closed and the 3D bot freed for other engines`);
    writeMode();
  }
}
// a job left open by a previous run of this service cannot continue: fail it loudly
async function failLeftovers() {
  fs.mkdirSync(CFG.splats, { recursive: true });
  for (const id of fs.readdirSync(CFG.splats)) {
    if (!JOB_ID_RE.test(id)) continue;
    let j;
    try {
      j = loadJob(id);
    } catch (e) {
      continue;
    }
    if (j.status === 'open') {
      try {
        failJob(j, 'the splat service restarted while the scene was open');
      } catch (e) {
        log('could not fail leftover job', id, e.message);
      }
    }
  }
}

async function main() {
  const key = readKey();
  await failLeftovers();
  VG.setBind(CFG.bind, CFG.port);
  VG.resume(log);   // finish VGGT copies a previous run left half done
  VG.setEngine({ gate: () => { const a = M.articraft(); return a && a.holds ? a : null; }, onChange: writeMode, log });
  writeMode();
  setInterval(staleCheck, CFG.staleCheckMs).unref();
  startEngine();
  serveSocket();
  serveHttp(key);
  const stop = () => {
    log('stopping');
    if (job) {
      failJob(job, 'the splat service was stopped while the scene was open');
    }
    job = null;
    writeMode();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main().catch(e => {
  console.error(e);
  process.exit(1);
});
module.exports = { CFG, catalog, startScene, tool, handle, run, startEngine, serveHttp, serveSocket, failLeftovers, _state: () => job, _reset: () => (job = null), inkJs, tokenJob };
