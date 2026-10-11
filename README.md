# unifi-agents

[![CI](https://github.com/bacnh85/unifi-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/bacnh85/unifi-agents/actions/workflows/ci.yml)

[UniFi Network](https://uni.fi) for AI agents: a **pi coding agent extension** (`pi-unifi`) and a **standard MCP server** (`mcp-unifi`) in one package, built on the official UniFi Network Integration API (key-based, UniFi OS 10.x).

Repo: `github.com/bacnh85/unifi-agents` · npm package: [`@bacnh85/pi-unifi`](https://www.npmjs.com/package/@bacnh85/pi-unifi)

## What you get

| Entry point | Use with | Transport |
|---|---|---|
| `pi-unifi` extension | [pi coding agent](https://github.com/earendil-works/pi) | in-process tools, deferred discovery |
| `mcp-unifi` binary | any MCP client: pi (`mcp.json`), Claude Desktop, Cursor, … | stdio |

Both entry points share one tool surface (25 tools; 13 read + 12 write) and one client:

- **Read**: `unifi_status`, `unifi_devices`, `unifi_device`, `unifi_device_stats`, `unifi_clients`, `unifi_client`, `unifi_networks`, `unifi_wifis`, `unifi_radius_profiles`, `unifi_vouchers`, `unifi_firewall_zones`, `unifi_firewall_policies`, `unifi_get` (generic read for any `/v1/...` path)
- **Write**: `unifi_device_action` (RESTART/LOCATE), `unifi_port_action` (e.g. PoE `POWER_CYCLE`), `unifi_client_action` (BLOCK/UNBLOCK), `unifi_create_voucher`, `unifi_network_create/update/delete`, `unifi_wifi_update`, `unifi_wifi_create_enterprise`, `unifi_wifi_delete`, `unifi_firewall_policy_create/update`

Nice touches: devices/clients resolve by **name or MAC**, not just id; the single site is auto-detected; list tools speak the controller's filter DSL (`filter=name.like('office*')`).

## Configuration

Environment variables (a 10-line parser also reads `.env.local` / `.env` from the working directory — no dotenv dependency):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `UOS_API_KEY` | yes | — | Integration API key — *UniFi Network → Settings → Integrations → API Keys* |
| `UOS_BASE_URL` | yes | — | UniFi OS host, e.g. `https://172.30.55.28:11443` |
| `UOS_API_PATH` | no | `/proxy/network/integration` | Path prefix before `/v1`. UniFi OS consoles (UDM/UNVR/UOS Server) keep the default; standalone Network installs set `/integration` |
| `UOS_SITE_ID` | no | auto | Pin a site; otherwise the single site is auto-detected |
| `UOS_READ_ONLY` | no | `false` | `true` registers read tools only (both entry points) |
| `UOS_TLS_STRICT` | no | `false` | `true` enforces TLS validation (self-signed certs are tolerated by default) |

See `.env.example`. A locally-created key does **not** work against `api.ui.com` cloud URLs — for remote-hosted deployments create a UI cloud API key (account.ui.com) and set `UOS_BASE_URL=https://api.ui.com/v1/connector/consoles/<consoleId>`, `UOS_API_PATH=/proxy/network/integration`.

## Use with pi (extension)

```bash
# from npm
pi install npm:@bacnh85/pi-unifi
# local checkout
pi install /Volumes/Dev/homelab/unifi-mcp
```

Tools are registered with **`exposure: "deferred"`** — they cost zero prompt tokens and are *not* declared to the model upfront. When a task touches the network, the model finds them via `tool_search` and activates what it needs. Just ask: *"what's on my unifi network?"*

`/unifi` prints instant status (version, site, device/client counts).

If a session runs without `tool_search` (e.g. `--tools` overrides), add `"defaultTools": ["+tool_search"]` to pi settings so deferred tools stay reachable.

## Use with any MCP client

```bash
# pi (stdio)
pi mcp add unifi --env UOS_API_KEY=... --env UOS_BASE_URL=https://172.30.55.28:11443 -- node /path/to/this/repo/dist/mcp-server.js

# any directory — npx downloads the package and runs the bundled binary
pi mcp add unifi --env UOS_API_KEY=... --env UOS_BASE_URL=https://172.30.55.28:11443 -- npx -y @bacnh85/pi-unifi
```

Claude Desktop / Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "unifi": {
      "command": "npx",
      "args": ["-y", "@bacnh85/pi-unifi"],
      "env": {
        "UOS_API_KEY": "...",
        "UOS_BASE_URL": "https://172.30.55.28:11443"
      }
    }
  }
}
```

Prefer read-only through MCP? Add `"UOS_READ_ONLY": "true"` to `env`.

## Filter DSL (list tools)

The controller's filter syntax passes through untouched: `filter=name.eq('web-server')`, `and(enabled.eq(true), name.isNotNull())`, `not(name.like('guest*'))`, `type.in('uap','usw')`. Wildcards use `*`. Timestamps are ISO-8601.

## Development

```bash
npm install        # deps: @modelcontextprotocol/sdk (v1), zod, undici
npm run build      # tsc → dist/ (+ pi extension copied next to it)
npm run smoke      # unit + live-controller assertions (total printed by the script)
npm start          # run the MCP server over stdio
```

CI (`.github/workflows/ci.yml`): every push/PR runs build + smoke (unit checks; live-controller checks self-skip on GitHub-hosted runners — your controller is on a private LAN, unreachable from Actions). Pushes to `main` additionally publish to npm as `@bacnh85/pi-unifi` using the `NPM_TOKEN` secret. To run live-controller checks in CI, use a self-hosted runner on the same network and set the `UOS_API_KEY`/`UOS_BASE_URL` secrets.

Verify in pi without installing: `pi -e /Volumes/Dev/homelab/unifi-mcp/src/extension.ts`

## Notes

- UniFi Network API endpoints are called verbatim (`/v1/...`) behind the configured prefix — verified against UniFi Network 10.6.106 on UniFi OS Server.
- Write tools are annotated `destructiveHint` where they delete or disrupt; a controller-side read-only API key is the strongest guardrail (`UOS_READ_ONLY=true` additionally hides them from the tool list).

## 802.1X (WPA2-Enterprise WiFi) on Network 10.6.106

Verified live against UniFi OS Server + Network 10.6.106:

- `unifi_radius_profiles` lists RADIUS profiles (`id`, `name`, `metadata`). **The API is read-only here**: `POST /v1/sites/{siteId}/radius/profiles` returns `405` — create/delete RADIUS profiles (RADIUS servers, auth servers, VLANs) in the UniFi UI.
- `unifi_wifi_create_enterprise` creates a WPA2-Enterprise SSID via `POST /v1/sites/{siteId}/wifi/broadcasts`. Shape quirks baked into the tool: `securityConfiguration` requires `fastRoamingEnabled` explicitly; `nasId` may be `{"type":"DERIVED","source":"DEVICE_NAME"}` — **`DEVICE_NAME` is the only valid `source`** (`SSID_NAME`/`MAC_ADDRESS`/`SSID` all fail with "Type mismatch"); the alternative is `{"type":"USER_DEFINED","value":"<ssid>"}`.
- Wired 802.1X is **not reachable via the Integration API on 10.6.106**: every switch port-profile endpoint tried returns 404 (`/v1/sites/{id}/port-profiles`, `/v1/sites/{id}/switch/profiles`, `/v1/sites/{id}/switch-port-profiles`, `/v1/port-profiles`, `/v1/sites/{id}/port/profiles`, plus a 20-spelling sweep incl. `portconf`, `port-profile-groups`, `port-configs`, `network-profiles`, `/devices/port-profiles` — all 404/400, verified 2025-05 against a known-good control endpoint; and `/v1/sites/{id}/devices/{id}/interfaces/ports/{n}` GET/PATCH). Device `interfaces.ports` is read-only state. **Create wired port profiles in the UniFi UI.**
