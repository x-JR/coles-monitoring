import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import "dotenv/config";
import * as db from "./db";
import { startScheduler, triggerFullScan, triggerItemScan } from "./scheduler";
import type { SaleMode } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT ?? 8000);
const app = express();
const visitorCookieName = "coles_monitor_visitor_id";
const visitorCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
const visitorIdPattern = /^[a-f0-9-]{36}$/i;

declare global {
  namespace Express {
    interface Request {
      visitorId: string;
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => {
        const [name, ...value] = part.trim().split("=");
        return [name, decodeURIComponent(value.join("="))];
      })
      .filter(([name]) => Boolean(name))
  );
}

function ensureVisitorId(request: express.Request, response: express.Response, next: express.NextFunction) {
  const cookies = parseCookies(request.headers.cookie);
  const existingVisitorId = cookies[visitorCookieName];
  const visitorId = existingVisitorId && visitorIdPattern.test(existingVisitorId) ? existingVisitorId : randomUUID();
  request.visitorId = visitorId;

  if (visitorId !== existingVisitorId) {
    setVisitorCookie(response, request, visitorId);
  }

  next();
}

function setVisitorCookie(response: express.Response, request: express.Request, visitorId: string) {
  response.cookie(visitorCookieName, visitorId, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.secure,
    maxAge: visitorCookieMaxAgeSeconds * 1000
  });
}

function isAdminVisitor(visitorId: string): boolean {
  const adminVisitorId = process.env.ADMIN_VISITOR_ID;
  if (!adminVisitorId || !visitorIdPattern.test(adminVisitorId)) return false;

  const configured = Buffer.from(adminVisitorId.toLowerCase());
  const supplied = Buffer.from(visitorId.toLowerCase());
  return configured.length === supplied.length && timingSafeEqual(configured, supplied);
}

