'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
process.env.DELL_ANNOTATE = process.env.DELL_ANNOTATE || 'http://127.0.0.1:9';   // tests never reach a real dell-annotate
function tmpEnv(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splat-test-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'OTHER=1\nSPLAT_AGENT_KEY=test-key-0123456789abcdef0123456789abcdef\n');
  fs.writeFileSync(path.join(dir, 'profile.env'), 'DELL_LLM_API_KEY=x\nAPI_SERVER_KEY=profile-key-123\n');
  const env = Object.assign({}, process.env, {
    SPLAT_DIR: path.join(dir, 'splats'), SPLAT_SOCK: path.join(dir, 'w.sock'), SPLAT_BIND: '127.0.0.1', THREED_MODE_DIR: path.join(dir, '3d-mode'),
    SPLAT_PORT: String(18000 + Math.floor(Math.random() * 1000)), SPLAT_ENV_FILE: path.join(dir, '.env'),
    LONG_JOBS: path.join(__dirname, 'fake_long_jobs.py'), SPLAT_PROFILE_ENV: path.join(dir, 'profile.env'), SPLAT_RUN_POLL_MS: '100', SPLAT_LONG_JOBS_DIR: path.join(dir, 'lj'), FAKE_LONG_JOBS_LOG: path.join(dir, 'lj.log')
  }, extra || {});
  return { dir, env };
}
// a stand-in for the gateway's /p/splat/v1/runs: records runs; t.runs.status is what GET answers
function fakeRuns(t) {
  const http = require('http');
  t.runs = { posted: [], status: 'running', fail: false, stopped: [] };
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', d => (b += d));
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer profile-key-123') { res.writeHead(401); return res.end('{}'); }
        const stop = /\/runs\/([^/]+)\/stop$/.exec(req.url);
        if (req.method === 'POST' && stop) {
          t.runs.stopped.push(stop[1]);
          t.runs.status = 'cancelled';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ run_id: stop[1], status: 'stopping' }));
        }
        if (req.method === 'POST') {
          if (t.runs.fail) { res.writeHead(503); return res.end('{"error":"busy"}'); }
          t.runs.posted.push(JSON.parse(b));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ run_id: 'run_' + t.runs.posted.length, status: 'started' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: t.runs.status, error: t.runs.status === 'failed' ? 'model said no' : undefined, output: 'bye' }));
      });
    });
    srv.listen(0, '127.0.0.1', () => { t.env.SPLAT_RUNS_URL = `http://127.0.0.1:${srv.address().port}/p/splat/v1/runs`; t.runsSrv = srv; resolve(srv); });
  });
}
async function startService(t) {
  if (!t.runsSrv) await fakeRuns(t);
  const p = spawn('node', [path.join(ROOT, 'service.js')], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  p.stdout.on('data', d => (logs += d));
  p.stderr.on('data', d => (logs += d));
  for (let i = 0; i < 100; i++) {
    if (/http /.test(logs) && fs.existsSync(t.env.SPLAT_SOCK)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!/http /.test(logs)) throw new Error('service did not start: ' + logs);
  t.proc = p;
  t.logs = () => logs;
  return p;
}
function ask(t, req) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(t.env.SPLAT_SOCK);
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.end(); const r = JSON.parse(buf.slice(0, i)); r.ok ? resolve(r.result) : reject(new Error(r.error)); } });
    c.on('error', reject);
  });
}
const longJobCalls = t => (fs.existsSync(t.env.FAKE_LONG_JOBS_LOG) ? fs.readFileSync(t.env.FAKE_LONG_JOBS_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const jobId = () => require('crypto').randomBytes(8).toString('hex');
function stop(t, keepRuns) { if (t.proc) t.proc.kill('SIGKILL'); if (t.runsSrv && !keepRuns) { t.runsSrv.close(); t.runsSrv = null; } }
module.exports = { tmpEnv, startService, ask, longJobCalls, jobId, stop, ROOT };
