'use strict';
// Unique hex prefixes for video and scene ids ("2623" for 2623dc131e744dd0); ambiguous or unknown ones are errors.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const H = require('./helpers.js'), IDS = require('../ids.js');

const O = { tool: 'reconstruct_3d', arg: 'video', noun: 'video' };
test('ids.resolve: unique prefix, full id, ambiguous with an example, no match, not hex', () => {
  const ids = ['2623dc131e744dd0', '26aa000000000000', '26ab000000000000', '1111111111111111'];
  assert.strictEqual(IDS.resolve('2623', ids, O), '2623dc131e744dd0');
  assert.strictEqual(IDS.resolve(' 2623DC ', ids, O), '2623dc131e744dd0');
  assert.strictEqual(IDS.resolve('2623dc131e744dd0', ids, O), '2623dc131e744dd0');
  assert.strictEqual(IDS.resolve('ffffffffffffffff', ids, O), 'ffffffffffffffff');   // a full id need not be known yet
  assert.strictEqual(IDS.resolve('nothex', ids, O), null);
  assert.throws(() => IDS.resolve('26', ids, O), { message: 'error reconstruct_3d.video: "26" matches 3 videos (2623dc131e744dd0, 26aa000000000000, 26ab000000000000); for example "2623"' });
  assert.throws(() => IDS.resolve('26a', ids, O), { message: /^error reconstruct_3d\.video: "26a" matches 2 videos \(26aa000000000000, 26ab000000000000\); for example "26aa"$/ });
  assert.throws(() => IDS.resolve('9', ids, O), { message: /^error reconstruct_3d\.video: no video starts with "9"; give "latest", a full 16-hex id or a unique start of one$/ });
  const many = Array.from({ length: 7 }, (_, i) => 'ab' + String(i).repeat(14));
  assert.throws(() => IDS.resolve('ab', many, O), { message: /matches 7 videos \(.*, and 2 more\); for example "ab00"$/ });
});

function env() {
  const t = H.tmpEnv();
  Object.assign(t.env, { DELL_ANNOTATE: 'http://127.0.0.1:9', SPLAT_DELL_ENV: path.join(t.dir, 'profile.env'), SPLAT_VISION_DIR: path.join(t.dir, 'vision') });
  return t;
}
function mcpSession(t) {
  const p = spawn('node', [path.join(H.ROOT, 'mcp.js')], { env: t.env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0;
  const pending = new Map();
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const f = pending.get(m.id); if (f) { pending.delete(m.id); f(m); } } });
  const call = (method, params) => new Promise(r => { const n = ++id; pending.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { tool: async (name, args) => (await call('tools/call', { name, arguments: args || {} })).result, close: () => p.kill() };
}
const txt = r => r.content[0].text;

test('reconstruct_3d takes a unique prefix of a video here or a Vision job id (video and old job_id)', async () => {
  const t = env();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const root = path.join(t.env.SPLAT_DIR, 'vggt');
    ['26aa000000000000', '26ab000000000000', '2623dc131e744dd0'].forEach((id, i) => {   // oldest first
      fs.mkdirSync(path.join(root, id), { recursive: true });
      const f = path.join(root, id, 'view.token'), when = new Date(Date.now() - (3 - i) * 60000);
      fs.writeFileSync(f, 'x'.repeat(36));
      fs.utimesSync(f, when, when);
    });
    fs.mkdirSync(path.join(t.env.SPLAT_VISION_DIR, '7777000000000000'), { recursive: true });
    assert.strictEqual(txt(await m.tool('reconstruct_3d', { video: '26' })), 'error reconstruct_3d.video: "26" matches 3 videos (2623dc131e744dd0, 26ab000000000000, 26aa000000000000); for example "2623"');
    assert.match(txt(await m.tool('reconstruct_3d', { job_id: '26a' })), /^error reconstruct_3d\.video: "26a" matches 2 videos/);
    assert.match(txt(await m.tool('reconstruct_3d', { video: '9' })), /^error reconstruct_3d\.video: no video starts with "9"/);
    // resolved: it gets as far as the (absent) Dell, failing loudly, and no directory is made for the prefix
    for (const a of [{ video: '2623' }, { job_id: '2623' }, { video: '2623dc131e744dd0' }, { video: '7777' }]) {
      const r = await m.tool('reconstruct_3d', a);
      assert.ok(r.isError);
      assert.match(txt(r), /^error reconstruct_3d: /, JSON.stringify(a) + ' ' + txt(r));
    }
    assert.ok(!fs.existsSync(path.join(root, '2623')) && !fs.existsSync(path.join(root, '7777')));
    assert.ok(fs.existsSync(path.join(root, '7777000000000000', 'view.token')));   // the Vision job got its viewer token here
  } finally { m.close(); H.stop(t); }
});

test('show_scene and start_scene based_on take a unique scene id prefix', async () => {
  const t = env();
  await H.startService(t);
  const m = mcpSession(t);
  try {
    const jid = /Scene ([0-9a-f]{16}) started/.exec(txt(await m.tool('start_scene', { request: 'a box' })))[1];
    await m.tool('add_solid', { kind: 'ground', params: { rad: 2, res: 0.2 }, mat: 'earth' });
    await m.tool('add_solid', { kind: 'box', id: 'b', params: { at: [0, 0.3, 0], half: [0.3, 0.3, 0.3], res: 0.12 }, mat: 'wood' });
    await m.tool('set_camera', { target: [0, 0.3, 0], dist: 5 });
    await m.tool('validate', {});
    await m.tool('turn', {});
    assert.ok(!(await m.tool('finish', { title: 'Box', summary: 'A box.' })).isError);
    const sh = txt(await m.tool('show_scene', { scene: jid.slice(0, 5) }));
    assert.match(sh, new RegExp(`scene ${jid}\\)`));
    assert.match(txt(await m.tool('show_scene', { scene: jid[0] === 'f' ? '0' : 'f' })), /^error show_scene\.scene: no scene starts with /);
    assert.match(txt(await m.tool('start_scene', { request: 'bigger', based_on: jid.slice(0, 4) })), new RegExp(`started from scene ${jid}`));
  } finally { m.close(); H.stop(t); }
});
