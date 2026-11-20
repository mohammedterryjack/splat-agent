'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const C = require('../core.js');

const quatToMat = ([w, x, y, z]) => [
  [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
  [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
  [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
];
// Sigma = R S S R^T, as every 3DGS loader rebuilds it
function covFromRow(row) {
  const R = quatToMat(row.slice(10, 14)), s = row.slice(7, 10).map(Math.exp), c = [];
  for (let i = 0; i < 3; i++) { c[i] = []; for (let j = 0; j < 3; j++) { let v = 0; for (let k = 0; k < 3; k++) v += R[i][k] * s[k] * s[k] * R[j][k]; c[i][j] = v; } }
  return c;
}

test('covariance -> log scales + unit quaternion round-trips', () => {
  const cases = [[0.01, 0, 0, 0.01, 0, 0.01], [0.04, 0.01, -0.005, 0.02, 0.003, 0.01], [1e-4, 2e-5, 0, 3e-4, -1e-5, 2e-6], [0.02, 0.0199, 0, 0.02, 0, 0.0001]];
  for (const c of cases) {
    const d = new Float32Array(16);
    d.set([1, 2, 3, 1, c[0], c[1], c[2], 10 + 20 * 256 + 30 * 65536, c[3], c[4], c[5], 0]);
    const row = new Float64Array(14);
    C.splatToRow(d, 0, row, 0);
    assert.ok(Math.abs(Math.hypot(...row.slice(10, 14)) - 1) < 1e-9, 'unit quaternion');
    const back = covFromRow(Array.from(row)), want = [[d[4], d[5], d[6]], [d[5], d[8], d[9]], [d[6], d[9], d[10]]];
    const scale = Math.max(...want.flat().map(Math.abs));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(back[i][j] - want[i][j]) < 1e-5 * scale + 1e-12, `cov[${i}][${j}] ${back[i][j]} vs ${want[i][j]}`);
    // colour and opacity
    assert.ok(Math.abs(row[3] - (10 / 255 - 0.5) / C.SH_C0) < 1e-9);
    assert.ok(Math.abs(row[5] - (30 / 255 - 0.5) / C.SH_C0) < 1e-9);
    assert.ok(Math.abs(1 / (1 + Math.exp(-row[6])) - 0.99) < 1e-9, 'solid splats export at opacity 0.99');
  }
});

test('writePly writes a standard 3DGS header and every visible splat, finite', () => {
  const spec = { id: 't', seed: 1, style: 'slate', camera: { target: [0, 1, 0], dist: 8, pitch: 0.2, yaw: 0.4 }, solids: [{ kind: 'ground', mat: 'earth', rad: 2, res: 0.2 }, { kind: 'ball', at: [0, 1, 0], r: 0.6, mat: 'stone', res: 0.12 }] };
  const w = C.build(spec), f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ply-')), 'scene.ply');
  process.on('exit', () => fs.rmSync(path.dirname(f), { recursive: true, force: true }));
  const r = C.writePly(f, w), p = C.readPly(f);
  assert.deepStrictEqual(p.props, C.PLY_PROPS);
  assert.match(p.header, /format binary_little_endian 1.0/);
  assert.strictEqual(p.n, r.vertices);
  assert.ok(p.n > 500 && p.n <= w.count);
  assert.strictEqual(fs.statSync(f).size, r.bytes);
  for (const v of p.data) assert.ok(Number.isFinite(v));
  // first visible splat sits where the engine put it
  let first = 0; while (!C.visible(w.data, first * 16)) first++;
  assert.ok(Math.abs(p.data[0] - w.data[first * 16]) < 1e-6);
});
