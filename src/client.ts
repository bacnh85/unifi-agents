import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import type { UnifiConfig } from "./config.js";

const V1_V1 = /\/v1\/v1\//;

export interface ListEnvelope<T = unknown> {
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
  data: T[];
}

export class UnifiApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class UniFiClient {
  private readonly dispatcher: Dispatcher;
  private siteIdCache?: string;

  constructor(public readonly config: UnifiConfig) {
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: config.tlsStrict },
    });
  }

  /** Perform an API call. `path` must start with /v1/ (verbatim from the API reference). */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    if (!path.startsWith("/v1/")) {
      throw new Error(`UniFi API paths must start with /v1/ — got "${path}"`);
    }
    let url = `${this.config.baseUrl}${this.config.apiPrefix}${path}`;
    // Guard: a prefix that already ends in /v1 would double up — collapse /v1/v1/ to /v1/.
    url = url.replace(V1_V1, "/v1/");
    const urlObj = new URL(url);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && `${value}` !== "") {
        urlObj.searchParams.set(key, String(value));
      }
    }

    let status: number;
    let text: string;
    try {
      const res = await undiciRequest(urlObj.toString(), {
        method,
        headers: {
          "X-API-Key": this.config.apiKey,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        dispatcher: this.dispatcher,
      });
      status = res.statusCode;
      text = await res.body.text();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "CERT_HAS_EXPIRED") {
        throw new UnifiApiError(0, `TLS certificate rejected by ${this.config.baseUrl} — set UOS_TLS_STRICT=false (default) or install a trusted cert. (${code})`);
      }
      if (code === "ECONNREFUSED") {
        throw new UnifiApiError(0, `Connection refused by ${this.config.baseUrl} — check the host/port and that the UniFi OS server is up.`);
      }
      if (code === "ENOTFOUND") {
        throw new UnifiApiError(0, `Cannot resolve ${this.config.baseUrl} — check UOS_BASE_URL.`);
      }
      throw err;
    }

    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body (HTML login page etc.)
    }

    if (status < 200 || status >= 300) {
      const apiMessage =
        (parsed as { message?: string } | undefined)?.message ??
        (typeof parsed === "string" && parsed ? `non-JSON response: ${parsed.slice(0, 120)}` : undefined) ??
        "no detail";
      const hint =
        status === 401
          ? " — check UOS_API_KEY (keys are created in UniFi Network → Settings → Integrations; a locally-created key does not work against api.ui.com cloud URLs)"
          : status === 403
            ? " — this API key lacks permission for that operation (read-only key?)"
            : status === 404
              ? " — check the path and UOS_API_PATH (UniFi OS consoles use /proxy/network/integration; standalone installs use /integration)"
              : "";
      throw new UnifiApiError(status, `UniFi API ${status} on ${method} ${urlObj.pathname}: ${apiMessage}${hint}`);
    }

    return parsed as T;
  }

  /** Paginated list call. Returns the API envelope subset so agents can page. */
  async list<T = unknown>(
    path: string,
    opts: { limit?: number; offset?: number; filter?: string } = {},
  ): Promise<ListEnvelope<T>> {
    const limit = clamp(opts.limit ?? 100, 1, 200);
    const res = await this.request<{ offset?: number; limit?: number; count?: number; totalCount?: number; data?: T[] }>(
      "GET",
      path,
      { query: { offset: opts.offset, limit, filter: opts.filter } },
    );
    return {
      offset: res.offset ?? opts.offset ?? 0,
      limit: res.limit ?? limit,
      count: res.count ?? (Array.isArray(res.data) ? res.data.length : 0),
      totalCount: res.totalCount ?? res.count ?? 0,
      data: Array.isArray(res.data) ? res.data : [],
    };
  }

  /** Resolve site id: explicit hint → configured UOS_SITE_ID → the only site (error when ambiguous). */
  async resolveSiteId(hint?: string): Promise<string> {
    if (hint) return hint;
    if (this.config.siteId) return this.config.siteId;
    if (this.siteIdCache) return this.siteIdCache;
    const sites = await this.list<{ id: string; name: string; internalReference?: string }>("/v1/sites", { limit: 200 });
    if (sites.data.length === 1) {
      this.siteIdCache = sites.data[0].id;
      return this.siteIdCache;
    }
    const names = sites.data.map((s) => `${s.name} (${s.internalReference ?? s.id})`).join(", ");
    throw new Error(`Multiple sites found (${names}) — pass siteId explicitly or set UOS_SITE_ID.`);
  }

  /** Match a device by id, MAC (case/colon-insensitive), or case-insensitive name. */
  async resolveDevice(siteId: string, idOrMacOrName: string): Promise<Record<string, unknown>> {
    const { data } = await this.list<Record<string, unknown>>(`/v1/sites/${siteId}/devices`, { limit: 200 });
    return this.pick(data, idOrMacOrName, "device");
  }

  /** Match a client by id, MAC, IP, or case-insensitive name. */
  async resolveClient(siteId: string, idOrMacOrNameOrIp: string): Promise<Record<string, unknown>> {
    const { data } = await this.list<Record<string, unknown>>(`/v1/sites/${siteId}/clients`, { limit: 200 });
    return this.pick(data, idOrMacOrNameOrIp, "client");
  }

  private pick(
    items: Record<string, unknown>[],
    key: string,
    kind: string,
  ): Record<string, unknown> {
    const wanted = key.toLowerCase();
    const mac = normalizeMac(key);
    const field = (it: Record<string, unknown>, ...names: string[]): unknown => {
      for (const n of names) {
        if (it[n] != null) return it[n];
      }
      return undefined;
    };
    const exact = items.find((it) => String(it.id ?? "").toLowerCase() === wanted);
    if (exact) return exact;
    if (mac) {
      const byMac = items.find((it) => normalizeMac(String(field(it, "macAddress", "mac") ?? "")) === mac);
      if (byMac) return byMac;
    }
    const byIp = items.find(
      (it) =>
        String(field(it, "ipAddress", "ip") ?? "").toLowerCase() === wanted ||
        String(it.name ?? "").toLowerCase().endsWith(` ${wanted}`),
    );
    if (byIp) return byIp;
    const byName = items.find((it) => String(it.name ?? "").toLowerCase() === wanted);
    if (byName) return byName;
    if (items.length === 0) {
      throw new Error(`No ${kind}s found on this site — cannot resolve "${key}".`);
    }
    const candidates = items
      .slice(0, 8)
      .map((it) => `${it.name ?? it.id}${field(it, "macAddress", "mac") ? ` [${field(it, "macAddress", "mac")}]` : ""}`)
      .join(", ");
    throw new Error(`No ${kind} matches "${key}". Candidates: ${candidates}${items.length > 8 ? " …" : ""}`);
  }
}

function normalizeMac(value: string): string | null {
  const mac = value.trim().toLowerCase().replace(/[:\-]/g, "");
  return /^[0-9a-f]{12}$/.test(mac) ? mac : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
