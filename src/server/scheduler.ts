import cron from "node-cron";
import * as db from "./db";
import { sendDiscordDailySummary } from "./discord";
import { runScanForItems, scanSingleItem } from "./scanner";

let started = false;

async function dailyScanAndSummaryJob(): Promise<void> {
  console.info("Daily scan starting.");
  const items = await db.fetchAllItemsForScan();
  await runScanForItems(items);
  console.info("Daily scan complete. Fetching sale items for summary.");

  const saleItems = await db.fetchSaleItems();
  if (saleItems.length > 0) {
    await sendDiscordDailySummary(saleItems);
    console.info(`Daily summary sent for ${saleItems.length} item(s).`);
  } else {
    console.info("No sale items found; skipping daily summary.");
  }
}

export function startScheduler(): void {
  if (started) {
    return;
  }
  cron.schedule("0 8 * * *", () => {
    dailyScanAndSummaryJob().catch((error) => console.error("Daily scan failed:", error));
  });
  started = true;
  console.info("Scheduler started (daily scan + summary job registered at 08:00).");
}

export function triggerItemScan(itemId: number): void {
  setImmediate(() => {
    scanSingleItem(itemId).catch((error) => console.error(`Immediate scan ${itemId} failed:`, error));
  });
  console.info(`Immediate scan queued for item ${itemId}.`);
}

export function triggerFullScan(): void {
  setImmediate(async () => {
    console.info("Manual full sync starting.");
    const items = await db.fetchAllItemsForScan();
    await runScanForItems(items);
    console.info("Manual full sync complete.");
  });
  console.info("Manual full sync queued.");
}
