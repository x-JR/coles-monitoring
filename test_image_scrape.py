"""
Quick test script: scrape and download the first product image from one or more
Coles product URLs, saving them to test_images/ for visual confirmation.

Usage:
    python test_image_scrape.py <url> [<url2> ...]
    python test_image_scrape.py  # prompts for URLs interactively (one per line)
"""

import logging
import mimetypes
import os
import re
import sys

import requests
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
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
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_images")


def scrape_first_image(page) -> str | None:
    """Return the src of the first <img> on the already-loaded page, or None."""
    imgs = page.query_selector_all("img")
    if not imgs:
        log.warning("No <img> elements found on page")
        return None
    src = imgs[0].get_attribute("src") or imgs[0].get_attribute("data-src")
    return src.strip() if src else None


def download_image(src: str, index: int) -> str | None:
    """Download image at src, save to test_images/image_<index>.<ext>, return saved path."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    try:
        resp = requests.get(
            src,
            timeout=10,
            headers={"User-Agent": REQUEST_HEADERS["User-Agent"]},
        )
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type", "").split(";")[0].strip()
        ext = mimetypes.guess_extension(content_type) or ".jpg"
        if ext in (".jpe", ".jpeg"):
            ext = ".jpg"
        filename = f"image_{index:02d}{ext}"
        filepath = os.path.join(OUTPUT_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(resp.content)
        return filepath
    except Exception as exc:
        log.warning("Download failed: %s", exc)
        return None


def test_url(page, url: str, index: int) -> None:
    log.info("[%02d] Navigating to: %s", index, url)
    page.goto(url, timeout=30_000, wait_until="domcontentloaded")

    try:
        page.wait_for_selector(PRICE_CSS_SELECTOR, timeout=15_000)
        price_el = page.query_selector(PRICE_CSS_SELECTOR)
        price_text = price_el.inner_text().strip() if price_el else "(not found)"
        match = re.search(r"[\d.]+", price_text)
        price_val = f"${float(match.group(0)):.2f}" if match else "?"
        log.info("[%02d] Price: %s", index, price_val)
    except Exception as exc:
        log.warning("[%02d] Could not scrape price: %s", index, exc)

    src = scrape_first_image(page)
    if not src:
        log.warning("[%02d] RESULT: No image src found.", index)
        return

    log.info("[%02d] Image src: %s", index, src)
    saved = download_image(src, index)
    if saved:
        log.info("[%02d] RESULT: Saved → %s", index, saved)
    else:
        log.warning("[%02d] RESULT: Download failed.", index)


def main() -> None:
    urls = sys.argv[1:]
    if not urls:
        print("Enter Coles product URLs (one per line, blank line to finish):")
        while True:
            line = input().strip()
            if not line:
                break
            urls.append(line)
    if not urls:
        print("No URLs provided. Exiting.")
        sys.exit(1)

    log.info("Testing %d URL(s). Images will be saved to: %s", len(urls), OUTPUT_DIR)

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

        for i, url in enumerate(urls):
            print()
            print("=" * 60)
            test_url(page, url, i)
            print("=" * 60)

        browser.close()

    print(f"\nDone. Check '{OUTPUT_DIR}' for downloaded images.")


if __name__ == "__main__":
    main()
