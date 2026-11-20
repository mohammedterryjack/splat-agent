'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), http = require('http'), { spawn, execFileSync } = require('child_process');
const H = require('./helpers.js');

function mcpSession(t) {
  const p = spawn('node', [path.join(H.ROOT, 'mcp.js')], { env: t.env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const pending = new Map();
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m); } } });
  const call = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args || {} })).result;
  return { p, call, tool, close: () => p.kill() };
}
const get = (url, headers) => new Promise((resolve, reject) => http.get(url, { headers }, res => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve({ code: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(ch) })); }).on('error', reject));
const KEY = 'Bearer test-key-0123456789abcdef0123456789abcdef';
const small = [
  ['add_solid', { kind: 'ground', params: { rad: 2, res: 0.2 }, mat: 'earth' }],
  ['add_solid', { kind: 'box', id: 'hut', params: { at: [0, 0.6, 0], half: [0.6, 0.6, 0.6], res: 0.12 }, mat: 'wood' }],
  ['add_solid', { kind: 'regular', id: 'gem', params: { shape: 'd8', at: [0, 1.8, 0], r: 0.3, res: 0.08 }, mat: { role: 'accent', glow: true }, part: 'gem' }],
  ['add_motion', { do: 'spin', part: 'gem', params: { axis: [0, 1, 0], speed: 1 } }],
  ['add_motion', { do: 'bob', part: 'gem', params: { amount: 0.2, period: 3 } }],
  ['set_camera', { target: [0, 0.8, 0], dist: 7 }]
];

const sceneId = r => (/Scene ([0-9a-f]{16}) started/.exec(r.content[0].text) || [])[1];
const viewerOf = text => /Viewer: (\S+)/.exec(text)[1];

test('MCP server lists the scene and Ink tools and refuses edits with no scene open', async () => {
  const t = H.tmpEnv();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const init = await m.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.strictEqual(init.result.serverInfo.name, 'ink');
    const names = (await m.call('tools/list', {})).result.tools.map(x => x.name);
    for (const n of ['start_scene', 'cancel_scene', 'list_scenes', 'show_scene', 'catalog', 'add_solid', 'join', 'wrap', 'edit_part', 'remove_part', 'move', 'spin', 'set_material', 'set_style', 'set_light', 'set_camera', 'add_motion', 'validate', 'render', 'turn', 'stats', 'finish']) assert.ok(names.includes(n), n);
    const r = await m.tool('add_solid', { kind: 'ball', params: { at: [0, 1, 0], r: 1 }, mat: 'stone' });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /no scene is open: call start_scene/);
    assert.match((await m.tool('start_scene', { request: 'x', based_on: 'latest' })).content[0].text, /no finished scene yet/);
    assert.match((await m.tool('show_scene', {})).content[0].text, /no finished scene yet/);
    assert.strictEqual((await m.tool('list_scenes', {})).content[0].text, 'No scenes yet.');
    assert.deepStrictEqual(H.longJobCalls(t), []);
    assert.deepStrictEqual(t.runs.posted, []);
  } finally { m.close(); H.stop(t); }
});

