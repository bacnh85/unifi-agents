# unifi-agents

[![CI](https://github.com/bacnh85/unifi-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/bacnh85/unifi-agents/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@bacnh85/pi-unifi.svg)](https://www.npmjs.com/package/@bacnh85/pi-unifi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Let AI agents operate your [UniFi Network](https://uni.fi) controller — safely and conversationally. Ships two entry points in one package:

- a **[pi coding agent](https://github.com/earendil-works/pi) extension** (`pi-unifi`), and
- a **standard MCP server** (`mcp-unifi`) that works with any MCP client: Claude Desktop, Cursor, Claude Code, pi, …

Both use the **official UniFi Network Integration API** (key-based, UniFi OS 10.x) — no scraping, no legacy credentials.

- **25 tools** — 13 read, 12 write
- **Resolve by name** — `unifi_device device="office-ap"`, not just UUIDs; MAC and IP work too
- **Controller filter DSL** — `filter=name.like('office*')` on every list tool
- **Read-only mode** — hide all write tools with one environment variable
- **Zero-config site** — single-site controllers are auto-detected

## Requirements

| Requirement | Notes |
|---|---|
| UniFi controller | UniFi OS (UDM/UDR/UNVR/UCG/Cloud Gateway or UniFi OS Server) with **Network application 10.x**; Integration API available since 10.6 |
| API key | Create in the controller UI: **Settings → Integrations → API Keys** (10.7+) or **Settings → Control Plane → Integrations**. Use a **read-only key** unless you intend to allow changes |
| Network access | The client machine must reach the controller (LAN/VPN). A locally-created key does **not** work against `api.ui.com` cloud URLs — see [Cloud/remote consoles](#cloudremote-consoles) |
| Node.js | ≥ 20 (for the MCP server / npx usage) |
| [pi](https://github.com/earendil-works/pi) | Only for the extension entry point |

## Quick start

### MCP clients (Claude Desktop, Cursor, Claude Code, pi, …)

**Claude Desktop / Cursor** — add to the MCP config (`claude_desktop_config.json` / `mcp.json`):

```json
{
  "mcpServers": {
    "unifi": {
      "command": "npx",
      "args": ["-y", "@bacnh85/pi-unifi"],
      "env": {
        "UOS_API_KEY": "your-integration-api-key",
        "UOS_BASE_URL": "https://192.168.1.1"
      }
    }
  }
}
```

Self-signed certificates are tolerated by default (controllers ship them). To enforce validation set `"UOS_TLS_STRICT": "true"`.

**pi (any directory)**:

```bash
pi mcp add unifi \
  --env UOS_API_KEY=your-integration-api-key \
  --env UOS_BASE_URL=https://192.168.1.1 \
  -- npx -y @bacnh85/pi-unifi
```

**Claude Code**:

```bash
claude mcp add unifi \
  --env UOS_API_KEY=your-integration-api-key \
  --env UOS_BASE_URL=https://192.168.1.1 \
  -- npx -y @bacnh85/pi-unifi
```

### pi extension (in-process, zero prompt tokens)

```bash
pi install npm:@bacnh85/pi-unifi
```

Then just ask: *"what's on my unifi network?"* — tools are discovered on demand via `tool_search` (deferred exposure), so they cost no prompt tokens until needed. `/unifi` prints instant status. If a session runs without `tool_search` (e.g. `--tools` overrides), add `"defaultTools": ["+tool_search"]` to pi settings.

### Run the server directly

```bash
# one-off, no install
UOS_API_KEY=... UOS_BASE_URL=https://192.168.1.1 npx -y @bacnh85/pi-unifi

# or install it
npm install -g @bacnh85/pi-unifi
mcp-unifi   # serves MCP over stdio
```

## Configuration

All variables are optional except the first two. A small built-in parser also reads `.env.local` / `.env` from the working directory (no dotenv dependency) — see `.env.example`.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `UOS_API_KEY` | yes | — | Integration API key |
| `UOS_BASE_URL` | yes | — | UniFi OS host, e.g. `https://192.168.1.1` (port included if non-standard) |
| `UOS_API_PATH` | no | `/proxy/network/integration` | Path prefix before `/v1`. UniFi OS consoles keep the default; standalone Network installs set `/integration` |
| `UOS_SITE_ID` | no | auto | Pin a site; otherwise the single site is auto-detected (multi-site requires this) |
| `UOS_READ_ONLY` | no | `false` | `true` registers read tools only — write tools disappear from the tool list entirely |
| `UOS_TLS_STRICT` | no | `false` | `true` enforces TLS certificate validation |

### Cloud / remote consoles

A locally-created Integration API key does **not** work against `api.ui.com` cloud URLs. For remote-hosted deployments create a UI cloud API key (account.ui.com) and set:

```
UOS_BASE_URL=https://api.ui.com/v1/connector/consoles/<consoleId>
UOS_API_PATH=/proxy/network/integration
```

## Tools

| Tool | Type | What it does |
|---|---|---|
| `unifi_status` | read | Application version, sites; validates API key + connectivity |
| `unifi_devices` | read | List devices (gateways, switches, APs); supports the filter DSL |
| `unifi_device` | read | One device by id / MAC / name |
| `unifi_device_stats` | read | Live stats: CPU, memory, load, throughput, per-port/radio |
| `unifi_clients` | read | Connected clients (wired, wireless, VPN, guest) |
| `unifi_client` | read | One client by id / MAC / IP / name |
| `unifi_networks` | read | Networks/VLANs |
| `unifi_wifis` | read | WiFi broadcasts (SSIDs) + security configuration |
| `unifi_radius_profiles` | read | RADIUS profiles (read-only; manage profiles in the UniFi UI) |
| `unifi_vouchers` | read | Hotspot vouchers |
| `unifi_firewall_zones` | read | Zone-based firewall zones |
| `unifi_firewall_policies` | read | Zone-based firewall policies |
| `unifi_get` | read | Generic GET for any `/v1/...` endpoint without a dedicated tool |
| `unifi_device_action` | write | RESTART (reboot) / LOCATE (blink LED) |
| `unifi_port_action` | write | Switch-port actions, e.g. PoE `POWER_CYCLE` |
| `unifi_client_action` | write | BLOCK / UNBLOCK a client |
| `unifi_create_voucher` | write | Create hotspot vouchers |
| `unifi_network_create` / `unifi_network_update` / `unifi_network_delete` | write | Manage networks/VLANs |
| `unifi_wifi_update` / `unifi_wifi_delete` | write | Update or remove SSIDs |
| `unifi_wifi_create_enterprise` | write | Create a WPA2-Enterprise (802.1X) SSID |
| `unifi_firewall_policy_create` / `unifi_firewall_policy_update` | write | Manage zone-based firewall policies |

All list tools accept the controller's filter syntax, passed through verbatim: `filter=name.eq('web-server')`, `and(enabled.eq(true), name.isNotNull())`, `not(name.like('guest*'))`, `type.in('uap','usw')`. Wildcards use `*`; timestamps are ISO-8601.

## Example prompts

- *"What's on my UniFi network?"* → version, sites, devices, clients
- *"Which access points have clients on the guest SSID?"*
- *"Show CPU and memory for the USW switch"* → `unifi_device_stats`
- *"Reboot the UAP in the office"* → `unifi_device_action RESTART`
- *"Cut network access for the device with MAC aa:bb:cc:dd:ee:ff"* → `unifi_client_action BLOCK`
- *"Create a voucher: 8 hours, 10 uses, named 'guests-weekend'"*
- *"Add a VLAN 30 'iot' network and put the 'Cameras' SSID on it"*

## Security

- **Use a read-only API key** (created the same way; the UI offers the choice) — the controller rejects writes regardless of tool availability.
- `UOS_READ_ONLY=true` additionally hides every write tool from the tool list, so the model never sees them.
- Destructive tools are annotated with MCP `destructiveHint`, which most clients surface as confirmation prompts.
- API keys stay in your client's config (or `.env.local`) and are only sent to your controller. The server talks to nothing else.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Missing UOS_API_KEY` on startup | Env var not set — check the `env` block in your client config; remember some clients need a restart after editing it |
| `UniFi API 401` | Key revoked or wrong — recreate in Settings → Integrations |
| `UniFi API 404` on every call | Wrong `UOS_API_PATH`: standalone Network installs need `/integration`, UniFi OS keeps the default |
| Connection refused / timeout | The client machine can't reach the controller — VPN or LAN required; `npx` runs on your machine, not in the cloud |
| `Multiple sites found` | Set `UOS_SITE_ID` (get ids from `unifi_status`) |
| TLS errors with `UOS_TLS_STRICT=true` | Controller uses a self-signed cert — leave strict mode off, or install a trusted cert |
| Tools visible but calls fail with 400 `Zone Based Firewall is not configured` | ZBF isn't enabled on the controller; firewall tools need it |

## Development

```bash
git clone ssh://git@github.com/bacnh85/unifi-agents.git
cd unifi-agents
npm install
npm run build      # tsc → dist/ (+ pi extension copied next to it)
npm run smoke      # unit + live-controller assertions (live part needs UOS_* env or .env.local)
npm start          # run the MCP server over stdio
```

Verify in pi without installing: `pi -e ./src/extension.ts`

### CI & releases

Every push/PR runs build + smoke (unit checks; live-controller checks self-skip on GitHub-hosted runners — a home controller is unreachable from Actions). Pushes to `main` publish to npm as [`@bacnh85/pi-unifi`](https://www.npmjs.com/package/@bacnh85/pi-unifi) automatically when the version isn't published yet, using the `NPM_TOKEN` secret. To release: bump `version` in `package.json`, push to `main`.

## Notes

- API endpoints are called verbatim (`/v1/...`) behind the configured prefix — verified against UniFi Network 10.6.106 on UniFi OS Server.
- RADIUS profiles and wired 802.1X port profiles are **read-only via the Integration API** on 10.6.x (create them in the UniFi UI); `unifi_wifi_create_enterprise` covers WPA2-Enterprise SSIDs.

## License

[MIT](LICENSE)
