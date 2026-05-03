import logging
import os
import re
import sys
from datetime import datetime, timezone

import pymysql
import requests
from dotenv import load_dotenv
from playwright.sync_api import Page, sync_playwright
from playwright_stealth import Stealth

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_HOST = os.environ["DB_HOST"]
DB_PORT = int(os.environ.get("DB_PORT", 3306))
DB_USER = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]
DB_NAME = os.environ["DB_NAME"]
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", 2))  # Number of items to scan per run

DISCORD_WEBHOOK_URL = os.environ["DISCORD_WEBHOOK_URL"]

# Matches the N8N browser headers used in "Check Prices"
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

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------


def get_connection() -> pymysql.Connection:
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )


def fetch_items(conn: pymysql.Connection) -> list[dict]:
    """
    Return up to BATCH_SIZE items that have not been scanned in the last 48 hours,
    ordered oldest-scanned first — mirroring the Sort + Limit +
    Filter Recently Scanned nodes in N8N.
    """
    sql = """
        SELECT id, name, url, price, last_recorded_price, updated_at
        FROM   coles_monitor
        WHERE  updated_at < NOW() - INTERVAL 48 HOUR
        ORDER  BY updated_at ASC
        LIMIT  %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (BATCH_SIZE,))
        return cur.fetchall()


def update_item(
    conn: pymysql.Connection,
    item_id: int,
    price_float: float,
    raw_price: str,
) -> None:
    """Update the stored price and scan timestamp for an item."""
    sql = """
        UPDATE coles_monitor
        SET    price               = %s,
               last_recorded_price = %s,
               updated_at          = NOW()
        WHERE  id = %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (price_float, raw_price, item_id))
    conn.commit()


def record_price_history(
    conn: pymysql.Connection,
    item_id: int,
    price_float: float,
    raw_price: str,
) -> None:
    """Append a row to price_history for every successful scrape."""
    sql = """
        INSERT INTO price_history (item_id, price, raw_price)
        VALUES (%s, %s, %s)
    """
    with conn.cursor() as cur:
        cur.execute(sql, (item_id, price_float, raw_price))
    conn.commit()


# ---------------------------------------------------------------------------
# Scraping
# ---------------------------------------------------------------------------


def scrape_price(page: Page, url: str) -> tuple[str, float]:
    """
    Navigate *page* to *url* and extract the price using CSS selector ".price".

    Returns a (raw_text, float_price) tuple.
    Raises RuntimeError if the price cannot be found or parsed.
    """
    page.goto(url, timeout=30000, wait_until="domcontentloaded")
    # Wait for the price element to appear after JS renders
    page.wait_for_selector(PRICE_CSS_SELECTOR, timeout=15000)

    element = page.query_selector(PRICE_CSS_SELECTOR)
    if element is None:
        raise RuntimeError(f"Price element '{PRICE_CSS_SELECTOR}' not found on page")

    raw_text = (element.inner_text() or "").strip()
    match = re.search(r"[\d.]+", raw_text)
    if match is None:
        raise RuntimeError(f"Could not parse a number from price text: {raw_text!r}")

    # Strip leading '$' and any trailing 'Save …' fragment (e.g. '$7.20Save $4.80' → '7.20')
    clean_price = re.sub(r"Save\s*\$?[\d.]+.*$", "", raw_text, flags=re.IGNORECASE).replace("$", "").strip()

    return clean_price, float(match.group(0))


# ---------------------------------------------------------------------------
# Discord notifications
# ---------------------------------------------------------------------------


def _post_embed(embed: dict) -> None:
    payload = {"embeds": [embed]}
    resp = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=10)
    resp.raise_for_status()


def send_discord_price_drop(item: dict, current_price: float) -> None:
    """Send a green embed when the current price is below the stored price."""
    embed = {
        "author": {"name": "Coles Monitoring"},
        "title": item["name"],
        "url": item["url"],
        "description": (
            f"{item['name']} is less than ${item['price']:.2f}.\n\n"
            f"Currently ${current_price:.2f}"
        ),
        "color": 0x1BB513,
    }
    _post_embed(embed)
    log.info("Price-drop alert sent for '%s' ($%.2f)", item["name"], current_price)


def send_discord_failure(item: dict, error: str) -> None:
    """Send a red embed when the HTTP request for an item fails."""
    embed = {
        "author": {"name": "Coles Monitoring"},
        "title": f"Failure: Coles Scan - {item['name']}",
        "url": item["url"],
        "description": error,
        "color": 0xFF0000,
    }
    _post_embed(embed)
    log.warning("Failure alert sent for '%s': %s", item["name"], error)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    log.info("Coles monitoring run started at %s", datetime.now(timezone.utc).isoformat())

    conn = get_connection()
    try:
        items = fetch_items(conn)
        if not items:
            log.info("No items due for scanning.")
            return

        log.info("Scanning %d item(s).", len(items))

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

            for item in items:
                log.info("Processing: %s — %s", item["name"], item["url"])
                try:
                    raw_price, current_price = scrape_price(page, item["url"])
                except Exception as exc:
                    log.error("Scrape failed for '%s': %s", item["name"], exc)
                    try:
                        send_discord_failure(item, str(exc))
                    except Exception as discord_exc:
                        log.error("Discord failure notification also failed: %s", discord_exc)
                    # Still update updated_at so we don't hammer a broken URL every run
                    update_item(conn, item["id"], float(item["price"]), item.get("last_recorded_price") or "")
                    continue

                stored_price = float(item["price"])
                log.info(
                    "'%s': stored=%.2f  current=%.2f  raw=%r",
                    item["name"],
                    stored_price,
                    current_price,
                    raw_price,
                )

                if current_price < stored_price:
                    try:
                        send_discord_price_drop(item, current_price)
                    except Exception as discord_exc:
                        log.error("Discord price-drop notification failed: %s", discord_exc)

                record_price_history(conn, item["id"], current_price, raw_price)
                update_item(conn, item["id"], current_price, raw_price)

            browser.close()

    finally:
        conn.close()

    log.info("Run complete.")


if __name__ == "__main__":
    main()
