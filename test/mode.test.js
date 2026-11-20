'use strict';
// One engine at a time with Articraft (Mo 18:21 20 Nov: "A: one engine at a time; while an Articraft job runs, new Ink
// scenes and video rebuilds wait, and vice versa"). A fake Articraft holder (a live child process) writes
// articraft.json; a fake Dell records vggt POSTs. No real Dell, no real Articraft.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const H = require('./helpers.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function holder(t, state) {   // a live process standing in for articraft-agent, and its articraft.json
  const p = spawn('node', ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  t.holders = (t.holders || []).concat(p);
  const write = st => fs.writeFileSync(path.join(t.env.THREED_MODE_DIR, 'articraft.json'), JSON.stringify(Object.assign({ pid: p.pid, cmd: fs.readFileSync(`/proc/${p.pid}/cmdline`, 'utf8'), updated: Date.now() / 1000, cap_s: 3600 }, st)));
  return new Promise(r => setTimeout(() => { write(state); r({ p, write }); }, 100));
}
function fakeDell(t) {
  t.dell = { posts: [] };
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', d => (b += d));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'POST') { t.dell.posts.push({ url: req.url, body: JSON.parse(b || '{}') }); return res.end(JSON.stringify({ state: 'queued', position: 1 })); }
        res.end(JSON.stringify({ stages: t.dell.posts.length ? { vggt: { state: 'queued', position: 1 } } : {} }));
      });
    });
    srv.listen(0, '127.0.0.1', () => { t.env.DELL_ANNOTATE = `http://127.0.0.1:${srv.address().port}`; t.dellSrv = srv; resolve(); });
  });
}
async function env(extra) {
  const t = H.tmpEnv(Object.assign({ SPLAT_ENGINE_POLL_MS: '100', SPLAT_ENGINE_TICK_MS: '200' }, extra || {}));
  t.env.THREED_MODE_DIR = path.join(t.dir, '3d-mode');
  fs.mkdirSync(t.env.THREED_MODE_DIR);
  t.env.SPLAT_DELL_ENV = path.join(t.dir, 'profile.env');
  fs.writeFileSync(t.env.SPLAT_DELL_ENV, 'DELL_LLM_API_KEY=test-not-a-real-key-000\n');
  await fakeDell(t);
  return t;
}
const done = t => { H.stop(t); (t.holders || []).forEach(p => p.kill('SIGKILL')); if (t.dellSrv) t.dellSrv.close(); };
const ink = t => JSON.parse(fs.readFileSync(path.join(t.env.THREED_MODE_DIR, 'ink.json'), 'utf8'));
const call = (t, name, args) => H.ask(t, { op: 'tool', name, args: args || {} });

test('mode: start_scene and scene tools answer busy while Articraft runs; a dead Articraft holds nothing', async () => {
  const t = await env();
  await H.startService(t);
  try {
    assert.strictEqual(ink(t).scene, null);
    const h = await holder(t, { running: { job_id: 'aaaabbbbccccdddd', started: Date.now() / 1000 - 35 * 60, lock_wait_s: 0 }, queued: [] });
    let r = await call(t, 'start_scene', { request: 'a hut' });
    assert.match(r.error, /^error start_scene: Articraft job aaaabbbbccccdddd is running \(about 25 min left\); the 3D bot runs one engine at a time\. Nothing was started and nothing is lost: check with articraft_status aaaabbbbccccdddd, and call start_scene again when it finishes\.$/);
    r = await call(t, 'add_solid', { kind: 'ball', id: 'b', mat: 'stone', params: { r: 1 } });
    assert.match(r.error, /^error add_solid: Articraft job aaaabbbbccccdddd is running .*call start_scene again when it finishes\.$/);
    assert.match((await call(t, 'list_scenes')).text, /No scenes yet/);   // reading tools stay usable
    h.write({ running: null, queued: [{ job_id: 'eeeeffff00001111', created: Date.now() / 1000 }] });
    r = await call(t, 'start_scene', { request: 'a hut' });
    assert.match(r.error, /Articraft job eeeeffff00001111 is queued \(1 queued, about 60 min until Articraft is free\)/);
    h.p.kill('SIGKILL');
    await sleep(200);
    r = await call(t, 'start_scene', { request: 'a hut' });
    assert.ok(!r.error, r.error);
    const m = ink(t);
    assert.match(m.scene.job_id, /^[0-9a-f]{16}$/);
    assert.strictEqual(m.pid, t.proc.pid);
  } finally { done(t); }
});

