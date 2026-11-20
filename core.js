'use strict';
// Ink Studio engine glue for the splat agent: build a diorama spec into a world, render it, export it.
// Everything here is synchronous and CPU-bound; service.js runs it on a worker thread.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto'),
  { spawn } = require('child_process');
const INK = process.env.INK_STUDIO || path.join(os.homedir(), 'scratch', 'shapeshift-labs-ink-studio');
const studio = require(INK),
  lib = studio.load(),
  K = lib.KIT,
  R = require(path.join(INK, 'cli', 'render.js')),
  PNG = require(path.join(INK, 'cli', 'png.js'));
const MAX_SPLATS = 250000;

const specHash = spec => crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);

function build(spec) {
  const fb = require('./assets.js').forBuild(spec);   // mesh solids from the asset library, one key per placement
  const t0 = Date.now(),
    w = K.diorama.build(fb.spec, fb.env);
  w.buildMs = Date.now() - t0;
  w.clock = 0;
  w.hash = specHash(spec);
  if (w.anim && w.anim.stateful) w.anim.update(0, 0);
  return w;
}

// put the world at time t (as cli/ink-studio.js pose does): stateful worlds are stepped forward a 60th at a time
function pose(w, t) {
  if (!w.anim) return;
  if (w.anim.stateful) {
    if (t < w.clock - 1e-9) throw new Error('internal: stateful world asked to go back in time');
    while (w.clock < t - 1e-9) {
      const dt = Math.min(1 / 60, t - w.clock);
      w.clock += dt;
      w.anim.update(dt, w.clock);
    }
  } else w.anim.update(1 / 60, t);
  w.clock = t;
  if (w.anim.bones) {
    if (!w.rest) w.rest = w.data;
    w.data = K.bones.posed({
      data: w.rest,
      anim: w.anim,
      get posedBuf() {
        return w.posedBuf;
      },
      set posedBuf(v) {
        w.posedBuf = v;
      }
    });
  }
}

// an exact cw x ch picture: the art-pixel render scaled up by its own pixel size, then centre-cropped
function shot(w, o) {
  const cw = o.w,
    ch = o.h,
    t = o.t || 0;
  pose(w, t);
  const im = R.render(w, { t, yaw: o.yaw, pitch: o.pitch, zoom: o.zoom || 1, w: cw, h: ch });
  const up = R.upscale(im, im.px);
  if (up.w === cw && up.h === ch) return up;
  const out = { w: cw, h: ch, rgb: new Uint8Array(cw * ch * 3) },
    bg = w.pal[0],
    ox = Math.floor((up.w - cw) / 2),
    oy = Math.floor((up.h - ch) / 2);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const sx = x + ox,
        sy = y + oy,
        q = (y * cw + x) * 3;
      if (sx >= 0 && sy >= 0 && sx < up.w && sy < up.h) {
        const s = (sy * up.w + sx) * 3;
        out.rgb[q] = up.rgb[s];
        out.rgb[q + 1] = up.rgb[s + 1];
        out.rgb[q + 2] = up.rgb[s + 2];
      } else {
        out.rgb[q] = (bg >> 16) & 255;
        out.rgb[q + 1] = (bg >> 8) & 255;
        out.rgb[q + 2] = bg & 255;
      }
    }
  return out;
}

function writePng(file, img) {
  PNG.write(file, img.w, img.h, img.rgb);
  return file;
}

// four (or n) views a full turn apart, 2 columns, each labelled with its yaw
function turnSheet(w, n, cw, ch) {
  const imgs = [],
    labs = [];
  for (let k = 0; k < n; k++) {
    const yaw = w.cam.yaw + (k / n) * Math.PI * 2;
    imgs.push(shot(w, { yaw, w: cw, h: ch, t: 0 }));
    labs.push('y' + yaw.toFixed(1));
  }
  return R.grid(imgs, 2, labs);
}

function stats(w) {
  const d = w.data,
    N = w.count,
    lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  let glow = 0,
    moving = 0;
  for (let i = 0, q = 0; i < N; i++, q += 16) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], d[q + k]);
      hi[k] = Math.max(hi[k], d[q + k]);
    }
    const kr = Math.round(d[q + 11]);
    if (kr & 32) glow++;
    if (kr % 16) moving++;
  }
  const r1 = v => Math.round(v * 100) / 100;
  return {
    splats: N,
    max_splats: MAX_SPLATS,
    build_ms: w.buildMs,
    extent: { min: lo.map(r1), max: hi.map(r1) },
    glowing: glow,
    shader_animated: moving,
    moving_parts: (w.lab && w.lab.parts) || [],
    camera: { target: w.cam.target.map(r1), dist: r1(w.cam.dist), pitch: r1(w.cam.pitch), yaw: r1(w.cam.yaw) }
  };
}

// ---- standard 3DGS .ply (degree-0 SH): x y z f_dc_0..2 opacity scale_0..2 rot_0..3 (rot_0 = w), little endian
// covariance -> eigenvalues (Jacobi) -> log std scales + rotation quaternion
function eigSym3(c00, c01, c02, c11, c12, c22) {
  const a = [
      [c00, c01, c02],
      [c01, c11, c12],
      [c02, c12, c22]
    ],
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-30)) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2]
    ]) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]),
        t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)),
        c = 1 / Math.sqrt(t * t + 1),
        s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p],
          akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k],
          aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p],
          vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { val: [a[0][0], a[1][1], a[2][2]], vec: v }; // columns of vec are eigenvectors
}

