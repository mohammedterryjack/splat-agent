'use strict';
const test = require('node:test'), assert = require('node:assert');
const S = require('../scene.js');
const add = (sp, a) => S.ops.add_solid(sp, a).spec;

test('add_solid names solids and refuses unknown kinds with a did-you-mean', () => {
  let sp = add(S.blank(), { kind: 'ground', params: { rad: 4 }, mat: 'earth' });
  assert.strictEqual(sp.solids[0].id, 'ground');
  assert.throws(() => S.ops.add_solid(sp, { kind: 'bal', params: { at: [0, 1, 0], r: 1 }, mat: 'stone' }), /did you mean "ball"/);
  assert.throws(() => S.ops.add_solid(sp, { kind: 'ball', params: { at: [0, 1, 0], r: 1 }, mat: 'ston' }), /did you mean "stone"/);
  assert.throws(() => S.ops.add_solid(sp, { kind: 'ball', params: { at: [0, 1], r: 1 }, mat: 'stone' }), /three numbers/);
  assert.throws(() => S.ops.add_solid(sp, { kind: 'box', params: { at: [0, 1, 0], hlaf: [1, 1, 1] }, mat: 'stone' }), /did you mean "half"/);
  assert.strictEqual(sp.solids.length, 1, 'refused edits leave the scene unchanged');
  const r = S.ops.add_solid(sp, { kind: 'ball', params: { at: [0, 1, 0], r: 1 }, mat: 'stone' });
  assert.strictEqual(r.id, 'ball');
  assert.strictEqual(S.ops.add_solid(r.spec, { kind: 'ball', params: { at: [0, 2, 0], r: 1 }, mat: 'stone' }).id, 'ball-2');
  assert.throws(() => S.ops.add_solid(r.spec, { kind: 'ball', id: 'ball', params: { at: [0, 2, 0], r: 1 }, mat: 'stone' }), /already exists/);
  assert.throws(() => S.ops.add_solid(r.spec, { kind: 'ball', id: 'Bad Id', params: { at: [0, 2, 0], r: 1 }, mat: 'stone' }), /small letters/);
});

test('join, wrap, edit, move, spin, remove keep stable ids', () => {
  let sp = add(S.blank(), { kind: 'box', id: 'hut', params: { at: [0, 1, 0], half: [1, 1, 1] }, mat: 'wood', part: 'hut' });
  sp = add(sp, { kind: 'tube', id: 'door', params: { pts: [[0, 1, -2], [0, 1, 2]], r: 0.4 }, mat: 'wood' });
  assert.throws(() => S.ops.join(sp, { how: 'cutt', a: 'hut', b: 'door' }), /did you mean "cut"/);
  assert.throws(() => S.ops.join(sp, { how: 'cut', a: 'hut', b: 'dor' }), /did you mean "door"/);
  sp = S.ops.join(sp, { how: 'cut', a: 'hut', b: 'door' }).spec;
  assert.strictEqual(sp.solids.length, 1);
  assert.deepStrictEqual([sp.solids[0].id, sp.solids[0].kind, sp.solids[0].how, sp.solids[0].mat, sp.solids[0].part], ['hut', 'join', 'cut', 'wood', 'hut']);
  assert.strictEqual(sp.solids[0].a.part, undefined);
  sp = S.ops.wrap(sp, { op: 'rough', id: 'hut', params: { by: 0.03 } }).spec;
  assert.strictEqual(sp.solids[0].kind, 'rough');
  assert.strictEqual(sp.solids[0].of.kind, 'join');
  assert.throws(() => S.ops.wrap(sp, { op: 'rough', id: 'hut', params: {} }), /missing/);
  sp = S.ops.move(sp, { id: 'hut', by: [1, 0, 0] }).spec;
  assert.deepStrictEqual(sp.solids[0].of.a.at, [1, 1, 0]);
  assert.deepStrictEqual(sp.solids[0].of.b.pts[0], [1, 1, -2]);
  sp = S.ops.spin(sp, { id: 'hut', turn: [0.3, 0, 0] }).spec;
  assert.deepStrictEqual(sp.solids[0].turn, [0.3, 0, 0]);
  sp = S.ops.edit_part(sp, { id: 'hut', params: { res: 0.12 } }).spec;
  assert.strictEqual(sp.solids[0].res, 0.12);
  sp = S.ops.edit_part(sp, { id: 'hut', params: { res: null } }).spec;
  assert.strictEqual(sp.solids[0].res, undefined);
  assert.throws(() => S.ops.edit_part(sp, { id: 'hut', params: { kind: 'ball' } }), /cannot be changed/);
  sp = S.ops.add_motion(sp, { do: 'bob', part: 'hut', params: { amount: 0.2, period: 3 } }).spec;
  assert.ok(sp.parts.hut.joint);
  assert.throws(() => S.ops.add_motion(sp, { do: 'wiggle', part: 'hut' }), /no motion called/);
  assert.throws(() => S.ops.add_motion(sp, { do: 'spin', part: 'gem' }), /no solid is marked as part "gem"/);
  sp = S.ops.remove_part(sp, { id: 'hut' }).spec;
  assert.strictEqual(sp.solids.length, 0);
  assert.strictEqual(sp.motion, undefined);
  assert.strictEqual(sp.parts, undefined);
});

