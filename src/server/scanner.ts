import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { errors, type Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as db from "./db";
import { sendDiscordFailure } from "./discord";
import type { ItemRow } from "./types";

chromium.use(StealthPlugin());

class ProductUnavailableError extends Error {}

type ScrapedPrice = { rawPrice: string; currentPrice: number; imageUrl: string | null };

const chromeVersion = "126.0.0.0";

const requestHeaders = {
  "User-Agent":
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9,en-US;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua": `"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"'
};

const priceSelector = ".price";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const colesOrigin = "https://www.coles.com.au";
let nextBuildIdCache: string | null = null;

const structuredDataHeaders = {
  "User-Agent": requestHeaders["User-Agent"],
  Accept: requestHeaders.Accept,
  "Accept-Language": requestHeaders["Accept-Language"]
};

const jsonHeaders = {
  "User-Agent": requestHeaders["User-Agent"],
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": requestHeaders["Accept-Language"]
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (match) {
      const price = Number(match[0]);
      return Number.isFinite(price) ? price : null;
    }
  }
  return null;
}

function findOfferPrice(offers: unknown): number | null {
  const offerList = Array.isArray(offers) ? offers : [offers];
  for (const offer of offerList) {
    if (!isRecord(offer)) {
      continue;
    }
    const price = normalizePrice(offer.price);
    if (price !== null) {
      return price;
    }
    if (isRecord(offer.priceSpecification)) {
      const specificationPrice = normalizePrice(offer.priceSpecification.price);
      if (specificationPrice !== null) {
        return specificationPrice;
      }
    }
  }
  return null;
}

function findProductPriceFromStructuredData(value: unknown): ScrapedPrice | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findProductPriceFromStructuredData(item);
      if (result) {
        return result;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const type = value["@type"];
  const typeList = Array.isArray(type) ? type : [type];
  if (typeList.includes("Product")) {
    const currentPrice = findOfferPrice(value.offers);
    if (currentPrice !== null) {
      const image = Array.isArray(value.image) ? value.image[0] : value.image;
      return {
        rawPrice: currentPrice.toFixed(2),
        currentPrice,
        imageUrl: typeof image === "string" ? image : null
      };
    }
  }

  if (Array.isArray(value["@graph"])) {
    return findProductPriceFromStructuredData(value["@graph"]);
  }

  return null;
}

function productSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/product\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function findNextBuildId(html: string): string | null {
  const direct = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (direct) {
    return direct[1];
  }

  const patterns = [
    /\/_next\/static\/([^/"']+)\/_buildManifest\.js/,
    /\/_next\/static\/([^/"']+)\/_ssgManifest\.js/,
    /\/_next\/data\/([^/"']+)\//
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

async function discoverNextBuildId(): Promise<string | null> {
  if (nextBuildIdCache) {
    return nextBuildIdCache;
  }

  const discoveryUrls = [
    `${colesOrigin}/_next/build-manifest.json`,
    `${colesOrigin}/_next/routes-manifest.json`,
    `${colesOrigin}/asset-manifest.json`
  ];
  for (const url of discoveryUrls) {
    const response = await fetch(url, {
      headers: { ...structuredDataHeaders, Accept: "*/*" },
      signal: AbortSignal.timeout(15_000)
    });
    const buildId = findNextBuildId(await response.text());
    if (buildId) {
      nextBuildIdCache = buildId;
      return buildId;
    }
  }

  return null;
}

function productImageUrl(product: Record<string, unknown>, assetsUrl: unknown): string | null {
  if (typeof assetsUrl === "string") {
    const productId = String(product.id ?? "").replace(/\D/g, "");
    if (productId.length >= 3) {
      const [first, second, third] = productId;
      return `${assetsUrl.replace(/\/$/, "")}/wcsstore/Coles-CAS/images/${first}/${second}/${third}/${productId}-zm.jpg`;
    }
  }

  const imageUris = product.imageUris;
  if (!Array.isArray(imageUris)) {
    return null;
  }
  const [firstImage] = imageUris;
  if (isRecord(firstImage) && typeof firstImage.uri === "string" && /^https?:\/\//i.test(firstImage.uri)) {
    return firstImage.uri;
  }
  return null;
}

function findProductPriceFromNextData(value: unknown): ScrapedPrice | null {
  if (!isRecord(value)) {
    return null;
  }

  const pageProps = isRecord(value.pageProps) ? value.pageProps : null;
  const product = pageProps && isRecord(pageProps.product) ? pageProps.product : null;
  if (!product || !isRecord(product.pricing)) {
    return null;
  }

  const currentPrice = normalizePrice(product.pricing.now);
  if (currentPrice === null) {
    return null;
  }

  return {
    rawPrice: currentPrice.toFixed(2),
    currentPrice,
    imageUrl: productImageUrl(product, pageProps?.assetsUrl)
  };
}

async function scrapeNextDataPrice(url: string): Promise<ScrapedPrice | null> {
  const slug = productSlugFromUrl(url);
  if (!slug) {
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const buildId = await discoverNextBuildId();
    if (!buildId) {
      return null;
    }

    const dataUrl = `${colesOrigin}/_next/data/${encodeURIComponent(buildId)}/product/${encodeURIComponent(
      slug
    )}.json?slug=${encodeURIComponent(slug)}`;
    const response = await fetch(dataUrl, {
      headers: { ...jsonHeaders, Referer: url },
      signal: AbortSignal.timeout(15_000)
    });

    if (response.status === 404 && nextBuildIdCache === buildId) {
      nextBuildIdCache = null;
      continue;
    }
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as unknown;
    return findProductPriceFromNextData(data);
  }

  return null;
}

function scrapeStructuredPriceFromHtml(html: string): ScrapedPrice | null {
  const scripts = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const script of scripts) {
    try {
      const data = JSON.parse(script[1].trim()) as unknown;
      const result = findProductPriceFromStructuredData(data);
      if (result) {
        return result;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function scrapeStructuredPrice(url: string): Promise<ScrapedPrice | null> {
  const response = await fetch(url, {
    headers: structuredDataHeaders,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    return null;
  }
  return scrapeStructuredPriceFromHtml(await response.text());
}

async function scrapePrice(page: Page, url: string): Promise<ScrapedPrice> {
  const nextDataPrice = await scrapeNextDataPrice(url).catch((error) => {
    console.warn(`Next data price scrape failed for ${url}:`, error);
    return null;
  });
  if (nextDataPrice) {
    return nextDataPrice;
  }

  const structuredPrice = await scrapeStructuredPrice(url).catch((error) => {
    console.warn(`Structured price scrape failed for ${url}:`, error);
    return null;
  });
  if (structuredPrice) {
    return structuredPrice;
  }

  await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector(priceSelector, { timeout: 15_000 });
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (/Pardon Our Interruption/i.test(bodyText)) {
        console.warn("Coles bot protection page detected; waiting and retrying once.");
        await delay(45_000 + Math.random() * 30_000);
        await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
        try {
          await page.waitForSelector(priceSelector, { timeout: 15_000 });
        } catch (retryError) {
          const retryBodyText = await page.locator("body").innerText().catch(() => "");
          if (/Pardon Our Interruption/i.test(retryBodyText)) {
            throw new Error("Coles bot protection page loaded before the product price could be read");
          }
          throw new ProductUnavailableError(
            `Price selector '${priceSelector}' not found after 15 seconds; product may be unavailable`
          );
        }
        const rawText = ((await page.locator(priceSelector).first().innerText()) ?? "").trim();
        const match = rawText.match(/[\d.]+/);
        if (!match) {
          throw new Error(`Could not parse a number from price text: ${rawText}`);
        }
        const rawPrice = rawText.replace(/Save\s*\$?[\d.]+.*$/i, "").replace("$", "").trim();
        return { rawPrice, currentPrice: Number(match[0]), imageUrl: null };
      }
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
  return { rawPrice, currentPrice: Number(match[0]), imageUrl: null };
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

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  try {
    const context = await browser.newContext({
      userAgent: requestHeaders["User-Agent"],
      locale: "en-AU",
      timezoneId: "Australia/Brisbane",
      viewport: { width: 1366, height: 768 }
    });
    const page = await context.newPage();

    for (const [index, item] of items.entries()) {
      console.info(`Scanning: ${item.name} - ${item.url}`);
      try {
        const { rawPrice, currentPrice, imageUrl } = await scrapePrice(page, item.url);
        await db.markItemAvailable(item.id);
        await db.recordPriceHistory(item.id, currentPrice, rawPrice);
        await db.updateItem(item.id, currentPrice);

        if (!item.path) {
          const scrapedImageUrl = imageUrl ?? (await scrapeImage(page));
          if (scrapedImageUrl) {
            const localPath = await downloadImage(scrapedImageUrl, item.id);
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
