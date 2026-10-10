// ponytail: 10-line dotenv subset — only what .env.local needs (KEY=VALUE lines, # comments).
const ENV_FILES = [".env.local", ".env"];

export function loadEnvFiles(cwd: string = process.cwd()): void {
  for (const name of ENV_FILES) {
    let raw: string;
    try {
      raw = readFileSync(join(cwd, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface UnifiConfig {
  /** API key (X-API-Key header) */
  apiKey: string;
  /** Base URL, e.g. https://172.30.55.28:11443 or a cloud connector URL */
  baseUrl: string;
  /** Path prefix BEFORE /v1 — default /proxy/network/integration (UniFi OS consoles) */
  apiPrefix: string;
  /** Optional pinned site id */
  siteId?: string;
  /** Register read tools only */
  readOnly: boolean;
  /** Enforce TLS certificate validation */
  tlsStrict: boolean;
}

export function loadConfig(cwd: string = process.cwd()): UnifiConfig {
  loadEnvFiles(cwd);
  const apiKey = process.env.UOS_API_KEY;
  const baseUrl = process.env.UOS_BASE_URL;
  if (!apiKey) {
    throw new Error(
      "Missing UOS_API_KEY. Create one in UniFi Network → Settings → Integrations → API Keys, then set it in .env.local (UOS_API_KEY=...).",
    );
  }
  if (!baseUrl) {
    throw new Error(
      "Missing UOS_BASE_URL. Set it to your UniFi OS host, e.g. UOS_BASE_URL=https://192.168.1.1:443 in .env.local.",
    );
  }
  // ponytail: no fingerprint pinning — set UOS_TLS_STRICT=true if the cert is trusted CA.
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiPrefix: normalizePrefix(process.env.UOS_API_PATH ?? "/proxy/network/integration"),
    siteId: process.env.UOS_SITE_ID || undefined,
    readOnly: bool(process.env.UOS_READ_ONLY, false),
    tlsStrict: bool(process.env.UOS_TLS_STRICT, false),
  };
}

function normalizePrefix(prefix: string): string {
  let p = prefix.trim().replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  // A prefix that already ends in /v1 would double with tool paths (/v1/...) — drop it;
  // client.request() also collapses /v1/v1/ as a belt-and-suspenders guard.
  p = p.replace(/\/v1$/, "");
  return p;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
