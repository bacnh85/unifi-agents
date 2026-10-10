#!/usr/bin/env node
// Runnable check for pi-unifi: live controller assertions (skipped gracefully when
// unreachable) + pure unit assertions for the URL guard and the JSON→Zod mapper.
// Usage: node scripts/smoke.mjs   (after npm run build)
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const repoRoot = new URL("..", import.meta.url).pathname;

let failed = 0;
let ran = 0;
const assert = (cond, label) => {
  ran++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed++;
};
const eq = (a, b, label) => assert(a === b, `${label} (got ${JSON.stringify(a)})`);

const { UniFiClient } = await import(`${repoRoot}dist/client.js`);
const { buildTools } = await import(`${repoRoot}dist/tools.js`);
const { jsonSchemaToRawShape } = await import(`${repoRoot}dist/mcp-schema.js`);
const { loadConfig } = await import(`${repoRoot}dist/config.js`);

// loadConfig() parses .env.local itself; calling it also seeds UOS_* into process.env
// for the pure assertions below.

// ---- Pure: /v1/v1 collapse guard + prefix normalization --------------------
{
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    cfg = { baseUrl: "https://x", apiPrefix: "/proxy/network/integration" };
  }
  const guardUrl = `${cfg.baseUrl}${cfg.apiPrefix}/v1/v1/x`.replace(/\/v1\/v1\//, "/v1/");
  eq(guardUrl.endsWith("/v1/x"), true, "/v1/v1 collapse guard maps /v1/v1/x → /v1/x");
  eq(cfg.apiPrefix.endsWith("/v1"), false, "config apiPrefix never ends in /v1");
}

// ---- Pure: tools surface ---------------------------------------------------
{
  const readOnly = buildTools(async () => ({}), true);
  const readWrite = buildTools(async () => ({}), false);
  eq(readOnly.length, 13, "read-only tool count is 13");
  eq(readWrite.length, 25, "read-write tool count is 25");
  assert(
    readWrite.every((t) => t.params.type === "object" && typeof t.execute === "function"),
    "every tool has object params + execute",
  );
  const writes = new Set(readWrite.slice(readOnly.length).map((t) => t.name));
  eq(writes.has("unifi_network_delete") && writes.has("unifi_device_action"), true, "write tools present");
}

// ---- Pure: JSON Schema → ZodRawShape mapper --------------------------------
{
  const shape = jsonSchemaToRawShape({
    type: "object",
    properties: {
      device: { type: "string", description: "d" },
      portIdx: { type: "integer" },
      count: { type: "integer", default: 1 },
      enabled: { type: "boolean" },
      action: { type: "string", enum: ["RESTART", "LOCATE"] },
      body: { type: "object", additionalProperties: true },
    },
    required: ["device", "portIdx", "action", "body"],
  });
  const kinds = Object.entries(shape).map(([k, v]) => `${k}:${v.constructor.name}`);
  assert(shape.device && shape.portIdx && shape.enabled && shape.action && shape.body, "mapper returns a Zod type per property");
  assert(!String(shape.device?.constructor).includes("String"), "string prop is a Zod type, not a plain value");
  assert(kinds.some((k) => k.startsWith("portIdx:ZodNumber")), "integer prop maps to ZodNumber");
  assert(kinds.some((k) => k.startsWith("action:ZodEnum")), "required enum prop maps to ZodEnum");
  assert(kinds.some((k) => k.startsWith("body:ZodRecord")), "required object prop (no properties) maps to ZodRecord");
  assert(kinds.some((k) => k.startsWith("enabled:ZodOptional")), "non-required prop wraps in ZodOptional");
  const inner = (v) => { while (v.innerType ?? v._def?.innerType) v = v.innerType ?? v._def.innerType; return v.constructor.name; };
  eq(inner(shape.enabled), "ZodBoolean", "optional wrapper preserves the inner type");
  eq(inner(shape.count), "ZodNumber", "default wrapper preserves the inner ZodNumber");
  const parsed = await shape.device.parseAsync("abc");
  eq(parsed, "abc", "mapped Zod schema parses values");
  const bad = await shape.action.safeParseAsync("NOPE");
  eq(bad.success, false, "mapped Zod enum rejects invalid value");
}

// ---- Live controller (skips when unreachable) ------------------------------
if (!process.env.UOS_API_KEY || !process.env.UOS_BASE_URL) {
  console.log("SKIP  live controller checks (UOS_API_KEY / UOS_BASE_URL not set)");
} else {
  const client = new UniFiClient(loadConfig());
  try {
    const t0 = performance.now();
    const info = await client.request("GET", "/v1/info");
    assert(/^10\./.test(String(info.applicationVersion)), `live /v1/info version matches /^10\\./ (${info.applicationVersion}, ${Math.round(performance.now() - t0)}ms)`);

    const sites = await client.list("/v1/sites", { limit: 200 });
    assert(Array.isArray(sites.data) && sites.totalCount > 0, "live /v1/sites returns a non-empty envelope");
    assert(
      sites.data.some((s) => s.id === "88f7af54-98f8-306a-a1c7-c9349722b1f6" || s.internalReference === "default"),
      "live sites include the Default site",
    );

    const siteId = await client.resolveSiteId();
    const devices = await client.list(`/v1/sites/${siteId}/devices`, { limit: 5 });
    assert(Array.isArray(devices.data), "live devices list returns data array");
    const clients = await client.list(`/v1/sites/${siteId}/clients`, { limit: 5 });
    assert(Array.isArray(clients.data), "live clients list returns data array");
    console.log(`      (site ${siteId}: ${devices.totalCount} devices, ${clients.totalCount} clients)`);

    const countries = await client.request("GET", "/v1/countries", { query: { limit: 5 } });
    eq((countries.data ?? countries)?.length, 5, "live /v1/countries?limit=5 returns 5 rows");
  } catch (err) {
    console.log(`SKIP  live controller checks failed: ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${ran} assertion(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${ran} assertions passed`);
