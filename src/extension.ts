// pi-unifi — pi coding agent extension. Registers the UniFi tools with
// exposure: "deferred" so they cost zero prompt tokens until tool_search
// discovers them for a UniFi-related task.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { UniFiClient } from "./client.js";
import { buildTools } from "./tools.js";

const NAMESPACE = {
  name: "unifi",
    description:
      "UniFi Network controller via the official Integration API: devices (incl. adoption), clients, wifi, networks, firewall zones/policies, ACL rules, DNS policies, traffic matching lists, hotspot vouchers.",
  instructions:
    "Resolve devices/clients by name or MAC (unifi_device, unifi_client take flexible ids). " +
    "List tools accept the controller filter DSL, e.g. filter=name.eq('office-ap') or type.eq('uap'). " +
    "Call unifi_status first for orientation. Write tools are rejected by the controller if the API key is read-only.",
};

export default function unifiExtension(pi: ExtensionAPI): void {
  let clientPromise: Promise<UniFiClient> | undefined;
  // Lazy: no network I/O in the factory (pi may load extensions without a session).
  const getClient = () => {
    clientPromise ??= (async () => new UniFiClient(loadConfig()))();
    return clientPromise;
  };

  let readOnly = false;
  try {
    readOnly = loadConfig().readOnly;
  } catch {
    // Missing env: register read tools only — each call explains what to fix.
    readOnly = true;
  }

  for (const tool of buildTools(getClient, readOnly)) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.params as never, // JSON Schema object — TypeBox-compatible at runtime
      annotations: tool.annotations,
      exposure: "deferred",
      namespace: NAMESPACE,
      execute: async (_toolCallId, args) => {
        const result = await tool.execute((args ?? {}) as Record<string, unknown>);
        // ?? null: DELETE endpoints return 204/empty — JSON.stringify(undefined) is not a valid text content.
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: undefined };
      },
    });
  }

  pi.registerCommand("unifi", {
    description: "Show UniFi controller status (version, sites, device/client counts)",
    handler: async (_args, ctx) => {
      try {
        const client = await getClient();
        const [info, sites] = await Promise.all([
          client.request<{ applicationVersion?: string }>("GET", "/v1/info"),
          client.list<{ id: string; name: string }>("/v1/sites", { limit: 200 }),
        ]);
        const counts = await Promise.all(
          sites.data.map(async (site) => {
            const [devices, clients] = await Promise.all([
              client.list(`/v1/sites/${site.id}/devices`, { limit: 1 }),
              client.list(`/v1/sites/${site.id}/clients`, { limit: 1 }),
            ]);
            return `${site.name}: ${devices.totalCount} devices, ${clients.totalCount} clients`;
          }),
        );
        const mode = client.config.readOnly ? "read-only" : "read-write";
        ctx.ui.notify(`UniFi Network ${info.applicationVersion ?? "?"} (${mode}) — ${counts.join("; ")}`, "info");
      } catch (err) {
        ctx.ui.notify(`UniFi error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
