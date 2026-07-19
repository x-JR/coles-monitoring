import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, errors } from "playwright";
import * as db from "./db";
import { sendDiscordFailure } from "./discord";
import type { ItemRow } from "./types";

class ProductUnavailableError extends Error {}

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1"
};

const priceSelector = ".price";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function scrapePrice(page: Page, url: string): Promise<{ rawPrice: string; currentPrice: number }> {
  await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(priceSelector, { timeout: 15_000 });
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      throw new ProductUnavailableError(
        `Price selector '${priceSelector}' not found after 15 seconds; product may be unavailable`
      );
    }
    throw error;
  }

  const rawText = ((await page.locator(priceSelector).first().innerText()) ?? "").trim();
  const match = rawText.match(/[\d.]+/);
  if (!match) {
    throw new Error(`Could not parse a number from price text: ${rawText}`);
  }

  const rawPrice = rawText.replace(/Save\s*\$?[\d.]+.*$/i, "").replace("$", "").trim();
  return { rawPrice, currentPrice: Number(match[0]) };
}

async function scrapeImage(page: Page): Promise<string | null> {
  const image = page.locator("img").first();
  if ((await image.count()) === 0) {
    return null;
  }
  const src = (await image.getAttribute("src")) ?? (await image.getAttribute("data-src"));
  return src?.trim() || null;
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

async function downloadImage(url: string, itemId: number): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": requestHeaders["User-Agent"] },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`Image request failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const extension = extensionForContentType(contentType);
    const imagesDir = path.join(process.cwd(), "static", "images");
    await mkdir(imagesDir, { recursive: true });

    const filename = `item_${itemId}${extension}`;
    const filePath = path.join(imagesDir, filename);
    await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    return `/static/images/${filename}`;
  } catch (error) {
    console.warn(`Image download failed for item ${itemId}:`, error);
    return null;
  }
}

export async function runScanForItems(items: ItemRow[]): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: requestHeaders["User-Agent"],
      extraHTTPHeaders: Object.fromEntries(
        Object.entries(requestHeaders).filter(([key]) => key !== "User-Agent")
      )
    });
    const page = await context.newPage();

    for (const [index, item] of items.entries()) {
      console.info(`Scanning: ${item.name} - ${item.url}`);
      try {
        const { rawPrice, currentPrice } = await scrapePrice(page, item.url);
        await db.markItemAvailable(item.id);
        await db.recordPriceHistory(item.id, currentPrice, rawPrice);
        await db.updateItem(item.id, currentPrice);

        if (!item.path) {
          const imageUrl = await scrapeImage(page);
          if (imageUrl) {
            const localPath = await downloadImage(imageUrl, item.id);
            if (localPath) {
              await db.updateItemImage(item.id, localPath);
            }
          }
        }
      } catch (error) {
        if (error instanceof ProductUnavailableError) {
          console.warn(`Product '${item.name}' appears unavailable: ${error.message}`);
          await db.markItemUnavailable(item.id);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Scrape failed for '${item.name}': ${message}`);
          await sendDiscordFailure(item, message).catch((notifyError) => {
            console.error("Discord failure notification failed:", notifyError);
          });
          await db.updateItem(item.id, Number(item.price));
        }
      }

      if (index < items.length - 1) {
        await delay(3_000 + Math.random() * 7_000);
      }
    }
  } finally {
    await browser.close();
  }
}

export async function scanSingleItem(itemId: number): Promise<void> {
  const item = await db.fetchItemById(itemId);
  if (!item) {
    console.warn(`scanSingleItem: item ${itemId} not found`);
    return;
  }
  await runScanForItems([item]);
}