function requireAdmin(request: express.Request, response: express.Response, next: express.NextFunction) {
  if (!process.env.ADMIN_VISITOR_ID) {
    response.status(503).json({ error: "Admin access is not configured." });
    return;
  }
  if (!isAdminVisitor(request.visitorId)) {
    response.status(403).json({ error: "This visitor ID does not have admin access." });
    return;
  }
  next();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(ensureVisitorId);
app.use("/static", express.static(path.join(process.cwd(), "static")));

app.get("/api/visitor", (request, response) => {
  response.json({ visitor_id: request.visitorId, is_admin: isAdminVisitor(request.visitorId) });
});

app.put("/api/visitor", (request, response) => {
  const visitorId = String(request.body.visitor_id ?? "").trim();
  if (!visitorIdPattern.test(visitorId)) {
    response.status(422).json({ error: "Visitor ID must be a UUID." });
    return;
  }

  request.visitorId = visitorId;
  setVisitorCookie(response, request, visitorId);
  response.json({ visitor_id: visitorId, is_admin: isAdminVisitor(visitorId) });
});

app.get("/api/items", async (request, response, next) => {
  try {
    const items = (await db.fetchAllItems()).map((item) => db.attachManagePermission(item, request.visitorId));
    response.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get("/api/on-sale", async (request, response, next) => {
  try {
    const mode = ["dropped", "target", "average"].includes(String(request.query.mode))
      ? (request.query.mode as SaleMode)
      : "dropped";
    const allItems = (await db.fetchAllItems()).map((item) => db.attachManagePermission(item, request.visitorId));
    const items = allItems.filter((item) => {
      if (mode === "target") return item.badge_below_target;
      if (mode === "average") return item.badge_below_avg;
      return item.badge_dropped;
    });
    response.json({ items, mode });
  } catch (error) {
    next(error);
  }
});

app.get("/api/items/:itemId", async (request, response, next) => {
  try {
    const itemId = Number(request.params.itemId);
    const item = await db.fetchItemById(itemId);
    if (!item) {
      response.status(404).json({ error: "Item not found." });
      return;
    }
    const history = await db.fetchPriceHistoryForItem(itemId);
    const salePrediction = db.predictSaleCycle(history);
    response.json({ item: db.attachManagePermission(item, request.visitorId), history, sale_prediction: salePrediction });
  } catch (error) {
    next(error);
  }
});

app.post("/api/items", async (request, response, next) => {
  try {
    const name = String(request.body.name ?? "").trim();
    const url = String(request.body.url ?? "").trim();
    const targetPriceRaw = String(request.body.target_price ?? "").trim();
    const errors: string[] = [];

    if (!name) errors.push("Name is required.");
    if (!url.startsWith("https://www.coles.com.au/")) {
      errors.push("URL must be a Coles product URL starting with https://www.coles.com.au/.");
    }

    let targetPrice: number | null = null;
    if (targetPriceRaw) {
      targetPrice = Number(targetPriceRaw.replace(/^\$/, ""));
      if (!Number.isFinite(targetPrice)) errors.push("Target price must be a valid number.");
      else if (targetPrice <= 0) errors.push("Target price must be a positive number.");
    }

    if (errors.length > 0) {
      response.status(422).json({ errors });
      return;
    }

    const itemId = await db.addItem(name, url, targetPrice, request.visitorId);
    triggerItemScan(itemId);
    response.status(201).json({ id: itemId });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/items/:itemId", async (request, response, next) => {
  try {
    const itemId = Number(request.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      response.status(400).json({ error: "Invalid item id." });
      return;
    }

    const item = await db.fetchItemById(itemId);
    if (!item) {
      response.status(404).json({ error: "Item not found." });
      return;
    }

    const deleted = await db.deleteItemForVisitor(itemId, request.visitorId);
    if (!deleted) {
      response.status(403).json({ error: "You can only delete items added from this browser." });
      return;
    }

    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/items", requireAdmin, async (_request, response, next) => {
  try {
    response.json({ items: await db.fetchAllItems() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/items/:itemId", requireAdmin, async (request, response, next) => {
  try {
    const itemId = Number(request.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      response.status(400).json({ error: "Invalid item id." });
      return;
    }

    const deleted = await db.deleteItem(itemId);
    if (!deleted) {
      response.status(404).json({ error: "Item not found." });
      return;
    }

    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.patch("/api/admin/items/:itemId", requireAdmin, async (request, response, next) => {
  try {
    const itemId = Number(request.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      response.status(400).json({ error: "Invalid item id." });
      return;
    }

    const name = String(request.body.name ?? "").trim();
    const autoPricingEnabled = request.body.auto_pricing_enabled;
    const errors: string[] = [];

    if (!name) errors.push("Name is required.");
    if (typeof autoPricingEnabled !== "boolean") {
      errors.push("Auto pricing setting must be true or false.");
    }

    if (errors.length > 0) {
      response.status(422).json({ errors });
      return;
    }

    if (!autoPricingEnabled && !db.canPersistAutoPricingSetting()) {
      response.status(503).json({
        error: "Run the init.sql auto_pricing_enabled migration before disabling auto pricing."
      });
      return;
    }

    const existingItem = await db.fetchItemById(itemId);
    if (!existingItem) {
      response.status(404).json({ error: "Item not found." });
      return;
    }

    await db.updateAdminItemDetails(itemId, name, autoPricingEnabled);
    const item = await db.fetchItemById(itemId);
    response.json({ item });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync-all", requireAdmin, (_request, response) => {
  triggerFullScan();
  response.status(202).json({ syncing: true });
});

if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "../../dist");
  app.use(express.static(distPath));
  app.use((request, response, next) => {
    if (request.method === "GET" && !request.path.startsWith("/api")) {
      response.sendFile(path.join(distPath, "index.html"));
      return;
    }
    next();
  });
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
});

await db.loadSchemaCapabilities();
startScheduler();
app.listen(port, () => {
  console.info(`Coles Monitor API listening on http://localhost:${port}`);
});