test('mode: Ink releases on cancel_scene and on the stale-scene timeout', async () => {
  const t = await env({ SPLAT_STALE_S: '2', SPLAT_STALE_CHECK_MS: '200' });
  await H.startService(t);
  try {
    await call(t, 'start_scene', { request: 'a hut' });
    assert.ok(ink(t).scene);
    await call(t, 'cancel_scene', { reason: 'test' });
    assert.strictEqual(ink(t).scene, null);
    const id = (await call(t, 'start_scene', { request: 'a tower' })).text.split(' ')[1];
    assert.strictEqual(ink(t).scene.job_id, id);
    await call(t, 'add_solid', { kind: 'ball', id: 'b', mat: 'stone', params: { r: 1 } });
    await sleep(3000);
    assert.strictEqual(ink(t).scene, null);
    const k = JSON.parse(fs.readFileSync(path.join(t.env.SPLAT_DIR, id, 'job.json')));
    assert.strictEqual(k.status, 'failed');
    assert.match(k.error, /^stale: no tool call for 0 min/);
    assert.match((await call(t, 'render')).error, /^JOB FAILED: scene .* ended: stale/);
  } finally { done(t); }
});

test('mode: reconstruct_3d during an Articraft job queues here, then starts by itself when Articraft is free', async () => {
  const t = await env();
  const vid = '0123456789abcdef', d = path.join(t.env.SPLAT_DIR, 'vggt', vid);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'view.token'), 'a'.repeat(36));
  await H.startService(t);
  try {
    const h = await holder(t, { running: { job_id: 'aaaabbbbccccdddd', started: Date.now() / 1000, lock_wait_s: 0 }, queued: [] });
    let r = await call(t, 'reconstruct_3d', { video: vid, frames: 40, wait_s: 1 });
    assert.match(r.text, /^0123456789abcdef: queued here, waiting for Articraft job aaaabbbbccccdddd \(running, Articraft free in about 60 min\); the 3D bot runs one engine at a time\. It starts by itself when that job finishes and is not lost: check with articraft_status aaaabbbbccccdddd, and call reconstruct_3d again with video "0123456789abcdef" to keep waiting\.$/);
    assert.strictEqual(t.dell.posts.length, 0);
    assert.ok(fs.existsSync(path.join(d, '.engine-wait.json')));
    assert.match((await call(t, 'list_reconstructions')).text, /0123456789abcdef waiting for Articraft \(queued here\)/);
    await sleep(600);
    assert.strictEqual(t.dell.posts.length, 0, 'never POSTed while Articraft runs');
    assert.deepStrictEqual(ink(t).reconstructions, []);   // a waiting rebuild does not hold Articraft
    h.write({ running: null, queued: [{ job_id: 'eeeeffff00001111', created: Date.now() / 1000, waiting_for: 'reconstruction' }] });   // a head waiting for Ink does not hold
    for (let i = 0; i < 30 && !t.dell.posts.length; i++) await sleep(100);
    assert.strictEqual(t.dell.posts.length, 1);
    assert.match(t.dell.posts[0].url, /\/v1\/jobs\/0123456789abcdef\/stages\/vggt$/);
    assert.strictEqual(t.dell.posts[0].body.max_frames, 40);   // the frames it was queued with
    assert.ok(!fs.existsSync(path.join(d, '.engine-wait.json')));
    assert.deepStrictEqual(ink(t).reconstructions, [vid]);   // now Articraft waits for it
    r = await call(t, 'reconstruct_3d', { video: vid, wait_s: 1 });   // attaches, never POSTs twice
    assert.match(r.text, /still queued/);
    assert.strictEqual(t.dell.posts.length, 1);
  } finally { done(t); }
});