function matToQuat(m) {
  // m: rotation matrix (rows), returns [w, x, y, z]
  const tr = m[0][0] + m[1][1] + m[2][2];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[2][1] - m[1][2]) / s;
    y = (m[0][2] - m[2][0]) / s;
    z = (m[1][0] - m[0][1]) / s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    w = (m[2][1] - m[1][2]) / s;
    x = 0.25 * s;
    y = (m[0][1] + m[1][0]) / s;
    z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    w = (m[0][2] - m[2][0]) / s;
    x = (m[0][1] + m[1][0]) / s;
    y = 0.25 * s;
    z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    w = (m[1][0] - m[0][1]) / s;
    x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z);
  return [w / n, x / n, y / n, z / n];
}

const SH_C0 = 0.28209479177387814;
const PLY_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

function splatToRow(d, q, out, o) {
  out[o] = d[q];
  out[o + 1] = d[q + 1];
  out[o + 2] = d[q + 2];
  const pk = d[q + 7],
    r = pk % 256,
    g = Math.floor(pk / 256) % 256,
    b = Math.floor(pk / 65536);
  out[o + 3] = (r / 255 - 0.5) / SH_C0;
  out[o + 4] = (g / 255 - 0.5) / SH_C0;
  out[o + 5] = (b / 255 - 0.5) / SH_C0;
  const a = Math.min(0.99, Math.max(0.004, d[q + 3]));
  out[o + 6] = Math.log(a / (1 - a));
  const e = eigSym3(d[q + 4], d[q + 5], d[q + 6], d[q + 8], d[q + 9], d[q + 10]),
    v = e.vec;
  // rotation whose columns are the eigenvectors; make it proper (det +1)
  const det =
    v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) -
    v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) +
    v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  for (let k = 0; k < 3; k++) out[o + 7 + k] = 0.5 * Math.log(Math.max(e.val[k], 1e-14));
  const qt = matToQuat(v);
  out[o + 10] = qt[0];
  out[o + 11] = qt[1];
  out[o + 12] = qt[2];
  out[o + 13] = qt[3];
}

// splats parked out of sight (spare particle pools below y = -30, or with no density) are not part of the scene
const visible = (d, q) => d[q + 3] > 0 && d[q + 1] >= -30;

function writePly(file, w) {
  pose(w, 0);
  const P = PLY_PROPS.length,
    keep = [];
  for (let i = 0; i < w.count; i++) if (visible(w.data, i * 16)) keep.push(i);
  const N = keep.length,
    head = Buffer.from(
      'ply\nformat binary_little_endian 1.0\ncomment ink-studio splat-agent export\nelement vertex ' +
        N +
        '\n' +
        PLY_PROPS.map(p => 'property float ' + p).join('\n') +
        '\nend_header\n'
    ),
    body = new Float32Array(N * P),
    row = new Float64Array(P);
  keep.forEach((i, j) => {
    splatToRow(w.data, i * 16, row, 0);
    for (let k = 0; k < P; k++) {
      if (!Number.isFinite(row[k])) throw new Error('ply export: splat ' + i + ' has a non-finite ' + PLY_PROPS[k]);
      body[j * P + k] = row[k];
    }
  });
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(body.buffer)]));
  return { file, vertices: N, hidden: w.count - N, bytes: head.length + body.byteLength };
}

function readPly(file) {
  const buf = fs.readFileSync(file),
    end = buf.indexOf('end_header\n');
  if (end < 0) throw new Error('not a ply: no end_header');
  const header = buf.slice(0, end).toString(),
    n = +/element vertex (\d+)/.exec(header)[1],
    props = [...header.matchAll(/property float (\S+)/g)].map(m => m[1]),
    off = end + 'end_header\n'.length,
    data = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * props.length * 4));
  return { n, props, data, header };
}

// ---- preview.mp4: one 360 degree orbit, frames piped as raw RGB into ffmpeg
function writeVideo(file, w, o) {
  o = Object.assign({ w: 1280, h: 720, fps: 30, frames: 270 }, o);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', o.w + 'x' + o.h,
    '-r', String(o.fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '2', file];
  // synchronous frame production with a blocking write loop: run ffmpeg and feed it through a temp fifo-less pipe
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => (err += d));
    ff.on('error', reject);
    ff.on('close', code =>
      code === 0 ? resolve({ file, frames: o.frames, seconds: o.frames / o.fps }) : reject(new Error('ffmpeg exited ' + code + ': ' + err.slice(-400)))
    );
    const yaw0 = w.cam.yaw;
    let k = 0;
    const next = () => {
      while (k < o.frames) {
        const img = shot(w, { yaw: yaw0 + (k / o.frames) * Math.PI * 2, t: k / o.fps, w: o.w, h: o.h });
        k++;
        if (!ff.stdin.write(Buffer.from(img.rgb.buffer, img.rgb.byteOffset, img.rgb.byteLength))) {
          ff.stdin.once('drain', next);
          return;
        }
      }
      ff.stdin.end();
    };
    ff.stdin.on('error', reject);
    next();
  });
}

module.exports = { visible, K, R, PNG, INK, MAX_SPLATS, studio, specHash, build, pose, shot, writePng, turnSheet, stats, writePly, readPly, writeVideo, eigSym3, matToQuat, splatToRow, PLY_PROPS, SH_C0 };
