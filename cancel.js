#!/usr/bin/env node
'use strict';
// Cancel the 3D scene being made: it is marked failed, and the 3D bot's next tool call tells it to stop and reply with
// the reason (which GlaDOS relays when the request came through her). Usage:
//   node ~/Code/splat-agent/cancel.js [scene_id] [reason]   (no scene_id: the scene being made, if any)
const net = require('net'), os = require('os'), path = require('path');
const SOCK = process.env.SPLAT_SOCK || path.join(os.homedir(), '.hermes', 'splat-agent', 'worker.sock');
function ask(req) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(SOCK);
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.end(); const r = JSON.parse(buf.slice(0, i)); r.ok ? resolve(r.result) : reject(new Error(r.error)); } });
    c.on('error', e => reject(new Error(`the splat service is not reachable at ${SOCK}: ${e.message}`)));
  });
}
(async () => {
  let [jobId, ...why] = process.argv.slice(2);
  if (jobId && !/^[0-9a-f]{16}$/.test(jobId)) { why.unshift(jobId); jobId = ''; }
  const r = await ask({ op: 'close_job', job_id: jobId || undefined, reason: why.join(' ') || undefined });
  if (!r.closed) throw new Error(jobId ? `scene ${jobId} is ${r.why}` : 'no 3D scene is being made');
  console.log(`cancelled 3D scene ${r.job_id}`);
})().catch(e => { console.error('cancel failed: ' + e.message); process.exit(1); });
