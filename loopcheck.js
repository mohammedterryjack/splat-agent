'use strict';
// Loop check for a 3D scene (Mo, 16 Nov: "put in a check to prevent it looping"). Not a step limit: a scene may take
// as many steps as it needs. What it catches is a TEARDOWN: removing several ESTABLISHED parts (parts that had
// survived many steps) in a short burst, i.e. throwing away built work and rebuilding it. One teardown is a normal
// redesign; repeated teardowns are a loop. The second teardown sends the 3D bot a one-time warning ("you are
// looping: finalize now"); after the warning, another teardown, or still no finish well after the warning, fails the
// scene with a reason that says it looped.
//
// Thresholds (env overrides, calibrated 16 Nov on all 12 recorded scenes, see test/loopcheck.test.js):
//   oldAge 40: a part counts as established after surviving 40 tool steps. Good runs remove mostly parts they made
//     a few steps earlier (tries); at 40 the good runs (fox 271 steps, Jump Scare Manor 202, mailbox 112, ...) never
//     remove 5 established parts within 10 steps, while the looping rowboat (499 steps) did so 3 times.
//   teardownParts 5 / teardownSpan 10: 5 established parts removed within 10 steps is one teardown. The fox's
//     biggest such burst is 2 to 3 (tidying rocks or balls); 4 already caught early redesigns in good runs.
//   warnAt 2: the first teardown can be a legitimate redesign, the second is the loop.
//   graceSteps 80: after the warning a cooperating bot needs a turn, a few fixes and finish (10 to 30 steps); 80
//     leaves room for that and fails only a bot that keeps going.
const num = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
};
const LOOP = {
  oldAge: num('SPLAT_LOOP_OLD_AGE', 40),
  teardownParts: num('SPLAT_LOOP_TEARDOWN_PARTS', 5),
  teardownSpan: num('SPLAT_LOOP_TEARDOWN_SPAN', 10),
  warnAt: num('SPLAT_LOOP_WARN_AT', 2),
  graceSteps: num('SPLAT_LOOP_GRACE_STEPS', 80)
};
const BORN = ['add_solid', 'join', 'wrap'];

const fresh = () => ({ born: {}, old: [], teardowns: [], warned_at: null });

const warnText = st =>
  `LOOP WARNING: you are looping: finalize now. You have torn down and rebuilt established parts ${st.teardowns.length} times ` +
  `(steps ${st.teardowns.join(', ')}). Stop rebuilding: make only small fixes, then turn and finish. Another teardown, or no finish ` +
  `within ${LOOP.graceSteps} steps, fails the scene.`;

// One successful or refused tool step. newId: the id the step created (add_solid, join, wrap), if any.
// Returns null, {warn: text} (once) or {fail: reason}.
function observe(st, step, name, args, ok, newId) {
  if (st.warned_at !== null && step - st.warned_at > LOOP.graceSteps)
    return { fail: `looped: it tore down and rebuilt established parts at steps ${st.teardowns.join(', ')}, was warned at step ${st.warned_at}, and still had not finished ${LOOP.graceSteps} steps later` };
  if (!ok) return null;
  if (newId && BORN.includes(name)) st.born[newId] = step;
  if (name !== 'remove_part') return null;
  const id = args && args.id;
  if (!Object.prototype.hasOwnProperty.call(st.born, id)) return null;
  const age = step - st.born[id];
  delete st.born[id];
  if (age < LOOP.oldAge) return null;
  st.old = st.old.filter(t => t > step - LOOP.teardownSpan).concat(step);
  const last = st.teardowns[st.teardowns.length - 1];
  if (st.old.length < LOOP.teardownParts || (last !== undefined && step - last <= LOOP.teardownSpan)) return null;
  st.teardowns.push(step);
  if (st.warned_at === null) {
    if (st.teardowns.length < LOOP.warnAt) return null;
    st.warned_at = step;
    return { warn: warnText(st) };
  }
  return { fail: `looped: it tore down and rebuilt established parts again at step ${step} after a loop warning at step ${st.warned_at} (teardowns at steps ${st.teardowns.join(', ')})` };
}

// Replays a recorded transcript.jsonl (tool steps only) and returns the events with their steps.
function replay(records) {
  const st = fresh(), events = [];
  for (const r of records) {
    if (!r.tool || !(r.step > 0)) continue;
    const m = /^ok: ([\w-]+)\./.exec(r.result || '');
    const ev = observe(st, r.step, r.tool, r.args || {}, !!r.ok, m && m[1]);
    if (ev) {
      events.push(Object.assign({ step: r.step }, ev));
      if (ev.fail) break;
    }
  }
  return { events, teardowns: st.teardowns };
}

module.exports = { LOOP, fresh, observe, replay };
