import mysql from "mysql2/promise";
import "dotenv/config";
import type { ItemRow, PriceHistoryRow } from "./types";

const batchSize = Number(process.env.BATCH_SIZE ?? 2);
const autoTargetMinScans = 5;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const pool = mysql.createPool({
  host: requireEnv("DB_HOST"),
  port: Number(process.env.DB_PORT ?? 3306),
  user: requireEnv("DB_USER"),
  password: requireEnv("DB_PASSWORD"),
  database: requireEnv("DB_NAME"),
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  dateStrings: false
});

const toNumber = (value: unknown): number => Number(value ?? 0);
const optionalNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export async function fetchItemsForScheduler(): Promise<ItemRow[]> {
  const [rows] = await pool.execute(
    `SELECT id, name, url, price, path, updated_at
     FROM coles_monitor
     WHERE updated_at < NOW() - INTERVAL 48 HOUR
     ORDER BY updated_at ASC
     LIMIT ?`,
    [batchSize]
  );
  return rows as ItemRow[];
}

export async function fetchAllItemsForScan(): Promise<ItemRow[]> {
  const [rows] = await pool.execute(
    `SELECT id, name, url, price, path, updated_at
     FROM coles_monitor
     ORDER BY updated_at ASC`
  );
  return rows as ItemRow[];
}

async function computeAutoTargets(itemIds: number[]): Promise<Map<number, number | null>> {
  const result = new Map<number, number | null>();
  for (const id of itemIds) {
    result.set(id, null);
  }
  if (itemIds.length === 0) {
    return result;
  }

  const placeholders = itemIds.map(() => "?").join(",");
  const [rows] = await pool.execute(
    `SELECT item_id, price
     FROM price_history
     WHERE item_id IN (${placeholders})
     ORDER BY item_id ASC, price ASC`,
    itemIds
  );

  const grouped = new Map<number, number[]>();
  for (const row of rows as Array<{ item_id: number; price: number }>) {
    const prices = grouped.get(row.item_id) ?? [];
    prices.push(Number(row.price));
    grouped.set(row.item_id, prices);
  }

  for (const id of itemIds) {
    const prices = grouped.get(id) ?? [];
    if (prices.length >= autoTargetMinScans) {
      result.set(id, prices[Math.floor(0.25 * prices.length)]);
    }
  }
  return result;
}

function attachBadges(item: ItemRow): ItemRow {
  const price = toNumber(item.price);
  const manualTarget = optionalNumber(item.target_price);
  const autoTarget = optionalNumber(item.auto_target);
  const average = optionalNumber(item.avg_price);
  const minimum = optionalNumber(item.min_price);
  const maximum = optionalNumber(item.max_price);
  const latest = optionalNumber(item.latest_price);
  const previous = optionalNumber(item.prev_price);
  const scanCount = Number(item.scan_count ?? 0);
  const effectiveTarget = manualTarget ?? autoTarget;
  const priceHasVaried = minimum !== null && maximum !== null && maximum > minimum;

  item.price = price;
  item.target_price = manualTarget;
  item.avg_price = average;
  item.min_price = minimum;
  item.max_price = maximum;
  item.scan_count = scanCount;
  item.auto_target = autoTarget;
  item.latest_price = latest;
  item.prev_price = previous;
  item.unavailable = Boolean(item.unavailable);
  item.badge_lowest_price = priceHasVaried && scanCount > 0 && price <= minimum;
  item.badge_below_avg = average !== null && priceHasVaried && price < average;
  item.badge_dropped =
    (latest !== null && previous !== null && latest < previous) ||
    item.badge_lowest_price ||
    item.badge_below_avg;
  item.badge_below_target = effectiveTarget !== null && price < effectiveTarget;
  item.badge_using_auto_target = manualTarget === null && autoTarget !== null;

  const updatedAt = item.updated_at;
  item.is_pending =
    updatedAt === null ||
    updatedAt === undefined ||
    (updatedAt instanceof Date && updatedAt.getFullYear() < 2001) ||
    String(updatedAt).startsWith("2000");

  return item;
}

