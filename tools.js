'use strict';
// Tool definitions shared by the MCP server (tools/list) and the service (catalog text).
const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const mat = {
  description: 'Material: a role name ("stone", "wood", "moss", "leaf", "earth", "water", "metal", "bone", "pale", "dark", "ember", "glow", "accent") or an object {"role": "wood", "noise": 0.2, "glow": true, "over": {"role": "moss", "patch": 0.4}}'
};
const obj = d => ({ type: 'object', description: d, additionalProperties: true });
const T = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false } });

const TOOLS = [
  T('start_scene', 'Start making a 3D scene with Ink: game-style splat scenes and decorative objects. For real working joints or a CAD/USDZ file use articraft_generate instead; to rebuild from a video use reconstruct_3d. Call this first for every request to make or change a splat scene. request is Mo\'s request in his words. To change a finished scene ("make the hut bigger", "change my last scene") give based_on: "latest" or that scene\'s 16-hex id; leave it out for a new scene. One scene is made at a time: if another is being made it says so, then tell Mo.', { request: { type: 'string' }, based_on: { type: 'string', description: '"latest", a finished scene id (or a unique start of one), or empty for a new scene' } }, ['request']),
  T('cancel_scene', 'Cancel the scene being made (when Mo asks to stop it, or when you cannot finish it). It is marked failed with the reason.', { reason: { type: 'string' } }, []),
  T('list_scenes', 'List the last 10 scenes: id, status, title, when, and the request or why it failed.', {}, []),
  T('show_scene', 'Get a finished scene\'s result to show Mo again: its summary, viewer link and MEDIA: lines for the screenshot, preview video and .ply.', { scene: { type: 'string', description: '"latest" (default), a scene id, or a unique start of one' } }, []),
  T('catalog', 'Look up what the scene can contain: a solid kind (its required and optional fields), "kinds", "joins", "wraps", "materials", "styles", "motion", "camera", "light", or any word. Use before a solid kind you have not used yet.', { query: { type: 'string' } }, ['query']),
  T('add_solid', 'Add one solid to the scene. kind is a solid kind (ball, box, lathe, torus, tube, regular, rock, ground, pillar, arch, stairs, fence, pipe, extrude, revolve, puff, mesh); see catalog(kind) for its fields. params holds its fields (e.g. {"at": [0,1,0], "half": [1,1,1], "res": 0.1}). mat is required except for mesh, which keeps its model\'s colours. id names it (small letters, digits, dashes) for later edits; part makes it a moving part for add_motion. Y is up, units are metres-ish; positions are [x, y, z].', { kind: { type: 'string' }, params: obj('the kind\'s fields; see catalog(kind)'), mat, part: { type: 'string', description: 'moving-part name (only if it will move)' }, id: { type: 'string' } }, ['kind', 'params']),
  T('join', 'Combine two top-level solids a and b into one. how: union, cut (a minus b), common, round, chamfer, stairs, columns, pipe, engrave, groove, tongue. params may hold size (blend size) and steps. The result keeps id a (or the id you give) and a\'s material and part.', { how: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, params: obj('optional: {"size": 0.2, "steps": 3, "res": 0.1}'), id: { type: 'string' } }, ['how', 'a', 'b']),
  T('wrap', 'Wrap a top-level solid in a shape operation, keeping its id: fold (polar n copies round an axis, mirror x|y|z, repeat [x,y,z] with count), warp (twist or bend, centre, wide), shell (t: hollow wall thickness), swell (by: grow/shrink), rough (by, scale: rough surface), bubbles (cell, h).', { op: { type: 'string', enum: ['fold', 'warp', 'shell', 'swell', 'rough', 'bubbles'] }, id: { type: 'string' }, params: obj('the operation\'s fields, e.g. {"polar": 6, "centre": [0,0,0]}') }, ['op', 'id', 'params']),
  T('edit_part', 'Change fields of a solid by id (any field except id and kind). A null value removes the field. Example: {"id": "roof", "params": {"r": 1.4, "res": 0.12}}.', { id: { type: 'string' }, params: obj('fields to set; null removes one') }, ['id', 'params']),
  T('remove_part', 'Remove a top-level solid by id (and its motion, if no other solid shares its moving part).', { id: { type: 'string' } }, ['id']),
  T('move', 'Move a solid (and everything inside it) by [dx, dy, dz].', { id: { type: 'string' }, by: vec3 }, ['id', 'by']),
  T('spin', 'Set a solid\'s fixed orientation: turn = [yaw, tilt, roll] in radians. Not motion: use add_motion to make a part move.', { id: { type: 'string' }, turn: vec3 }, ['id', 'turn']),
  T('set_material', 'Set the material of a solid by id.', { id: { type: 'string' }, mat }, ['id', 'mat']),
  T('set_style', 'Set the colour style: "slate" (cool stone, greens, rich palette), "moss" (greens and reds) or "ember" (warm). roles can remap a role to palette indices dark-to-light; palette can replace the colours (list of hex strings, max 48).', { style: { type: 'string' }, roles: obj('e.g. {"wood": [11, 12, 13, 14]}'), palette: { type: 'array', items: { type: 'string' } } }, []),
  T('set_light', 'Set lighting: sun direction [x, y, z] (towards the sun), amb (ambient 0..1), sky (sky fill 0..1).', { sun: vec3, amb: { type: 'number' }, sky: { type: 'number' } }, []),
  T('set_camera', 'Set the default camera: target point [x, y, z], dist (distance), pitch (radians up), yaw (radians round Y). Frame the whole scene.', { target: vec3, dist: { type: 'number' }, pitch: { type: 'number' }, yaw: { type: 'number' } }, []),
  T('add_motion', 'Animate a moving part: do = spin (axis, speed rad/s), bob (axis, amount, period s), turn (swing: axis, amount rad, period), squash (amount, period). joint is the pivot (default: the part\'s centre).', { do: { type: 'string', enum: ['spin', 'bob', 'turn', 'squash'] }, part: { type: 'string' }, params: obj('e.g. {"axis": [0,1,0], "speed": 0.8}'), joint: vec3 }, ['do', 'part']),
  T('remove_motion', 'Remove every motion on a moving part.', { part: { type: 'string' } }, ['part']),
  T('validate', 'Check the whole scene: every problem as "error|warning <path>: <problem>; <hint>" with "did you mean" hints, then an outline. Also builds it and checks the build: floating solids (not resting on or touching anything that leads to the ground), moving parts that pass through other solids during their motion, and (for a changed scene) what was added, removed or updated; ends with "build checks: sound" or the warning count.', {}, []),
  T('list_assets', 'Search the asset library: ready-made low-poly models (nature: trees, rocks, plants, paths, fences, tents, logs...; furniture: chairs, tables, beds, kitchens, lamps...). query is one or more words; "kits" gives the counts. Place one with add_solid kind "mesh" (fields: catalog("mesh")).', { query: { type: 'string' } }, []),
  T('render', 'Render the scene (640x360, pixel-art) and look at it. Optional yaw/pitch (radians) to look from another side, t (seconds) for a moment of the motion.', { yaw: { type: 'number' }, pitch: { type: 'number' }, t: { type: 'number' } }, []),
  T('turn', 'Render 4 views a quarter turn apart on one sheet and look at them, with the build checks (floating, moving-part clashes, changes). Required after your last edit and before finish: check every view against the request and fix what is wrong.', { n: { type: 'integer', enum: [4] } }, []),
  T('stats', 'Splat count (limit 250000), extent, moving parts and camera of the built scene.', {}, []),
  T('upload_video', 'Upload a video for 3D reconstruction (no scene needed). Give exactly one of path (a file on this machine, e.g. a chat attachment) or url (http/https); start and duration (seconds) take part of it. Returns the video id for reconstruct_3d.', { path: { type: 'string' }, url: { type: 'string' }, start: { type: 'number', minimum: 0 }, duration: { type: 'number', minimum: 0 }, name: { type: 'string', description: 'short label' } }, []),
  T('reconstruct_3d', 'Rebuild a video in 3D with VGGT-Omega on the Dell: only for rebuilding a video (splat scenes and decorative objects: start_scene; real working joints or CAD/USDZ: articraft_generate). Queued, never cancelled; no scene needed. video: "latest" or the upload_video id (a Vision job id works too). Waits up to wait_s, then says queued or running: call again. Returns the viewer link, a preview and a layout per shot; see catalog("reconstruction").', { video: { type: 'string', description: '"latest" (default), a 16-hex video id, or a unique start of one (e.g. "2623")' }, frames: { type: 'integer', minimum: 1, maximum: 100, description: 'frames per shot, default 60' }, trim: { type: 'number', minimum: 0, maximum: 99, description: 'percent of least confident points dropped, default 20' }, wait_s: { type: 'integer', minimum: 0, maximum: 840, description: 'seconds to wait this call, default 720' } }, []),
  T('list_reconstructions', 'List the last 10 videos for 3D reconstruction: id, state (done, copying, not reconstructed here yet), name, when, shots and viewer link.', {}, []),
  T('finish', 'Finish the scene: exports the .ply, screenshot, preview video and scene, and gives the lines to reply to Mo with (summary, viewer link, MEDIA: lines and a Checks line). Every build warning still open is listed there, one line each with its id and the problem, then a question asking Mo whether he wants them refined: pass them on unchanged. Only after turn has been checked on the final scene.', { title: { type: 'string' }, summary: { type: 'string', description: 'one or two sentences on what the scene shows' } }, ['title', 'summary'])
];