test('style, light, camera and material edits are checked', () => {
  let sp = add(S.blank(), { kind: 'ball', id: 'b', params: { at: [0, 1, 0], r: 1 }, mat: 'stone' });
  assert.throws(() => S.ops.set_style(sp, { style: 'mos' }), /no style called "mos"/);
  sp = S.ops.set_style(sp, { style: 'ember' }).spec;
  sp = S.ops.set_light(sp, { sun: [0, 1, 0], amb: 0.2 }).spec;
  assert.deepStrictEqual(sp.light, { sun: [0, 1, 0], amb: 0.2 });
  assert.throws(() => S.ops.set_camera(sp, { target: [0, 1] }), /camera.target/);
  sp = S.ops.set_camera(sp, { dist: 9 }).spec;
  assert.strictEqual(sp.camera.dist, 9);
  assert.throws(() => S.ops.set_material(sp, { id: 'b', mat: 'woood' }), /did you mean "wood"/);
  sp = S.ops.set_material(sp, { id: 'b', mat: { role: 'wood', noise: 0.2 } }).spec;
  assert.deepStrictEqual(sp.solids[0].mat, { role: 'wood', noise: 0.2 });
});

test('a warp taper is refused (this Ink build cannot build one); twist and bend warps build', () => {
  const C = require('../core.js');
  let sp = add(S.blank(), { kind: 'box', id: 'hull', params: { at: [0, 1, 0], half: [1, 0.5, 0.5] }, mat: 'wood' });
  assert.throws(() => S.ops.wrap(sp, { op: 'warp', id: 'hull', params: { taper: 0.75 } }), /warp taper cannot be built/);
  for (const params of [{ twist: 0.4 }, { bend: 0.3 }]) {
    const w = S.ops.wrap(sp, { op: 'warp', id: 'hull', params }).spec;
    assert.ok(C.stats(C.build(w)).splats > 0, JSON.stringify(params));
  }
});

test('a fence takes its a and b end points in params; a nested solid there is still refused', () => {
  const C = require('../core.js');
  const sp = add(S.blank(), { kind: 'fence', id: 'fence', params: { a: [-2, 0, 0], b: [2, 0, 0] }, mat: 'wood' });
  assert.ok(C.stats(C.build(sp)).splats > 0);
  assert.throws(() => S.ops.add_solid(S.blank(), { kind: 'join', params: { a: { kind: 'ball', at: [0, 0, 0], r: 1 } } }), /put "a" in its own argument/);
});
