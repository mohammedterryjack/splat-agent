'use strict';
// Replays the tool steps of real recorded scenes (test/fixtures/runs, 16 Nov) through the loop check.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const LC = require('../loopcheck.js');
const run = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'runs', name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

test('default thresholds', () => {
  assert.deepStrictEqual(LC.LOOP, { oldAge: 40, teardownParts: 5, teardownSpan: 10, warnAt: 2, graceSteps: 80 });
});

test('the looping rowboat (499 steps, finished 17:48) is warned at step 249 and failed at step 330', () => {
  const r = LC.replay(run('rowboat-looping'));
  assert.deepStrictEqual(r.teardowns, [141, 249]);
  assert.strictEqual(r.events.length, 2);
  assert.strictEqual(r.events[0].step, 249);
  assert.match(r.events[0].warn, /^LOOP WARNING: you are looping: finalize now\. .*steps 141, 249/);
  assert.strictEqual(r.events[1].step, 330);
  assert.match(r.events[1].fail, /^looped: .*warned at step 249, and still had not finished 80 steps later$/);
});

for (const name of ['fox-campfire', 'jump-scare-manor', 'snowy-mailbox', 'snowman', 'good-60df', 'good-72e9', 'good-a90e'])
  test(`good run ${name} never triggers the loop check`, () => {
    const r = LC.replay(run(name));
    assert.deepStrictEqual(r.events, []);
    assert.deepStrictEqual(r.teardowns, []);
  });

test('a teardown after the warning fails at once; young parts and refused steps never count', () => {
  const st = LC.fresh();
  let step = 0;
  const add = id => LC.observe(st, ++step, 'add_solid', {}, true, id);
  const rm = id => LC.observe(st, ++step, 'remove_part', { id }, true);
  const idle = n => { for (let i = 0; i < n; i++) assert.strictEqual(LC.observe(st, ++step, 'render', {}, true), null); };
  const teardown = () => { for (const id of ['a', 'b', 'c', 'd']) assert.strictEqual(rm(id), null); return rm('e'); };
  const build = () => ['a', 'b', 'c', 'd', 'e'].forEach(add);
  build();
  for (const id of ['a', 'b']) { rm(id); add(id); } // young parts: tries, not teardowns
  assert.strictEqual(LC.observe(st, ++step, 'remove_part', { id: 'c' }, false), null); // refused
  idle(40);
  assert.strictEqual(teardown(), null); // first teardown: a redesign
  build(); idle(40);
  assert.ok(teardown().warn);
  build(); idle(40);
  const f = teardown();
  assert.match(f.fail, /^looped: it tore down and rebuilt established parts again at step \d+ after a loop warning at step \d+/);
});

test('a bad threshold fails loudly', () => {
  const { execFileSync } = require('child_process');
  assert.throws(() => execFileSync('node', ['-e', "require('./loopcheck.js')"], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { SPLAT_LOOP_OLD_AGE: 'ten' }), stdio: 'pipe' }),
    /SPLAT_LOOP_OLD_AGE must be a positive integer, got "ten"/);
});