export async function fetchAllItems(): Promise<ItemRow[]> {
  const [rows] = await pool.execute(
    `SELECT cm.*,
            COALESCE(ph.avg_price, cm.price) AS avg_price,
            COALESCE(ph.min_price, cm.price) AS min_price,
            COALESCE(ph.max_price, cm.price) AS max_price,
            COALESCE(ph.scan_count, 0) AS scan_count
     FROM coles_monitor cm
     LEFT JOIN (
       SELECT item_id, AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price, COUNT(*) AS scan_count
       FROM price_history
       GROUP BY item_id
     ) ph ON ph.item_id = cm.id
     ORDER BY cm.name ASC`
  );

  const items = rows as ItemRow[];
  if (items.length === 0) {
    return [];
  }

  const itemIds = items.map((item) => item.id);
  const placeholders = itemIds.map(() => "?").join(",");
  const [recentRows] = await pool.execute(
    `SELECT ph.item_id, ph.price
     FROM price_history ph
     WHERE ph.item_id IN (${placeholders})
       AND (
         SELECT COUNT(*) FROM price_history ph2
         WHERE ph2.item_id = ph.item_id AND ph2.id >= ph.id
       ) <= 2
     ORDER BY ph.item_id, ph.id DESC`,
    itemIds
  );

  const recent = new Map<number, number[]>();
  for (const row of recentRows as Array<{ item_id: number; price: number }>) {
    const prices = recent.get(row.item_id) ?? [];
    prices.push(Number(row.price));
    recent.set(row.item_id, prices);
  }

  const autoTargets = await computeAutoTargets(itemIds);
  const enriched = items.map((item) => {
    const prices = recent.get(item.id) ?? [];
    item.latest_price = prices[0] ?? null;
    item.prev_price = prices[1] ?? null;
    item.auto_target = autoTargets.get(item.id) ?? null;
    return attachBadges(item);
  });

  return enriched.sort((a, b) => {
    const aBadged = a.badge_dropped || a.badge_below_target || a.badge_below_avg;
    const bBadged = b.badge_dropped || b.badge_below_target || b.badge_below_avg;
    if (aBadged !== bBadged) {
      return aBadged ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export async function fetchSaleItems(): Promise<ItemRow[]> {
  const items = await fetchAllItems();
  return items.filter((item) => item.badge_below_target || item.badge_below_avg);
}

export async function fetchItemById(itemId: number): Promise<ItemRow | null> {
  const [rows] = await pool.execute("SELECT * FROM coles_monitor WHERE id = ?", [itemId]);
  const item = (rows as ItemRow[])[0];
  if (!item) {
    return null;
  }

  const [statsRows] = await pool.execute(
    `SELECT AVG(price) AS avg_price, MIN(price) AS min_price, MAX(price) AS max_price, COUNT(*) AS scan_count
     FROM price_history WHERE item_id = ?`,
    [itemId]
  );
  const stats = (statsRows as Array<Partial<ItemRow>>)[0] ?? {};
  item.avg_price = stats.avg_price ?? null;
  item.min_price = stats.min_price ?? null;
  item.max_price = stats.max_price ?? null;
  item.scan_count = stats.scan_count ?? 0;

  const [recentRows] = await pool.execute(
    `SELECT price FROM price_history WHERE item_id = ?
     ORDER BY scanned_at DESC LIMIT 2`,
    [itemId]
  );
  const recent = recentRows as Array<{ price: number }>;
  item.latest_price = recent[0] ? Number(recent[0].price) : null;
  item.prev_price = recent[1] ? Number(recent[1].price) : null;
  item.auto_target = (await computeAutoTargets([itemId])).get(itemId) ?? null;
  return attachBadges(item);
}

export async function addItem(name: string, url: string, targetPrice: number | null): Promise<number> {
  const [result] = await pool.execute(
    `INSERT INTO coles_monitor (name, url, price, target_price, path)
     VALUES (?, ?, 0.00, ?, NULL)`,
    [name, url, targetPrice]
  );
  return Number((result as mysql.ResultSetHeader).insertId);
}

export async function updateItem(itemId: number, price: number): Promise<void> {
  await pool.execute(
    `UPDATE coles_monitor SET price = ?, updated_at = NOW() WHERE id = ?`,
    [price, itemId]
  );
}

export async function updateItemImage(itemId: number, path: string): Promise<void> {
  await pool.execute("UPDATE coles_monitor SET path = ? WHERE id = ?", [path, itemId]);
}

export async function markItemUnavailable(itemId: number): Promise<void> {
  await pool.execute(
    `UPDATE coles_monitor SET unavailable = 1, updated_at = NOW() WHERE id = ?`,
    [itemId]
  );
}

export async function markItemAvailable(itemId: number): Promise<void> {
  await pool.execute("UPDATE coles_monitor SET unavailable = 0 WHERE id = ?", [itemId]);
}

export async function recordPriceHistory(
  itemId: number,
  price: number,
  rawPrice: string
): Promise<void> {
  await pool.execute(
    `INSERT INTO price_history (item_id, price, raw_price) VALUES (?, ?, ?)`,
    [itemId, price, rawPrice]
  );
}

export async function fetchPriceHistoryForItem(itemId: number): Promise<PriceHistoryRow[]> {
  const [rows] = await pool.execute(
    `SELECT price, raw_price, scanned_at
     FROM price_history
     WHERE item_id = ?
     ORDER BY scanned_at ASC`,
    [itemId]
  );

  return (rows as Array<{ price: number; raw_price: string; scanned_at: Date | string }>).map((row) => ({
    price: Number(row.price),
    raw_price: row.raw_price,
    scanned_at: row.scanned_at instanceof Date ? row.scanned_at.toISOString() : String(row.scanned_at)
  }));
}
