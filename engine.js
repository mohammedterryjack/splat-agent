'use strict';
// Worker thread: builds and renders on its own thread so the service's socket and viewer stay responsive.
// Holds one built world, keyed by the scene hash, so render/turn/stats on an unchanged scene do not rebuild.
const { parentPort } = require('worker_threads');
const path = require('path');
const C = require('./core.js');
const CK = require('./checks.js');
let cached = null;

function world(spec, fresh) {
  const h = C.specHash(spec);
  if (fresh || !cached || cached.hash !== h || (cached.anim && cached.anim.stateful && cached.clock > 0)) cached = C.build(spec);
  return cached;
}
function capped(w) {
  if (w.count > C.MAX_SPLATS) {
    const e = new Error(`the scene has ${w.count} splats, over the ${C.MAX_SPLATS} limit`);
    e.cap = 'splats';
    e.count = w.count;
    throw e;
  }
  return w;
}

const OPS = {
  render({ spec, yaw, pitch, t, file, w: cw, h: ch }) {
    const w = capped(world(spec));
    const t0 = Date.now();
    C.writePng(file, C.shot(w, { yaw, pitch, t: t || 0, w: cw || 640, h: ch || 360 }));
    return { file, render_ms: Date.now() - t0, stats: C.stats(w) };
  },
  turn({ spec, n, file }) {
    const w = capped(world(spec));
    const t0 = Date.now();
    C.writePng(file, C.turnSheet(w, n || 4, 640, 360));
    return { file, render_ms: Date.now() - t0, stats: C.stats(w) };
  },
  // the anymachine-style checks on a fresh build (posing for the clash sweep must not disturb the cached world)
  checks({ spec, base, base_id }) {
    const w = capped(C.build(spec));
    const t0 = Date.now();
    const r = { floating: CK.floating(w, spec), clashes: CK.clashes(w, spec), diff: base ? Object.assign({ base: base_id }, CK.diff(base, spec)) : null };
    r.ms = Date.now() - t0;
    r.lines = CK.report(r);
    return r;
  },
  stats({ spec }) {
    return { stats: C.stats(capped(world(spec))) };
  },
  async export({ spec, dir }) {
    const timings = {};
    let t0 = Date.now();
    const w = capped(world(spec, true));
    timings.build_s = (Date.now() - t0) / 1000;
    t0 = Date.now();
    const ply = C.writePly(path.join(dir, 'scene.ply'), w);
    timings.ply_s = (Date.now() - t0) / 1000;
    t0 = Date.now();
    ply.round_trip = CK.roundTrip(ply.file, w);   // throws (export fails loudly) if the file differs from the world
    timings.round_trip_s = (Date.now() - t0) / 1000;
    t0 = Date.now();
    C.writePng(path.join(dir, 'final.png'), C.shot(w, { w: 1280, h: 720, t: 0 }));
    timings.png_s = (Date.now() - t0) / 1000;
    t0 = Date.now();
    const vid = await C.writeVideo(path.join(dir, 'preview.mp4'), C.build(spec));
    timings.video_s = (Date.now() - t0) / 1000;
    return { stats: C.stats(w), ply, video: vid, timings };
  }
};

parentPort.on('message', async ({ id, op, args }) => {
  try {
    const result = await OPS[op](args);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message, cap: e.cap, count: e.count });
  }
});
