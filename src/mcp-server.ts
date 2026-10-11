#!/usr/bin/env node
// mcp-unifi — stdio MCP server exposing the UniFi Network tools to any MCP client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { UniFiClient } from "./client.js";
import { buildTools } from "./tools.js";
import { jsonSchemaToRawShape } from "./mcp-schema.js";

async function main() {
  // Lazy: the controller is only touched on the first tool call, so tools/list
  // works even when the controller is momentarily unreachable.
  let clientPromise: Promise<UniFiClient> | undefined;
  const getClient = () => {
    clientPromise ??= (async () => new UniFiClient(loadConfig()))();
    return clientPromise;
  };
  const readOnly = loadConfig().readOnly;

  // Top-level MCP instructions: context every MCP client shows/uses alongside the tool list.
  const INSTRUCTIONS =
    "UniFi Network controller tools via the official Integration API (key-based, UniFi OS). " +
    "Orientation: call unifi_status first. Devices/clients resolve by id, MAC, IP (clients), or case-insensitive name — " +
    "exact-name misses retry with the MAC shown in the Candidates list, since UniFi suffixes duplicate client names with the MAC tail. " +
    "List tools accept the controller filter DSL, e.g. filter=name.eq('office-ap') or type.eq('uap'); wildcards use *. " +
    "Generic reads of any /v1/... endpoint go through unifi_get. " +
    "Write tools are rejected by the controller when the API key is read-only; UOS_READ_ONLY=true also hides them from this list.";

  const server = new McpServer(
    { name: "unifi", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of buildTools(getClient, readOnly)) {
    server.registerTool(
      tool.name,
      {
        title: tool.label,
        description: tool.description,
        inputSchema: jsonSchemaToRawShape(tool.params),
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          const result = await tool.execute((args ?? {}) as Record<string, unknown>);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (err) {
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
  console.error(`mcp-unifi ready — ${readOnly ? "read-only" : "read-write"} tools from UniFi Network API`);
}

main().catch((err) => {
  console.error("mcp-unifi failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
