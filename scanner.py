import logging
import mimetypes
import os
import random
import re
import time

import requests
from dotenv import load_dotenv
from playwright.sync_api import Page, sync_playwright
from playwright_stealth import Stealth

import db
import discord_notify

load_dotenv()

log = logging.getLogger(__name__)

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) "
        "Gecko/20100101 Firefox/89.0"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}

PRICE_CSS_SELECTOR = ".price"
IMAGE_CSS_SELECTOR = "[class*='coles-targeting-StylesProductDetailStylesStyledZoomBtn'] img"


def scrape_price(page: Page, url: str) -> tuple[str, float]:
    """Navigate to url and return (raw_text, float_price). Raises RuntimeError on failure."""
    page.goto(url, timeout=30_000, wait_until="domcontentloaded")
    page.wait_for_selector(PRICE_CSS_SELECTOR, timeout=15_000)

    element = page.query_selector(PRICE_CSS_SELECTOR)
    if element is None:
        raise RuntimeError(f"Price element '{PRICE_CSS_SELECTOR}' not found on page")

    raw_text = (element.inner_text() or "").strip()
    match = re.search(r"[\d.]+", raw_text)
    if match is None:
        raise RuntimeError(f"Could not parse a number from price text: {raw_text!r}")

    clean_price = (
        re.sub(r"Save\s*\$?[\d.]+.*$", "", raw_text, flags=re.IGNORECASE)
        .replace("$", "")
        .strip()
    )
    return clean_price, float(match.group(0))


def scrape_image(page: Page) -> str | None:
    """Return the src of the first product image on the already-loaded page, or None."""
    try:
        log.info("Attempting image scrape with selector: %s", IMAGE_CSS_SELECTOR)
        element = page.query_selector(IMAGE_CSS_SELECTOR)
        if element is None:
            log.warning("Image element not found — selector '%s' matched nothing", IMAGE_CSS_SELECTOR)
            return None
        log.info("Image element found, reading src attributes")
        src = element.get_attribute("src") or element.get_attribute("data-src")
        if src:
            log.info("Image src resolved: %s", src.strip())
        else:
            log.warning("Image element found but both src and data-src are empty")
        return src.strip() if src else None
    except Exception as exc:
        log.warning("Image scrape raised an exception: %s", exc)
        return None


def _download_image(url: str, item_id: int) -> str | None:
    """Download the image at url, save to static/images/, return the web path or None."""
    images_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "images")
    os.makedirs(images_dir, exist_ok=True)
    log.info("Downloading image for item %d from: %s", item_id, url)

    try:
        resp = requests.get(
            url,
            timeout=10,
            headers={"User-Agent": REQUEST_HEADERS["User-Agent"]},
        )
        log.info("Image request status %d for item %d", resp.status_code, item_id)
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "").split(";")[0].strip()
        log.info("Image content-type: %s  size: %d bytes", content_type, len(resp.content))
        ext = mimetypes.guess_extension(content_type) or ".jpg"
        if ext in (".jpe", ".jpeg"):
            ext = ".jpg"

        filename = f"item_{item_id}{ext}"
        filepath = os.path.join(images_dir, filename)
        with open(filepath, "wb") as f:
            f.write(resp.content)

        log.info("Image saved to %s", filepath)
        return f"/static/images/{filename}"
    except Exception as exc:
        log.warning("Image download failed for item %d: %s", item_id, exc)
        return None


def run_scan_for_items(items: list[dict]) -> None:
    """Scan a list of items in a single Playwright session."""
    if not items:
        return

    conn = db.get_connection()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=REQUEST_HEADERS["User-Agent"],
                extra_http_headers={
                    k: v for k, v in REQUEST_HEADERS.items() if k != "User-Agent"
                },
            )
            page = context.new_page()
            Stealth().apply_stealth_sync(page)

            for idx, item in enumerate(items):
                log.info("Scanning: %s — %s", item["name"], item["url"])
                try:
                    raw_price, current_price = scrape_price(page, item["url"])
                except Exception as exc:
                    log.error("Scrape failed for '%s': %s", item["name"], exc)
                    try:
                        discord_notify.send_discord_failure(item, str(exc))
                    except Exception as dn_exc:
                        log.error("Discord failure notification failed: %s", dn_exc)
                    db.update_item(conn, item["id"], float(item["price"]))
                else:
                    stored_price = float(item["price"])
                    log.info(
                        "'%s': stored=%.2f  current=%.2f  raw=%r",
                        item["name"],
                        stored_price,
                        current_price,
                        raw_price,
                    )

                    # Only alert on a genuine price drop (not on first scan where stored=0.00)
                    if stored_price > 0 and current_price < stored_price:
                        try:
                            discord_notify.send_discord_price_drop(item, current_price)
                        except Exception as dn_exc:
                            log.error("Discord price-drop notification failed: %s", dn_exc)

                    db.record_price_history(conn, item["id"], current_price, raw_price)
                    db.update_item(conn, item["id"], current_price)

                    # Scrape and download the product image once — skip if already stored
                    if not item.get("path"):
                        log.info("No image stored for '%s', attempting scrape", item["name"])
                        img_src = scrape_image(page)
                        if img_src:
                            local_path = _download_image(img_src, item["id"])
                            if local_path:
                                db.update_item_image(conn, item["id"], local_path)
                                log.info("Image path stored in DB for '%s': %s", item["name"], local_path)
                            else:
                                log.warning("Image download returned None for '%s'", item["name"])
                        else:
                            log.warning("No image src found on page for '%s'", item["name"])
                    else:
                        log.info("Image already stored for '%s', skipping", item["name"])

                # Random delay between items to reduce automation detection
                if idx < len(items) - 1:
                    delay = random.uniform(3.0, 10.0)
                    log.info("Waiting %.1fs before next item...", delay)
                    time.sleep(delay)

            browser.close()
    finally:
        conn.close()


def scan_single_item(item_id: int) -> None:
    """Immediately scan a single item by ID (used when a new item is added)."""
    conn = db.get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, url, price, path, updated_at "
                "FROM coles_monitor WHERE id = %s",
                (item_id,),
            )
            item = cur.fetchone()
    finally:
        conn.close()

    if item is None:
        log.warning("scan_single_item: item %d not found", item_id)
        return

    run_scan_for_items([item])
