import logging
import os

import requests
from dotenv import load_dotenv

load_dotenv()

DISCORD_WEBHOOK_URL = os.environ["DISCORD_WEBHOOK_URL"]
log = logging.getLogger(__name__)


def _post_embed(embed: dict) -> None:
    payload = {"embeds": [embed]}
    resp = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=10)
    resp.raise_for_status()


def send_discord_price_drop(item: dict, current_price: float) -> None:
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


def send_discord_daily_summary(items: list[dict]) -> None:
    if not items:
        return

    lines = []
    for item in items:
        price = float(item["price"])
        reasons = []
        if item.get("target_price") and price < float(item["target_price"]):
            reasons.append(f"below target ${float(item['target_price']):.2f}")
        if item.get("avg_price") and price < float(item["avg_price"]):
            reasons.append(f"below avg ${float(item['avg_price']):.2f}")
        reason_str = ", ".join(reasons) if reasons else "on sale"
        lines.append(f"[{item['name']}]({item['url']}) — **${price:.2f}** ({reason_str})")

    embed = {
        "author": {"name": "Coles Monitoring"},
        "title": "Daily Sale Summary",
        "description": "\n".join(lines),
        "color": 0x1BB513,
    }
    _post_embed(embed)
    log.info("Daily summary sent for %d item(s)", len(items))


def send_discord_failure(item: dict, error: str) -> None:
    embed = {
        "author": {"name": "Coles Monitoring"},
        "title": f"Failure: Coles Scan - {item['name']}",
        "url": item["url"],
        "description": error,
        "color": 0xFF0000,
    }
    _post_embed(embed)
    log.warning("Failure alert sent for '%s': %s", item["name"], error)
