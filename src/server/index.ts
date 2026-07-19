import path from "node:path";
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/static", express.static(path.join(process.cwd(), "static")));

app.get("/api/items", async (_request, response, next) => {
  try {
    response.json({ items: await db.fetchAllItems() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/on-sale", async (request, response, next) => {
  try {
    const mode = ["dropped", "target", "average"].includes(String(request.query.mode))
      ? (request.query.mode as SaleMode)
      : "dropped";
    const allItems = await db.fetchAllItems();
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
    response.json({ item, history });
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

    const itemId = await db.addItem(name, url, targetPrice);
    triggerItemScan(itemId);
    response.status(201).json({ id: itemId });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sync-all", (_request, response) => {
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

startScheduler();
app.listen(port, () => {
  console.info(`Coles Monitor API listening on http://localhost:${port}`);
});
