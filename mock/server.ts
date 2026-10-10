export interface DealLineItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface Deal {
  id: string;
  name: string;
  amount: number;
  currency: string;
  status: "open" | "won" | "lost";
  lineItems: DealLineItem[];
  createdAt: string;
}

export interface LegacyDealLineItem {
  line_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

export interface LegacyDeal {
  deal_id: string;
  name: string;
  amount_cents: number;
  currency: string;
  status: "OPEN" | "WON" | "LOST";
  line_items: LegacyDealLineItem[];
  created_at: string;
}

export interface MockDbState {
  legacyDeals: LegacyDeal[];
  modernDeals: Deal[];
  idempotencyCache: Map<string, { status: number; body: unknown; dealId: string }>;
}

export function createInitialState(): MockDbState {
  const seedTimestamp = "2026-10-10T10:00:00.000Z";
  return {
    legacyDeals: [
      {
        deal_id: "dl_001",
        name: "Acme Cloud Migration",
        amount_cents: 1500000,
        currency: "USD",
        status: "WON",
        line_items: [
          {
            line_id: "li_001",
            name: "Architecture Review",
            quantity: 1,
            unit_price_cents: 500000,
          },
          {
            line_id: "li_002",
            name: "Implementation Hours",
            quantity: 40,
            unit_price_cents: 25000,
          },
        ],
        created_at: seedTimestamp,
      },
    ],
    modernDeals: [
      {
        id: "dl_001",
        name: "Acme Cloud Migration",
        amount: 15000.0,
        currency: "USD",
        status: "won",
        lineItems: [
          {
            id: "li_001",
            name: "Architecture Review",
            quantity: 1,
            unitPrice: 5000.0,
          },
          {
            id: "li_002",
            name: "Implementation Hours",
            quantity: 40,
            unitPrice: 250.0,
          },
        ],
        createdAt: seedTimestamp,
      },
    ],
    idempotencyCache: new Map(),
  };
}

export function createMockServer(port: number = 4000) {
  let state = createInitialState();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();

      // Health check
      if (path === "/health" && method === "GET") {
        return Response.json({ status: "ok", timestamp: new Date().toISOString() });
      }

      // Reset state
      if (path === "/reset" && method === "POST") {
        state = createInitialState();
        return Response.json({ status: "reset_complete" });
      }

      // -------------------------------------------------------------
      // V1: Legacy CRM API (No idempotency, snake_case, cents)
      // -------------------------------------------------------------
      if (path === "/v1/deals" && method === "GET") {
        return Response.json(state.legacyDeals);
      }

      if (path.startsWith("/v1/deals/") && method === "GET") {
        const id = path.split("/")[3];
        const deal = state.legacyDeals.find((d) => d.deal_id === id);
        if (!deal) return Response.json({ error: "Deal not found" }, { status: 404 });
        return Response.json(deal);
      }

      if (path === "/v1/deals" && method === "POST") {
        // Legacy bug: IGNORES Idempotency-Key! Creates new deal every call.
        const body = (await req.json().catch(() => ({}))) as Partial<LegacyDeal>;
        const newId = `dl_${String(state.legacyDeals.length + 1).padStart(3, "0")}`;
        const createdDeal: LegacyDeal = {
          deal_id: newId,
          name: body.name ?? "Untitled Deal",
          amount_cents: body.amount_cents ?? 0,
          currency: body.currency ?? "USD",
          status: (body.status ?? "OPEN") as "OPEN" | "WON" | "LOST",
          line_items: body.line_items ?? [],
          created_at: new Date().toISOString(),
        };
        state.legacyDeals.push(createdDeal);
        return Response.json(createdDeal, { status: 201 });
      }

      // -------------------------------------------------------------
      // V2: Modern CRM API (Strict idempotency, camelCase, dollar units)
      // -------------------------------------------------------------
      if (path === "/v2/deals" && method === "GET") {
        return Response.json(state.modernDeals);
      }

      if (path.startsWith("/v2/deals/") && method === "GET") {
        const id = path.split("/")[3];
        const deal = state.modernDeals.find((d) => d.id === id);
        if (!deal) return Response.json({ error: "Deal not found" }, { status: 404 });
        return Response.json(deal);
      }

      if (path === "/v2/deals" && method === "POST") {
        const idempotencyKey = req.headers.get("idempotency-key");
        if (idempotencyKey && state.idempotencyCache.has(idempotencyKey)) {
          const cached = state.idempotencyCache.get(idempotencyKey)!;
          return Response.json(cached.body, {
            status: cached.status,
            headers: {
              "X-Cache": "IDEMPOTENT_HIT",
              "Idempotency-Key": idempotencyKey,
            },
          });
        }

        const body = (await req.json().catch(() => ({}))) as Partial<Deal>;
        const newId = `dl_${String(state.modernDeals.length + 1).padStart(3, "0")}`;
        const createdDeal: Deal = {
          id: newId,
          name: body.name ?? "Untitled Deal",
          amount: body.amount ?? 0,
          currency: body.currency ?? "USD",
          status: (body.status ?? "open") as "open" | "won" | "lost",
          lineItems: body.lineItems ?? [],
          createdAt: new Date().toISOString(),
        };
        state.modernDeals.push(createdDeal);

        if (idempotencyKey) {
          state.idempotencyCache.set(idempotencyKey, {
            status: 201,
            body: createdDeal,
            dealId: newId,
          });
        }

        return Response.json(createdDeal, {
          status: 201,
          headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
        });
      }

      // -------------------------------------------------------------
      // Parity Verification Endpoints (Same schema for dual-run testing)
      // -------------------------------------------------------------
      if (path === "/v1/parity/deals" && method === "GET") {
        return Response.json({
          status: "success",
          count: state.legacyDeals.length,
          deals: state.legacyDeals,
        });
      }

      if (path === "/v2/parity/deals" && method === "GET") {
        return Response.json({
          status: "success",
          count: state.legacyDeals.length,
          deals: state.legacyDeals,
        });
      }

      if (path === "/v1/parity/deal" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        return Response.json(
          {
            confirmed: true,
            version: "v1",
            payload: body,
          },
          { status: 200 }
        );
      }

      if (path === "/v2/parity/deal" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        return Response.json(
          {
            confirmed: true,
            version: "v1", // matches for parity test
            payload: body,
          },
          { status: 200 }
        );
      }

      return Response.json({ error: "Not Found", path }, { status: 404 });
    },
  });

  return {
    server,
    port: server.port,
    url: `http://localhost:${server.port}`,
    reset: () => {
      state = createInitialState();
    },
    getState: () => state,
    close: () => server.stop(),
  };
}

// If executed directly: bun run mock/server.ts
if (import.meta.main) {
  const defaultPort = Number(process.env.PORT || 4000);
  const mock = createMockServer(defaultPort);
  console.log(`CRM Mock API Server running at ${mock.url}`);
  console.log(`  - Legacy v1:  ${mock.url}/v1/deals`);
  console.log(`  - Modern v2:  ${mock.url}/v2/deals`);
  console.log(`  - Parity:     ${mock.url}/v1/parity/deals <=> ${mock.url}/v2/parity/deals`);
  console.log(`  - Reset:      POST ${mock.url}/reset`);
}