const KIND_NOTES = {
  ground: 'a round patch of ground (rad = radius, default 8). Put it first.',
  ball: 'sphere or ellipsoid: at, r (number or [rx, ry, rz])',
  rock: 'a lumpy rock: at, r',
  box: 'box: at (centre), half (half-extents [x, y, z]), round (corner rounding)',
  lathe: 'turned shape round the Y axis: at (base centre), h (height), r (radius, [bottom, top], or a profile [[0..1 height, radius], ...])',
  torus: 'ring: at, R (ring radius), r (tube radius); lies flat (use turn to stand it up)',
  tube: 'a tube along points: pts [[x,y,z], ...] (2 or more), r (radius or [start, end])',
  regular: 'a die-like polyhedron: shape d4|d6|d8|d12|d20, at, r, round',
  extrude: 'a 2D outline pushed out: outline ({"ngon": 6, "r": 1}, {"star": 5, "r": 1, "inner": 0.5}, {"rect": [w, h]}, {"gear": 12, "r": 1} or {"svg": "M0 0 L1 0 ..."}), at, depth',
  revolve: 'a 2D outline spun round Y: outline, at',
  puff: 'a 2D outline puffed up like a cushion: outline, at, height',
  pillar: 'a column: at (base), h, r, flutes',
  arch: 'a stone arch: at, span, height, depth, thick, block',
  stairs: 'a flight of steps: at, dir ([x, 0, z] direction), rise, width, riser, tread',
  fence: 'a fence from a to b ([x, y, z] each): h, bay, pickets',
  pipe: 'a pipe along pts: r, wall, collar',
  mesh: 'a ready-made model from the asset library (find names with list_assets): asset, at (base centre, it stands on at.y), size (largest side, default 4), spin (turn about Y, radians). Optional: cells (signed-field grid; finer = slower), thick (sheet thickness for open meshes), up "y"|"z" (the model\'s up axis), hues (how many palette ramps its colours become). Leave mat out to keep the model\'s own colours; give mat to paint it one material. Example: add_solid kind "mesh", params {"asset": "nature/tree_oak", "at": [2, 0, -1], "size": 3, "spin": 0.5}',
  join: 'use the join tool',
  fold: 'use the wrap tool',
  warp: 'use the wrap tool',
  shell: 'use the wrap tool',
  swell: 'use the wrap tool',
  rough: 'use the wrap tool',
  bubbles: 'use the wrap tool'
};
// catalog("reconstruction"): what reconstruct_3d's per-shot layout means
const RECON_NOTE = 'reconstruction [op, ready]: reconstruct_3d rebuilds each shot of a video (split at scene cuts) from up to frames sampled frames with VGGT-Omega on the Dell: camera path, depth, a coloured point cloud per shot, an RGB|depth video and a preview. Each shot comes back in scene units: X right, Y up from the floor, Z towards the camera, centred on X/Z, about 10 units across (relative scale, not metres): its size, the camera\'s start and end, and a top-down 8x8 grid (rows far to near, left to right) of the top surface height and mean colour of each cell ("." = empty). use: upload_video, then reconstruct_3d(video); to make a scene from it, start_scene and block out ground, walls and furniture at the grid\'s heights and colours, then refine with render/turn against the preview. Full numbers are in vggt_layout.json.';
const COMMON_NOTE = 'Every solid may also have: res (surface grain, 0.06 fine .. 0.2 coarse; splats grow with 1/res^2, keep the total under 250000), turn [yaw, tilt, roll], carve (true: subtract from earlier solids), ghost, group.';

// old tool names that still work (not listed); old argument names are accepted by the tools themselves
const ALIASES = { video_job: 'upload_video' };
module.exports = { TOOLS, KIND_NOTES, COMMON_NOTE, RECON_NOTE, ALIASES };
