'use strict';
// One engine at a time for the 3D bot (Mo 18:21 20 Nov: "A: one engine at a time; while an Articraft job runs, new Ink
// scenes and video rebuilds wait, and vice versa"). Each service writes its own mode file in ~/.local/state/3d-mode/
// (ink.json here, articraft.json by ~/Code/articraft-agent/service.py) and reads the other's. A file holds only while
// the process that wrote it is alive with the same command line: a stopped or crashed service holds nothing.
//   ink.json       {pid, cmd, updated, stale_after_s, scene: {job_id, started, last_call, steps} | null, reconstructions: [video ids]}
//   articraft.json {pid, cmd, updated, cap_s, running: {job_id, started, lock_wait_s} | null,
//                   queued: [{job_id, created, waiting_for?}]}          (times in Unix seconds)
// Articraft starts a job only when ink.json has no scene and no reconstructions. Here: start_scene and the scene tools
// answer busy while Articraft has a job running or queued; reconstruct_3d queues while Articraft holds (a job running,
// or a queued head that is not itself waiting for Ink).
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = () => process.env.THREED_MODE_DIR || path.join(os.homedir(), '.local', 'state', '3d-mode');
let SELF = null;
const selfCmd = () => SELF || (SELF = fs.readFileSync('/proc/self/cmdline', 'utf8'));

function write(name, obj) {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  const f = path.join(DIR(), name + '.json'), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ pid: process.pid, cmd: selfCmd(), updated: Date.now() / 1000 }, obj)), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// the other service's file, or null when there is none or its writer is gone; an unreadable file is an error (loud)
function read(name) {
  const f = path.join(DIR(), name + '.json');
  let m;
  try {
    m = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`3D mode file ${f} is unreadable: ${e.message}`);
  }
  let cmd;
  try {
    cmd = fs.readFileSync(`/proc/${m.pid}/cmdline`, 'utf8');
  } catch (e) {
    return null;
  }
  return cmd === m.cmd ? m : null;
}

const mins = s => Math.max(1, Math.ceil(s / 60));
// Articraft's state when it has any job running or queued, else null. eta_s: until Articraft is free (the running
// job's 60-min work cap from its start, plus its lock wait, plus a full cap per queued job: an upper bound).
function articraft() {
  const m = read('articraft');
  if (!m || (!m.running && !(m.queued || []).length)) return null;
  const now = Date.now() / 1000, cap = m.cap_s || 3600, q = m.queued || [];
  const runLeft = m.running ? Math.max(60, m.running.started + cap + (m.running.lock_wait_s || 0) - now) : 0;
  const head = m.running || q[0];
  const what = m.running
    ? `Articraft job ${head.job_id} is running (about ${mins(runLeft)} min left${q.length ? `, then ${q.length} more queued, about ${mins(runLeft + q.length * cap)} min in all` : ''})`
    : `Articraft job ${head.job_id} is queued (${q.length} queued, about ${mins(q.length * cap)} min until Articraft is free)`;
  const eta = m.running ? `about ${mins(runLeft + q.length * cap)} min` : `about ${mins(q.length * cap)} min`;
  const brief = `Articraft job ${head.job_id} (${m.running ? 'running' : 'queued'}, Articraft free in ${eta})`;
  return { job_id: head.job_id, running: !!m.running, holds: !!m.running || !q[0].waiting_for, eta_s: runLeft + q.length * cap, what, brief };
}
// Ink-style busy result for an interactive call that cannot queue
function busyText(tool, a, retry) {
  return `error ${tool}: ${a.what}; the 3D bot runs one engine at a time. Nothing was started and nothing is lost: ` +
    `check with articraft_status ${a.job_id}, and call ${retry || tool} again when it finishes.`;
}
module.exports = { write, read, articraft, busyText, DIR };
