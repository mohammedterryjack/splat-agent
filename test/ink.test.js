'use strict';
// Ink-style tool design (20 Nov): renamed tools and their aliases, list_reconstructions, the one check format, and
// finish's checks lines (every open warning for Mo, then the question). No Dell: DELL_ANNOTATE points at a closed port.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const H = require('./helpers.js');

function env() {
  const t = H.tmpEnv();
  Object.assign(t.env, { DELL_ANNOTATE: 'http://127.0.0.1:9', SPLAT_DELL_ENV: path.join(t.dir, 'profile.env') });
  return t;
}
function mcpSession(t) {
  const p = spawn('node', [path.join(H.ROOT, 'mcp.js')], { env: t.env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const pending = new Map();
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m); } } });
  const call = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args || {} })).result;
  return { p, call, tool, close: () => p.kill() };
}
const txt = r => r.content[0].text;

test('tools/list: new names and args only, short verb-first descriptions; old names and args still work', async () => {
  const t = env();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    await m.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const tools = (await m.call('tools/list', {})).result.tools, by = Object.fromEntries(tools.map(x => [x.name, x]));
    for (const n of ['upload_video', 'reconstruct_3d', 'list_reconstructions', 'list_assets']) assert.ok(by[n], n);
    assert.ok(!by.video_job, 'video_job is an alias, not listed');
    assert.deepStrictEqual(Object.keys(by.reconstruct_3d.inputSchema.properties), ['video', 'frames', 'trim', 'wait_s']);
    assert.deepStrictEqual(by.reconstruct_3d.inputSchema.required, []);
    for (const n of ['upload_video', 'reconstruct_3d', 'list_reconstructions']) {
      assert.strictEqual(by[n].inputSchema.additionalProperties, false, n);
      assert.ok(by[n].description.length <= 450, n + ' description is ' + by[n].description.length);
      assert.match(by[n].description, /^(Upload|Rebuild|List) /, n);
    }
    assert.match(by.add_solid.description, /mat is required except for mesh/);
    // routing line up front in each entry tool (Mo 18:03): which engine a request belongs to
    assert.match(by.start_scene.description, /^Start making a 3D scene with Ink: game-style splat scenes and decorative objects\. For real working joints or a CAD\/USDZ file use articraft_generate instead; to rebuild from a video use reconstruct_3d\./);
    assert.match(by.reconstruct_3d.description, /^Rebuild a video in 3D with VGGT-Omega on the Dell: only for rebuilding a video \(splat scenes and decorative objects: start_scene; real working joints or CAD\/USDZ: articraft_generate\)\./);
    assert.doesNotMatch(by.add_solid.description, /nature\/tree_oak/);
    // the alias reaches upload_video (its own error, not "no tool called")
    let r = await m.tool('video_job', {});
    assert.ok(r.isError);
    assert.match(txt(r), /^error upload_video\.path: give path \(a file on this machine\) or url \(http\/https\); for example path /);
    assert.match(txt(await m.tool('upload_video', { path: '/x', url: 'http://y' })), /^error upload_video\.url: give path or url, not both/);
    assert.match(txt(await m.tool('upload_video', { path: '/x', start: -1 })), /^error upload_video\.start: must be seconds/);
    // reconstruct_3d: old argument names, conflicts, ranges, unknown names, no video yet
    assert.match(txt(await m.tool('reconstruct_3d', {})), /^error reconstruct_3d\.video: there is no video yet; call upload_video first/);
    assert.match(txt(await m.tool('reconstruct_3d', { job_id: 'nothex' })), /^error reconstruct_3d\.video: "nothex" is not a video id/);
    assert.match(txt(await m.tool('reconstruct_3d', { video: 'aaaaaaaaaaaaaaaa', job_id: 'bbbbbbbbbbbbbbbb' })), /^error reconstruct_3d\.video: give video or its old name job_id, not both/);
    assert.match(txt(await m.tool('reconstruct_3d', { video: 'aaaaaaaaaaaaaaaa', max_frames: 200 })), /^error reconstruct_3d\.frames: must be a whole number 1\.\.100/);
    assert.match(txt(await m.tool('reconstruct_3d', { video: 'aaaaaaaaaaaaaaaa', conf_percentile: 120 })), /^error reconstruct_3d\.trim: must be 0\.\.99/);
    assert.match(txt(await m.tool('reconstruct_3d', { video: 'aaaaaaaaaaaaaaaa', wait_s: 900 })), /^error reconstruct_3d\.wait_s: must be a whole number 0\.\.840/);
    assert.match(txt(await m.tool('reconstruct_3d', { video: 'aaaaaaaaaaaaaaaa', maxframes: 3 })), /^error reconstruct_3d\.maxframes: nothing is called "maxframes" here; what may be written: video, frames, trim, wait_s$/);
    // a reachable path all the way to the (absent) Dell fails loudly, no fallback
    r = await m.tool('reconstruct_3d', { job_id: 'aaaaaaaaaaaaaaaa', max_frames: 60, conf_percentile: 20 });
    assert.ok(r.isError);
    assert.match(txt(r), /^error reconstruct_3d: /);
  } finally { m.close(); H.stop(t); }
});