test('a whole scene: start, edits, render image, turn gate, finish answers with summary, viewer and MEDIA lines; revision, show, list, cancel', async () => {
  const t = H.tmpEnv();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const st = await m.tool('start_scene', { request: 'a small hut with a spinning gem' });
    const jid = sceneId(st);
    assert.ok(jid, st.content[0].text);
    assert.match(st.content[0].text, /Live viewer: http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]{32}\/$/);
    assert.match((await m.tool('start_scene', { request: 'second' })).content[0].text, /another 3D scene is being made \(scene [0-9a-f]{16}.*one at a time/);
    assert.match((await m.tool('catalog', { query: 'box' })).content[0].text, /half/);
    for (const [name, args] of small) { const r = await m.tool(name, args); assert.ok(!r.isError, name + ': ' + r.content[0].text); }
    const bad = await m.tool('add_solid', { kind: 'ball', params: { at: [0, 1, 0], r: 1 }, mat: 'stoen' });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /did you mean "stone"/);
    const rr = await m.tool('render', {});
    assert.strictEqual(rr.content[1].type, 'image');
    const png = Buffer.from(rr.content[1].data, 'base64');
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 360]);
    assert.match((await m.tool('finish', { title: 'Hut', summary: 'A hut.' })).content[0].text, /call turn after your last edit/);
    assert.strictEqual(Buffer.from((await m.tool('turn', { n: 4 })).content[1].data, 'base64').readUInt32BE(16), 1280);
    await m.tool('move', { id: 'hut', by: [0, 0, 0.1] });
    assert.ok((await m.tool('finish', { title: 'Hut', summary: 'A hut.' })).isError);
    await m.tool('turn', {});
    const fin = await m.tool('finish', { title: 'Tiny hut', summary: 'A wooden hut with a spinning gem.' });
    assert.ok(!fin.isError, fin.content[0].text);
    const dir = path.join(t.env.SPLAT_DIR, jid);
    const lines = fin.content[0].text.split('\n');
    assert.match(lines[0], /^Finished(?: with \d+ open check warnings?)?\. Reply to Mo with exactly these lines/);
    assert.match(lines[1], new RegExp(`^Tiny hut: A wooden hut with a spinning gem\\. \\(\\d+ splats, scene ${jid}\\)$`));
    assert.match(lines[2], /^Viewer: http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]{32}\/$/);
    assert.deepStrictEqual(lines.slice(3, 6), ['final.png', 'preview.mp4', 'scene.ply'].map(f => 'MEDIA:' + path.join(dir, f)));
    assert.match(lines.at(-1), /^\[step \d+\]$/);
    for (const f of ['scene.ply', 'final.png', 'preview.mp4', 'scene.json', 'transcript.jsonl', 'job.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,codec_name,pix_fmt,nb_read_frames,r_frame_rate', '-of', 'json', path.join(dir, 'preview.mp4')]).toString()).streams[0];
    assert.deepStrictEqual([probe.width, probe.height, probe.codec_name, probe.pix_fmt, probe.nb_read_frames, probe.r_frame_rate], [1280, 720, 'h264', 'yuv420p', '270', '30/1']);
    assert.strictEqual(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv', path.join(dir, 'preview.mp4')]).toString().trim(), '');
    assert.deepStrictEqual(H.longJobCalls(t), []);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'))).status, 'finished');
    const tlines = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(tlines.some(l => l.tool === 'render' && l.image));
    assert.ok(tlines.some(l => l.event === 'finished'));
    const viewer = viewerOf(fin.content[0].text);
    const page = await get(viewer);
    assert.strictEqual(page.code, 200);
    assert.match(page.body.toString(), /\/viewer\/ink\.js/);
    assert.strictEqual(JSON.parse((await get(viewer + 'scene.json')).body).name, 'Tiny hut');
    assert.strictEqual((await get(viewer.replace(/\/v\/[^/]+\//, '/v/' + 'x'.repeat(32) + '/'))).code, 404);
    const base = viewer.replace(/\/v\/.*/, '');
    assert.strictEqual((await get(`${base}/files/${jid}/scene.ply`)).code, 401);
    assert.strictEqual((await get(`${base}/files/${jid}/scene.ply`, { Authorization: 'Bearer wrong' })).code, 401);
    const ply = await get(`${base}/files/${jid}/scene.ply`, { Authorization: KEY });
    assert.strictEqual(ply.code, 200);
    assert.match(ply.body.slice(0, 200).toString(), /^ply\n/);
    assert.strictEqual((await get(`${base}/files/${jid}/job.json`, { Authorization: KEY })).code, 404);
    assert.strictEqual((await get(`${base}/viewer/ink.js`)).code, 200);
    assert.match((await m.tool('render', {})).content[0].text, /no scene is open/);
    const shown = (await m.tool('show_scene', { scene: 'latest' })).content[0].text.split('\n');
    assert.deepStrictEqual(shown.slice(1), lines.slice(1, 6));
    assert.match((await m.tool('list_scenes', {})).content[0].text, new RegExp(`^${jid} finished "Tiny hut"`));
    // a revision starts from the finished scene
    const rev = await m.tool('start_scene', { request: 'make the hut bigger', based_on: 'latest' });
    const jid2 = sceneId(rev);
    assert.match(rev.content[0].text, new RegExp(`started from scene ${jid}`));
    assert.match(rev.content[0].text, /hut: box/);
    assert.match(rev.content[0].text, /gem: regular/);
    // cancel from outside (cancel.js): the 3D bot's next call is told to stop, once
    assert.strictEqual(execFileSync('node', [path.join(H.ROOT, 'cancel.js'), 'test', 'over'], { env: t.env }).toString().trim(), `cancelled 3D scene ${jid2}`);
    assert.match((await m.tool('validate', {})).content[0].text, new RegExp(`^JOB FAILED: scene ${jid2} ended: cancelled: test over\\. Stop now`));
    assert.match((await m.tool('validate', {})).content[0].text, /no scene is open/);
    assert.strictEqual((await H.ask(t, { op: 'job', job_id: jid2 })).status, 'failed');
    assert.deepStrictEqual(await H.ask(t, { op: 'close_job', reason: 'x' }), { closed: false, why: 'not open' });
  } finally { m.close(); H.stop(t); }
});

test('there is no step limit: 60 tool calls run; cancel_scene ends the scene', async () => {
  const t = H.tmpEnv();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const jid = sceneId(await m.tool('start_scene', { request: 'x' }));
    for (let i = 0; i < 60; i++) assert.ok(!(await m.tool('catalog', { query: 'kinds' })).isError, 'call ' + i);
    assert.match((await m.tool('catalog', { query: 'kinds' })).content.at(-1).text, /\[step 61\]$/);
    assert.strictEqual((await m.tool('cancel_scene', { reason: 'Mo said stop' })).content[0].text, `Scene ${jid} cancelled.`);
    assert.strictEqual((await H.ask(t, { op: 'job', job_id: jid })).error, 'cancelled: Mo said stop');
    assert.match((await m.tool('validate', {})).content[0].text, /no scene is open/);
    assert.match((await m.tool('cancel_scene', {})).content[0].text, /nothing to cancel/);
  } finally { m.close(); H.stop(t); }
});

test('the splat cap fails the scene loudly', async () => {
  const t = H.tmpEnv();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const jid = sceneId(await m.tool('start_scene', { request: 'x' }));
    assert.ok(!(await m.tool('add_solid', { kind: 'ground', params: { rad: 9, res: 0.025 }, mat: 'earth' })).isError);
    const r = await m.tool('stats', {});
    assert.ok(r.isError, r.content[0].text);
    assert.match(r.content[0].text, /JOB FAILED: the scene has \d+ splats, over the 250000 limit/);
    assert.match((await H.ask(t, { op: 'job', job_id: jid })).error, /^splat limit: the scene reached \d+ splats \(limit 250000\)$/);
    assert.match((await m.tool('validate', {})).content[0].text, /no scene is open/);
  } finally { m.close(); H.stop(t); }
});

