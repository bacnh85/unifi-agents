// Single source of truth for the tool surface, shared by the pi extension and the
// MCP server. Plain JSON Schema params (TypeBox-compatible at runtime for pi).
import type { UniFiClient } from "./client.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string; properties?: Record<string, JsonSchemaProperty>; required?: string[] };
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  default?: unknown;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface UnifiTool {
  name: string;
  label: string;
  description: string;
  params: JsonSchema;
  annotations: ToolAnnotations;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

type Ctx = () => Promise<UniFiClient>;

// ponytail: unifi_get covers the read side of endpoints without a typed tool yet
// (ACL rules, DNS policies, firewall zones CRUD, switching, DPI, adopt/unadopt,
// wifi/voucher delete). Add typed tools when someone actually needs them.
// readOnly=true registers only read tools — callers pass the config flag explicitly.
export function buildTools(getClient: Ctx, readOnly = false): UnifiTool[] {
  const client = async () => await getClient();

  const list = async (
    args: Record<string, unknown>,
    path: (siteId: string) => string,
  ) => {
    const c = await client();
    const siteId = await c.resolveSiteId(str(args.siteId));
    return c.list(path(siteId), {
      limit: num(args.limit) ?? undefined,
      offset: num(args.offset) ?? undefined,
      filter: str(args.filter) ?? undefined,
    });
  };

  const siteAction = async (args: Record<string, unknown>, fn: (c: UniFiClient, siteId: string) => Promise<unknown>) => {
    const c = await client();
    const siteId = await c.resolveSiteId(str(args.siteId));
    return fn(c, siteId);
  };

  /** Shared wifi lookup: id or case-insensitive name → broadcast object. Throws with candidates. */
  const resolveWifi = async (siteId: string, key: unknown) => {
    const c = await client();
    const broadcasts = await c.list<{ id: string; name?: string }>(`/v1/sites/${siteId}/wifi/broadcasts`, { limit: 200 });
    const match = broadcasts.data.find(
      (b) => b.id === key || String(b.name ?? "").toLowerCase() === String(key).toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `No WiFi broadcast matches "${String(key)}". Known: ${broadcasts.data.map((b) => b.name ?? b.id).join(", ")}`,
      );
    }
    return match;
  };

  const tools: UnifiTool[] = [
    {
      name: "unifi_status",
      label: "UniFi status",
      description:
        "Get UniFi Network application version and all sites (names + ids). Call this first for orientation; it also validates API key and connectivity.",
      params: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: async () => {
        const c = await client();
        const [info, sites] = await Promise.all([
          c.request<{ applicationVersion?: string }>("GET", "/v1/info"),
          c.list<{ id: string; name: string; internalReference?: string }>("/v1/sites", { limit: 200 }),
        ]);
        return { applicationVersion: info.applicationVersion, sites: sites.data };
      },
    },
    {
      name: "unifi_devices",
      label: "UniFi devices",
      description:
        "List adopted UniFi devices (gateways, switches, access points) for a site: id, mac, model, name, state, type. Supports API filter syntax (e.g. filter=type.eq('uap')).",
      params: {
        type: "object",
        properties: {
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter, e.g. type.eq('uap') or and(state.eq('ACTIVE'),name.like('office*'))" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) => list(args, (s) => `/v1/sites/${s}/devices`),
    },
    {
      name: "unifi_device",
      label: "UniFi device detail",
      description:
        "Get full details for one adopted device. The device can be given as id, MAC address, or (case-insensitive) name.",
      params: {
        type: "object",
        properties: {
          device: { type: "string", description: "Device id, MAC, or name" },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
        },
        required: ["device"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) =>
        siteAction(args, async (c, siteId) => c.resolveDevice(siteId, str(args.device) ?? "")),
    },
    {
      name: "unifi_device_stats",
      label: "UniFi device stats",
      description:
        "Get the latest statistics snapshot for an adopted device (CPU, memory, throughput, per-port/port-radio stats where reported). Device given as id, MAC, or name.",
      params: {
        type: "object",
        properties: {
          device: { type: "string", description: "Device id, MAC, or name" },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
        },
        required: ["device"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) =>
        siteAction(args, async (c, siteId) => {
          const device = await c.resolveDevice(siteId, str(args.device) ?? "");
          return c.request("GET", `/v1/sites/${siteId}/devices/${device.id}/statistics/latest`);
        }),
    },
    {
      name: "unifi_clients",
      label: "UniFi clients",
      description:
        "List currently connected clients (wired, wireless, VPN, guest) for a site. Supports API filter syntax (e.g. filter=name.like('phone*')).",
      params: {
        type: "object",
        properties: {
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter, e.g. name.like('phone*')" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) => list(args, (s) => `/v1/sites/${s}/clients`),
    },
    {
      name: "unifi_client",
      label: "UniFi client detail",
      description:
        "Get full details for one connected client. The client can be given as id, MAC, IP address, or (case-insensitive) name.",
      params: {
        type: "object",
        properties: {
          client: { type: "string", description: "Client id, MAC, IP, or name" },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
        },
        required: ["client"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) =>
        siteAction(args, async (c, siteId) => c.resolveClient(siteId, str(args.client) ?? "")),
    },
    {
      name: "unifi_networks",
      label: "UniFi networks",
      description:
        "List networks (VLANs / network definitions) for a site, or get full details of one network by id.",
      params: {
        type: "object",
        properties: {
          networkId: { type: "string", description: "Return full details for this network id instead of listing." },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter, e.g. name.like('iot*')" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) =>
        siteAction(args, async (c, siteId) =>
          args.networkId
            ? c.request("GET", `/v1/sites/${siteId}/networks/${args.networkId}`)
            : c.list(`/v1/sites/${siteId}/networks`, {
                limit: num(args.limit) ?? undefined,
                offset: num(args.offset) ?? undefined,
                filter: str(args.filter) ?? undefined,
              }),
        ),
    },
    {
      name: "unifi_wifis",
      label: "UniFi WiFi networks",
      description:
        "List WiFi broadcasts (SSIDs) for a site, or get full details of one by id. Covers name, ssid, security mode, enabled state, VLAN.",
      params: {
        type: "object",
        properties: {
          wifiBroadcastId: { type: "string", description: "Return full details for this WiFi broadcast id instead of listing." },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) =>
        siteAction(args, async (c, siteId) =>
          args.wifiBroadcastId
            ? c.request("GET", `/v1/sites/${siteId}/wifi/broadcasts/${args.wifiBroadcastId}`)
            : c.list(`/v1/sites/${siteId}/wifi/broadcasts`, {
                limit: num(args.limit) ?? undefined,
                offset: num(args.offset) ?? undefined,
                filter: str(args.filter) ?? undefined,
              }),
        ),
    },
    {
      name: "unifi_vouchers",
      label: "UniFi hotspot vouchers",
      description: "List hotspot guest vouchers for a site, or get one by id.",
      params: {
        type: "object",
        properties: {
          voucherId: { type: "string", description: "Return full details for this voucher id instead of listing." },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) =>
        siteAction(args, async (c, siteId) =>
          args.voucherId
            ? c.request("GET", `/v1/sites/${siteId}/hotspot/vouchers/${args.voucherId}`)
            : c.list(`/v1/sites/${siteId}/hotspot/vouchers`, {
                limit: num(args.limit) ?? undefined,
                offset: num(args.offset) ?? undefined,
                filter: str(args.filter) ?? undefined,
              }),
        ),
    },
    {
      name: "unifi_firewall_zones",
      label: "UniFi firewall zones",
      description:
        "List firewall zones (internal/external/VPN/gateway/custom) for a site. Zone ids are needed for firewall policy source/destination.",
      params: {
        type: "object",
        properties: {
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) => list(args, (s) => `/v1/sites/${s}/firewall/zones`),
    },
    {
      name: "unifi_firewall_policies",
      label: "UniFi firewall policies",
      description:
        "List zone-based firewall policies for a site, or get full details of one policy by id (source/destination zones, filters, action, schedule).",
      params: {
        type: "object",
        properties: {
          firewallPolicyId: { type: "string", description: "Return full details for this policy id instead of listing." },
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter, e.g. enabled.eq(true)" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) => list(args, (s) => `/v1/sites/${s}/firewall/policies`),
    },
    {
      name: "unifi_radius_profiles",
      label: "UniFi RADIUS profiles",
      description:
        "List RADIUS profiles (id, name, metadata) for a site — the profileId that WPA2-Enterprise WiFi needs. List-only on Network 10.6.106: the API cannot create or delete profiles (POST returns 405), manage profiles in the UniFi UI.",
      params: {
        type: "object",
        properties: {
          siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          filter: { type: "string", description: "API filter, e.g. name.eq('radius-peap')" },
          limit: { type: "integer", description: "Page size, 1-200 (default 100)" },
          offset: { type: "integer", description: "Pagination offset" },
        },
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: (args) => list(args, (s) => `/v1/sites/${s}/radius/profiles`),
    },
    {
      name: "unifi_get",
      label: "UniFi raw GET",
      description:
        "Generic read-only GET against any UniFi Network Integration API /v1/... path. Use for endpoints without a dedicated tool: switching (stacks, LAGs, MC-LAG), DNS policies, traffic-matching-lists, wans, vpn tunnels/servers, radius profiles, device-tags, dpi categories/applications, countries. Path must start with /v1/; site-scoped paths need the real siteId.",
      params: {
        type: "object",
        properties: {
          path: { type: "string", description: "API path starting with /v1/, e.g. /v1/countries" },
          query: {
            type: "object",
            description: "Optional query parameters, e.g. {\"limit\": 5, \"filter\": \"name.like('x*')\"}",
            additionalProperties: true,
          },
        },
        required: ["path"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      execute: async (args) => {
        const c = await client();
        const query: Record<string, string | number | undefined> = {};
        for (const [k, v] of Object.entries((args.query ?? {}) as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number") query[k] = v;
        }
        return c.request("GET", str(args.path) ?? "", { query });
      },
    },
  ];

  if (!readOnly) {
    tools.push(
      {
        name: "unifi_device_action",
        label: "UniFi device action",
        description:
          "Execute an action on an adopted device: RESTART (reboot), LOCATE (blink LED). The device can be given as id, MAC, or name. Unsupported actions are rejected by the controller with the list of valid values.",
        params: {
          type: "object",
          properties: {
            device: { type: "string", description: "Device id, MAC, or name" },
            action: { type: "string", description: "e.g. RESTART, LOCATE" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["device", "action"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
            const device = await c.resolveDevice(siteId, str(args.device) ?? "");
            return c.request("POST", `/v1/sites/${siteId}/devices/${device.id}/actions`, {
              body: { action: str(args.action) },
            });
          }),
      },
      {
        name: "unifi_port_action",
        label: "UniFi switch port action",
        description:
          "Execute an action on one switch port of an adopted device, e.g. POWER_CYCLE (briefly cut PoE power — useful to reboot a PoE device). Device given as id, MAC, or name; portIdx is the physical port number.",
        params: {
          type: "object",
          properties: {
            device: { type: "string", description: "Device id, MAC, or name" },
            portIdx: { type: "integer", description: "Physical port number" },
            action: { type: "string", description: "e.g. POWER_CYCLE" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["device", "portIdx", "action"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
            const device = await c.resolveDevice(siteId, str(args.device) ?? "");
            return c.request(
              "POST",
              `/v1/sites/${siteId}/devices/${device.id}/interfaces/ports/${num(args.portIdx)}/actions`,
              { body: { action: str(args.action) } },
            );
          }),
      },
      {
        name: "unifi_client_action",
        label: "UniFi client action",
        description:
          "Execute an action on a connected client: BLOCK / UNBLOCK (client is identified by id, MAC, IP, or name; BLOCK severs connectivity). Unsupported actions are rejected by the controller with valid values.",
        params: {
          type: "object",
          properties: {
            client: { type: "string", description: "Client id, MAC, IP, or name" },
            action: { type: "string", description: "e.g. BLOCK, UNBLOCK" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["client", "action"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
            const client = await c.resolveClient(siteId, str(args.client) ?? "");
            return c.request("POST", `/v1/sites/${siteId}/clients/${client.id}/actions`, {
              body: { action: str(args.action) },
            });
          }),
      },
      {
        name: "unifi_create_voucher",
        label: "UniFi create hotspot vouchers",
        description: "Generate one or more hotspot guest vouchers.",
        params: {
          type: "object",
          properties: {
            count: { type: "integer", description: "Number of vouchers (default 1)" },
            durationMinutes: { type: "integer", description: "Validity per voucher in minutes" },
            expiresAt: { type: "string", description: "Optional ISO-8601 expiry, e.g. 2026-12-31T23:59:00Z" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["durationMinutes"],
        },
        annotations: {},
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
            const body: Record<string, unknown> = {
              count: num(args.count) ?? 1,
              durationMinutes: num(args.durationMinutes),
            };
            if (args.expiresAt) body.expiresAt = str(args.expiresAt);
            return c.request("POST", `/v1/sites/${siteId}/hotspot/vouchers`, { body });
          }),
      },
      {
        name: "unifi_network_create",
        label: "UniFi create network",
        description:
          "Create a network (VLAN). Minimal body: name + type (e.g. VLAN_ONLY); add vlanId and other fields as needed. Unknown fields are rejected by the controller with a clear message.",
        params: {
          type: "object",
          properties: {
            body: {
              type: "object",
              description: 'Network body, e.g. {"name":"IoT","type":"VLAN_ONLY","vlanId":20,"purpose":"CORPORATE"}',
              additionalProperties: true,
            },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["body"],
        },
        annotations: {},
        execute: (args) =>
          siteAction(args, (c, siteId) =>
            c.request("POST", `/v1/sites/${siteId}/networks`, { body: args.body }),
          ),
      },
      {
        name: "unifi_network_update",
        label: "UniFi update network",
        description:
          "Update an existing network. Fetch the network first (unifi_networks networkId=...), modify the returned object, and pass the full body — this endpoint replaces the configuration.",
        params: {
          type: "object",
          properties: {
            networkId: { type: "string", description: "Network id to update" },
            body: { type: "object", description: "Full network configuration object" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["networkId", "body"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, (c, siteId) =>
            c.request("PUT", `/v1/sites/${siteId}/networks/${args.networkId}`, { body: args.body }),
          ),
      },
      {
        name: "unifi_network_delete",
        label: "UniFi delete network",
        description: "Delete a network (VLAN) from a site. This is irreversible — check references first if unsure.",
        params: {
          type: "object",
          properties: {
            networkId: { type: "string", description: "Network id to delete" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["networkId"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, (c, siteId) => c.request("DELETE", `/v1/sites/${siteId}/networks/${args.networkId}`)),
      },
      {
        name: "unifi_wifi_update",
        label: "UniFi update WiFi",
        description:
          "Update a WiFi broadcast (SSID): toggle enabled, change passphrase, security mode, etc. The WiFi can be given as id or name. Fetch first via unifi_wifis and pass the modified object — this endpoint replaces the configuration.",
        params: {
          type: "object",
          properties: {
            wifi: { type: "string", description: "WiFi broadcast id or name" },
            body: { type: "object", description: "Full WiFi broadcast configuration object" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["wifi", "body"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
          const match = await resolveWifi(siteId, args.wifi);
          return c.request("PUT", `/v1/sites/${siteId}/wifi/broadcasts/${match.id}`, { body: args.body });
          }),
      },
      {
        name: "unifi_wifi_create_enterprise",
        label: "UniFi create WPA2-Enterprise WiFi",
        description:
          "Create a WiFi broadcast (SSID) with WPA2-Enterprise (802.1X) security — the shape verified on Network 10.6.106. " +
          "Get profileId from unifi_radius_profiles. nasId defaults to DERIVED from the AP device name (valid sources: DEVICE_NAME only — " +
          "SSID_NAME/MAC_ADDRESS/SSID are rejected with 'Type mismatch'); pass nasIdValue for the more common USER_DEFINED form " +
          "(per-AP RADIUS attributes: USER_DEFINED works, DERIVED DEVICE_NAME is rejected). " +
          "Note WPA2-Enterprise requires fastRoamingEnabled explicitly. For WPA2-Personal or other security types use unifi_wifi_update instead.",
        params: {
          type: "object",
          properties: {
            name: { type: "string", description: "WiFi name AND broadcast SSID (they are set to the same value)" },
            radiusProfileId: { type: "string", description: "RADIUS profile id from unifi_radius_profiles (required unless body given)" },
            nasIdSource: { type: "string", enum: ["DEVICE_NAME"], description: "DERIVED nas-mac-address source; only DEVICE_NAME is accepted on 10.6.106" },
            nasIdValue: { type: "string", description: "USER_DEFINED NAS ID — recommended for per-AP RADIUS attributes; defaults to DERIVED/DEVICE_NAME when omitted" },
            frequenciesGHz: { type: "array", description: "Bands, e.g. [2, 5] (default [5])" },
            enabled: { type: "boolean", description: "Broadcast enabled on creation (default true)" },
            fastRoaming: { type: "boolean", description: "802.1X fast roaming (default false)" },
            coa: { type: "boolean", description: "RADIUS CoA (default false)" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
            body: { type: "object", description: "Advanced: full broadcast body overriding everything above" },
          },
          required: ["name"],
        },
        annotations: {},
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
            const name = str(args.name) ?? "";
            const base = {
              type: "STANDARD",
              name,
              enabled: args.enabled !== false,
              advertiseDeviceName: false,
              bssTransitionEnabled: true,
              multicastToUnicastConversionEnabled: false,
              hideName: false,
              arpProxyEnabled: true,
              uapsdEnabled: true,
              clientIsolationEnabled: false,
              network: { type: "NATIVE" },
              broadcastingFrequenciesGHz: Array.isArray(args.frequenciesGHz) ? args.frequenciesGHz : [5],
            };
            const nasId = str(args.nasIdValue)
              ? { type: "USER_DEFINED", value: str(args.nasIdValue) }
              : { type: "DERIVED", source: str(args.nasIdSource) ?? "DEVICE_NAME" };
            const body = {
              ...base,
              ...(args.body as Record<string, unknown> | undefined),
              securityConfiguration: {
                type: "WPA2_ENTERPRISE",
                fastRoamingEnabled: args.fastRoaming === true,
                coaEnabled: args.coa === true,
                radiusConfiguration: { profileId: str(args.radiusProfileId), nasId },
              },
            };
            return c.request("POST", `/v1/sites/${siteId}/wifi/broadcasts`, { body });
          }),
      },
      {
        name: "unifi_wifi_delete",
        label: "UniFi delete WiFi",
        description:
          "Delete a WiFi broadcast (SSID) by id or name. Irreversible — clients are disconnected. Verify the name with unifi_wifis first.",
        params: {
          type: "object",
          properties: {
            wifi: { type: "string", description: "WiFi broadcast id or name" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["wifi"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, async (c, siteId) => {
            const match = await resolveWifi(siteId, args.wifi);
            return c.request("DELETE", `/v1/sites/${siteId}/wifi/broadcasts/${match.id}`);
          }),
      },
      {
        name: "unifi_firewall_policy_create",
        label: "UniFi create firewall policy",
        description:
          "Create a zone-based firewall policy. Needs zone ids from unifi_firewall_zones. Minimal body: {enabled, name, action:{type}, source:{zoneId}, destination:{zoneId}, ipProtocolScope}. action.type: ALLOW | BLOCK | REJECT; ipProtocolScope: {ipVersion: IPV4 | IPV6 | IPV4_AND_IPV6}.",
        params: {
          type: "object",
          properties: {
            body: {
              type: "object",
              description:
                'Policy body, e.g. {"enabled":true,"name":"Block IoT to LAN","action":{"type":"BLOCK"},"source":{"zoneId":"<zoneId>"},"destination":{"zoneId":"<zoneId>"},"ipProtocolScope":{"ipVersion":"IPV4_AND_IPV6"},"loggingEnabled":false}',
              additionalProperties: true,
            },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["body"],
        },
        annotations: {},
        execute: (args) =>
          siteAction(args, (c, siteId) =>
            c.request("POST", `/v1/sites/${siteId}/firewall/policies`, { body: args.body }),
          ),
      },
      {
        name: "unifi_firewall_policy_update",
        label: "UniFi update firewall policy",
        description:
          "Partially update a firewall policy via PATCH (e.g. {\"enabled\": false} to disable). For full replacement use unifi_firewall_policy_create semantics — fetch current policy, modify, and send the complete body.",
        params: {
          type: "object",
          properties: {
            policyId: { type: "string", description: "Firewall policy id" },
            body: { type: "object", description: "Fields to update, e.g. {\"enabled\": false}" },
            siteId: { type: "string", description: "Site id. Optional when the controller has a single site." },
          },
          required: ["policyId", "body"],
        },
        annotations: { destructiveHint: true },
        execute: (args) =>
          siteAction(args, (c, siteId) =>
            c.request("PATCH", `/v1/sites/${siteId}/firewall/policies/${args.policyId}`, { body: args.body }),
          ),
      },
    );
  }

  return tools;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