test('list_reconstructions: newest first, done / copying / not reconstructed yet, London time, viewer link', async () => {
  const t = env();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    assert.strictEqual(txt(await m.tool('list_reconstructions', {})), 'No videos yet.');
    assert.match(txt(await m.tool('list_reconstructions', { x: 1 })), /^error list_reconstructions\.x: this tool takes no arguments/);
    const root = path.join(t.env.SPLAT_DIR, 'vggt'), mk = (id, files, ago) => {
      const d = path.join(root, id);
      fs.mkdirSync(d, { recursive: true });
      for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), v);
      fs.writeFileSync(path.join(d, 'view.token'), require('crypto').randomBytes(18).toString('hex'));
      const when = new Date(Date.now() - ago * 1000);
      fs.utimesSync(path.join(d, 'view.token'), when, when);
    };
    mk('1111111111111111', { 'job.json': JSON.stringify({ clip: { name: 'gta' } }), 'vggt_cameras.json': JSON.stringify({ shots: [{}, {}, {}] }), 'vggt_layout.json': '[]', 'vggt.mp4': 'x', 'vggt_preview.jpg': 'x' }, 300);
    mk('2222222222222222', { 'upload.json': JSON.stringify({ clip: { name: 'store' } }), '.pull-vggt.json': '{}' }, 200);
    mk('3333333333333333', { 'upload.json': JSON.stringify({ clip: { name: 'new' } }) }, 100);
    const L = txt(await m.tool('list_reconstructions', {})).split('\n');
    assert.strictEqual(L.length, 3);   // not a scene tool, so no [step] tail
    assert.match(L[0], /^3333333333333333 not reconstructed here yet "new", \d{4}-\d\d-\d\d \d\d:\d\d London, viewer http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f]{36}\/$/);
    assert.match(L[1], /^2222222222222222 copying "store", /);
    assert.match(L[2], /^1111111111111111 done "gta", .* London: 3 shots, viewer /);
  } finally { m.close(); H.stop(t); }
});