test('a scene left open when the service stopped is failed at the next start', async () => {
  const t = H.tmpEnv();
  await H.startService(t);
  const m = mcpSession(t);
  const jid = sceneId(await m.tool('start_scene', { request: 'x' }));
  m.close();
  H.stop(t, true);
  await new Promise(r => setTimeout(r, 300));
  await H.startService(t);
  try {
    const k = JSON.parse(fs.readFileSync(path.join(t.env.SPLAT_DIR, jid, 'job.json')));
    assert.strictEqual(k.status, 'failed');
    assert.strictEqual(k.error, 'the splat service restarted while the scene was open');
    assert.deepStrictEqual(await H.ask(t, { op: 'status' }), { open: null });
  } finally { H.stop(t); }
});

test('the loop check: the second teardown warns the 3D bot once, the next fails the scene with a looped reason', async () => {
  const t = H.tmpEnv({ SPLAT_LOOP_OLD_AGE: '3', SPLAT_LOOP_TEARDOWN_PARTS: '2', SPLAT_LOOP_TEARDOWN_SPAN: '5', SPLAT_LOOP_GRACE_STEPS: '50' });
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const jid = sceneId(await m.tool('start_scene', { request: 'x' }));
    const build = async () => { for (const id of ['p', 'q']) assert.ok(!(await m.tool('add_solid', { kind: 'box', id, params: { at: [0, 1, 0], half: [0.3, 0.3, 0.3] }, mat: 'wood' })).isError); for (let i = 0; i < 3; i++) await m.tool('catalog', { query: 'kinds' }); };
    const teardown = async () => { await m.tool('remove_part', { id: 'p' }); return m.tool('remove_part', { id: 'q' }); };
    await build();
    let r = await teardown();
    assert.ok(!r.isError && !/LOOP WARNING/.test(r.content[0].text), r.content[0].text);
    await build();
    r = await teardown();
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /^ok\.\nLOOP WARNING: you are looping: finalize now\. .*\n\[step \d+\]$/s);
    await build();
    r = await teardown();
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^JOB FAILED: looped: it tore down and rebuilt established parts again at step \d+ after a loop warning at step \d+ .*stop and reply with this reason in one line\.$/);
    const j = await H.ask(t, { op: 'job', job_id: jid });
    assert.strictEqual(j.status, 'failed');
    assert.match(j.error, /^looped: /);
    assert.match((await m.tool('validate', {})).content[0].text, /no scene is open/);
  } finally { m.close(); H.stop(t); }
});
