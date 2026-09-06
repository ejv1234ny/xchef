import {
  MenusMetadataSchema,
  MenusResponseSchema,
  OrderSchema,
  OrdersPageSchema,
  TokenResponseSchema,
  type MenusResponse,
  type ToastOrder,
} from "./schemas";

export type ToastClientOptions = {
  host: string;
  clientId: string;
  clientSecret: string;
  restaurantGuid: string;
  /** requests per second per location; Toast allows 5, we stay at 4 */
  rps?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

/** Toast wants `yyyy-MM-dd'T'HH:mm:ss.SSSZ` with a numeric offset and no colon. */
export function toToastDate(d: Date): string {
  return d.toISOString().replace("Z", "+0000");
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rps: number) {
    this.tokens = rps;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.rps) * 1000)));
    }
  }
}

export type QuarantinedOrder = { guid: string | null; reason: string };

export type OrdersPage = {
  page: number;
  orders: ToastOrder[];
  quarantined: QuarantinedOrder[];
};

export class ToastClient {
  private token?: { value: string; expiresAt: number };
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<ToastClientOptions["log"]>;

  constructor(private readonly opts: ToastClientOptions) {
    this.bucket = new TokenBucket(opts.rps ?? 4);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /** POST /authentication/v1/authentication/login, cached until expiresIn − 60s. */
  async login(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const res = await this.fetchImpl(`${this.opts.host}/authentication/v1/authentication/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: this.opts.clientId,
        clientSecret: this.opts.clientSecret,
        userAccessType: "TOAST_MACHINE_CLIENT",
      }),
    });
    if (!res.ok) throw new Error(`Toast login failed: ${res.status} ${await res.text()}`);
    const parsed = TokenResponseSchema.parse(await res.json());
    this.token = {
      value: parsed.token.accessToken,
      expiresAt: Date.now() + (parsed.token.expiresIn - 60) * 1000,
    };
    return this.token.value;
  }

  /** Authenticated, throttled GET with the restaurant header and 429 retry. */
  async get(path: string, query?: Record<string, string | number>): Promise<Response> {
    const url = new URL(path, this.opts.host);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.bucket.take();
      const token = await this.login();
      const res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Toast-Restaurant-External-ID": this.opts.restaurantGuid,
          Accept: "application/json",
        },
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        const wait = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        this.log("toast: retrying", { status: res.status, wait, path });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      return res;
    }
    throw new Error(`Toast GET ${path}: gave up after retries`);
  }

  /**
   * Async iterator over /orders/v2/ordersBulk. Yields one page at a time with
   * validated orders and a list of quarantined (invalid) ones. Follows a
   * `Link: <...>; rel="next"` header when Toast sends one; otherwise pages by
   * number until a short page.
   */
  async *ordersBulk(start: Date, end: Date, pageSize = 100): AsyncGenerator<OrdersPage> {
    let page = 1;
    let nextUrl: string | null = null;
    for (;;) {
      const res: Response = nextUrl
        ? await this.get(nextUrl)
        : await this.get("/orders/v2/ordersBulk", {
            startDate: toToastDate(start),
            endDate: toToastDate(end),
            page,
            pageSize,
          });
      if (!res.ok) throw new Error(`ordersBulk ${res.status}: ${await res.text()}`);
      const raw = OrdersPageSchema.parse(await res.json());
      const orders: ToastOrder[] = [];
      const quarantined: QuarantinedOrder[] = [];
      for (const o of raw) {
        const parsed = OrderSchema.safeParse(o);
        if (parsed.success) orders.push(parsed.data);
        else {
          const guid =
            typeof o === "object" && o && "guid" in o && typeof o.guid === "string" ? o.guid : null;
          quarantined.push({ guid, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        }
      }
      yield { page, orders, quarantined };
      const link = res.headers.get("link");
      const next = link?.match(/<([^>]+)>;\s*rel="?next"?/i)?.[1] ?? null;
      if (next) {
        nextUrl = next;
        page += 1;
        continue;
      }
      if (raw.length < pageSize) return;
      page += 1;
      nextUrl = null;
    }
  }

  async menusMetadata(): Promise<{ lastUpdated: string }> {
    const res = await this.get("/menus/v2/metadata");
    if (!res.ok) throw new Error(`menus metadata ${res.status}: ${await res.text()}`);
    return MenusMetadataSchema.parse(await res.json());
  }

  async menus(): Promise<MenusResponse> {
    const res = await this.get("/menus/v2/menus");
    if (!res.ok) throw new Error(`menus ${res.status}: ${await res.text()}`);
    return MenusResponseSchema.parse(await res.json());
  }

  /** Config lookups (sales categories, revenue centers, dining options). Untyped: display only. */
  async config(kind: "salesCategories" | "revenueCenters" | "diningOptions"): Promise<unknown[]> {
    const res = await this.get(`/config/v2/${kind}`);
    if (!res.ok) throw new Error(`config ${kind} ${res.status}: ${await res.text()}`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  }

  /** GET /labor/v1/timeEntries for a window (Toast allows ≤ 30 days; scope labor:read). Untyped here; lib/core/labor.ts validates. */
  async timeEntries(start: Date, end: Date): Promise<unknown[]> {
    const res = await this.get("/labor/v1/timeEntries", { startDate: toToastDate(start), endDate: toToastDate(end) });
    if (!res.ok) throw new Error(`timeEntries ${res.status}: ${await res.text()}`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  }

  /** GET /labor/v1/jobs: job guid → title (no employee details are ever requested). */
  async jobs(): Promise<unknown[]> {
    const res = await this.get("/labor/v1/jobs");
    if (!res.ok) throw new Error(`jobs ${res.status}: ${await res.text()}`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  }

  /** GET /stock/v1/inventory (scope stock:read): the items currently OUT_OF_STOCK or at a QUANTITY. Untyped here; lib/core/stock.ts validates. */
  async stockInventory(): Promise<unknown[]> {
    const res = await this.get("/stock/v1/inventory");
    if (!res.ok) throw new Error(`stock inventory ${res.status}: ${await res.text()}`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  }

  async restaurant(): Promise<unknown> {
    const res = await this.get(`/restaurants/v1/restaurants/${this.opts.restaurantGuid}`);
    if (!res.ok) throw new Error(`restaurant ${res.status}: ${await res.text()}`);
    return res.json();
  }
}