test('one check format in validate and turn; finish lists every open warning for Mo and asks whether to refine', async () => {
  const t = env();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const st = await m.tool('start_scene', { request: 'a hut and a floating cloud' });
    const jid = /Scene ([0-9a-f]{16}) started/.exec(txt(st))[1];
    for (const [n, a] of [
      ['add_solid', { kind: 'ground', params: { rad: 2, res: 0.2 }, mat: 'earth' }],
      ['add_solid', { kind: 'box', id: 'hut', params: { at: [0, 0.6, 0], half: [0.6, 0.6, 0.6], res: 0.12 }, mat: 'wood' }],
      ['add_solid', { kind: 'ball', id: 'cloud', params: { at: [0, 3, 0], r: 0.4, res: 0.12 }, mat: 'pale' }],
      ['set_camera', { target: [0, 1, 0], dist: 8 }]
    ]) { const r = await m.tool(n, a); assert.ok(!r.isError, n + ': ' + txt(r)); }
    const bad = await m.tool('add_solid', { kind: 'ball', params: { at: [0, 1, 0], r: 1 }, mat: 'stoen' });
    assert.match(txt(bad), /\nerror \S+: .*; did you mean "stone"/);
    assert.doesNotMatch(txt(bad), /ERROR at/);
    const v = txt(await m.tool('validate', {}));
    assert.match(v, /^warning solids\.cloud: floating, [\d.]+ from the nearest other solid \(bottom at y [\d.]+\); it does not rest on or touch anything that leads to the ground; for example move\("cloud", \[0, -[\d.]+, 0\]\)/m);
    assert.match(v, /^build checks: 1 warning\(s\) \(floating 1, clashes 0\)$/m);
    assert.doesNotMatch(v, /FLOATING|CLASH|Build checks/);
    const tr = txt(await m.tool('turn', {}));
    assert.match(tr, /^warning solids\.cloud: floating/m);
    assert.match(tr, /^build checks: 1 warning\(s\)/m);
    const fin = await m.tool('finish', { title: 'Hut and cloud', summary: 'A hut under a cloud.' });
    assert.ok(!fin.isError, txt(fin));
    const L = txt(fin).split('\n');
    assert.match(L[0], /^Finished with 1 open check warning\. Reply to Mo with exactly these lines, unchanged, and nothing else: they pass the warnings on and ask him whether he wants them refined\.$/);
    assert.match(L[1], new RegExp(`^Hut and cloud: A hut under a cloud\\. \\(\\d+ splats, scene ${jid}\\)$`));
    assert.match(L[2], /^Viewer: /);
    assert.ok(L.slice(3, 6).every(l => l.startsWith('MEDIA:')));
    assert.match(L[6], /^Checks: round-trip ok \(\d+ splats\); floating 1; clashes 0\. Open warning:$/);
    assert.match(L[7], /^- cloud: floating, [\d.]+ from the nearest other solid/);
    assert.doesNotMatch(L[7], /move\(/);
    assert.strictEqual(L[8], 'Do you want me to refine this, or is it fine as it is?');
    assert.match(L[9], /^\[step \d+\]$/);
    // a revision: the changes line uses added / removed / updated; a clean scene finishes with no question
    await m.tool('start_scene', { request: 'drop the cloud', based_on: 'latest' });
    await m.tool('remove_part', { id: 'cloud' });
    await m.tool('move', { id: 'hut', by: [0.1, 0, 0] });
    const v2 = txt(await m.tool('validate', {}));
    assert.match(v2, new RegExp(`^changes from ${jid}: added none; removed cloud; updated hut\\. Check that only what the request asked for changed\\.$`, 'm'));
    assert.match(v2, /^build checks: sound \(nothing floating, no moving-part clashes\)$/m);
    await m.tool('turn', {});
    const L2 = txt(await m.tool('finish', { title: 'Hut', summary: 'A hut.' })).split('\n');
    assert.match(L2[0], /^Finished\. Reply to Mo with exactly these lines, unchanged, and nothing else:$/);
    assert.match(L2[6], /^Checks: round-trip ok \(\d+ splats\); floating 0; clashes 0\. Nothing floating, no moving parts passing through others\.$/);
    assert.match(L2[7], /^\[step \d+\]$/);
  } finally { m.close(); H.stop(t); }
});

test('catalog has the reconstruction entry and the mesh fields', async () => {
  const t = env();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    await m.tool('start_scene', { request: 'x' });
    assert.match(txt(await m.tool('catalog', { query: 'reconstruction' })), /^reconstruction \[op, ready\]: reconstruct_3d rebuilds each shot/);
    const mesh = txt(await m.tool('catalog', { query: 'mesh' }));
    for (const w of ['asset', 'size', 'spin', 'cells', 'thick', 'hues', 'nature/tree_oak']) assert.ok(mesh.includes(w), w);
    assert.match(txt(await m.tool('list_assets', { query: 'tree oak' })), /All its fields: catalog\("mesh"\)\./);
  } finally { m.close(); H.stop(t); }
});
