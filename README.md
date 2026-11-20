# splat-agent (Ink MCP server for the 3D bot)

An MCP server plus a small Node service that lets a Hermes agent (profile `splat`, MCP name `ink`) build
animated 3D Gaussian-splat dioramas with [Ink Studio](https://github.com/siliconjungle/shapeshift-labs-ink-studio),
check them, render them and hand back a viewer link, a preview video and a `.ply`. It can also rebuild a video
in 3D with VGGT-Omega on a LAN GPU box (via [dell-annotate-client](https://github.com/mohammedterryjack/dell-annotate-client)).

Tools are few, verb-first and strictly typed (Ink-style); reference text lives behind `catalog`, and every
result starts with the job id. Old tool names keep working as hidden aliases.

## Tools

`start_scene`, `cancel_scene`, `list_scenes`, `show_scene`, `catalog`, `add_solid`, `join`, `wrap`,
`edit_part`, `remove_part`, `move`, `spin`, `set_material`, `set_style`, `set_light`, `set_camera`,
`add_motion`, `remove_motion`, `validate`, `list_assets`, `render`, `turn`, `stats`, `upload_video`,
`reconstruct_3d`, `list_reconstructions`, `finish`.

`validate` and `finish` run build checks (floating solids, moving parts that clash, export round-trip,
differences from the previous version); warnings are listed for the user, never blocking.

## How it runs

- `mcp.js`: stateless stdio MCP server (newline-delimited JSON-RPC 2.0) started by Hermes. It forwards every
  call to the service over an owner-only unix socket.
- `service.js`: systemd **user** service (`systemd/splat-agent.service`). Holds the job, scene and engine
  (`engine.js` worker thread), and serves a keyless viewer (`/v/<token>/`) and key-protected files on the LAN.
- `cancel.js`: CLI to cancel the running scene.
- `mode.js`: one engine at a time with [articraft-agent](https://github.com/mohammedterryjack/articraft-agent):
  while an Articraft job runs, `start_scene` and scene edits answer "busy" (job id, ETA, how to check) and
  `reconstruct_3d` queues until it is free; nothing is dropped or cancelled.

Hermes profile `config.yaml`:

```yaml
mcp_servers:
  ink:
    command: /usr/bin/node
    args: [/home/<you>/Code/splat-agent/mcp.js]
    timeout: 900
```

```sh
systemctl --user enable --now splat-agent   # after copying systemd/splat-agent.service to ~/.config/systemd/user/
node --test test/*.test.js                  # unit tests
```

## Dependencies

- Node.js 20+ (no npm packages), ffmpeg.
- Ink Studio checked out locally (`INK_STUDIO`, default `~/scratch/shapeshift-labs-ink-studio`). It is not
  included here and has its own licence.
- `~/Code/dell-annotate-client` for `reconstruct_3d`.
- Kenney model kits for `list_assets` (see below).

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `SPLAT_DIR` | `~/splats` | job outputs |
| `SPLAT_SOCK` | `~/.hermes/splat-agent/worker.sock` | service socket |
| `SPLAT_BIND` / `SPLAT_PORT` | (required) / `8646` | viewer and file server |
| `SPLAT_ENV_FILE` | `~/.hermes/.env` | holds `SPLAT_AGENT_KEY` (bearer key for `/files`) |
| `DELL_ANNOTATE` | (required) | dell-annotate base URL for `reconstruct_3d` |
| `THREED_MODE_DIR` | `~/.hermes/3d-mode` | one-engine-at-a-time mode files shared with articraft-agent |
| `SPLAT_DELL_ENV` | `~/.hermes/profiles/splat/.env` | holds `DELL_LLM_API_KEY` for the GPU box |
| `SPLAT_VGGT_DIR` / `SPLAT_VISION_DIR` | `$SPLAT_DIR/vggt` / `~/vision` | reconstruction outputs |
| `SPLAT_ASSETS` | `./assets` | asset library |
| `INK_STUDIO` | `~/scratch/shapeshift-labs-ink-studio` | Ink Studio checkout |
| `SPLAT_CALL_TIMEOUT_MS` | | MCP call timeout |

Keys are read from those files at run time and are never in this repo. LAN addresses have no defaults: copy
`.env.example` to `.env` (the systemd unit loads it); the service fails loudly if one is missing.

## Assets (Kenney, CC0)

`assets/index.json` lists 469 low-poly models from Kenney's **Furniture Kit** and **Nature Kit**
(CC0, www.kenney.nl; licence files in `assets/kenney-*/License.txt`). The `.glb` files are not committed:
download both kits from kenney.nl and run

```sh
scripts/install-kenney-assets.sh kenney_furniture-kit.zip kenney_nature-kit.zip
```

## Credits

- [Ink Studio](https://github.com/siliconjungle/shapeshift-labs-ink-studio) (siliconjungle): the splat engine
  and tool-design style this follows. Used at run time, not vendored.
- Build checks follow the machine checks of [anymachine](https://github.com/apekshik/anymachine) (MIT),
  reimplemented for Ink scenes.
- Models: [Kenney](https://www.kenney.nl) (CC0).
