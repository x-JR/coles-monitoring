import logging

from apscheduler.schedulers.background import BackgroundScheduler

import db
import discord_notify
import scanner

log = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()


def _hourly_scan_job() -> None:
    log.info("Scheduled hourly scan starting.")
    conn = db.get_connection()
    try:
        items = db.fetch_items(conn)
    finally:
        conn.close()
    scanner.run_scan_for_items(items)
    log.info("Scheduled hourly scan complete.")


def _daily_summary_job() -> None:
    log.info("Daily summary job starting.")
    conn = db.get_connection()
    try:
        items = db.fetch_sale_items(conn)
    finally:
        conn.close()
    if items:
        discord_notify.send_discord_daily_summary(items)
        log.info("Daily summary sent for %d item(s).", len(items))
    else:
        log.info("No sale items found; skipping daily summary.")


def start_scheduler() -> None:
    _scheduler.add_job(
        _hourly_scan_job,
        "interval",
        hours=1,
        id="hourly_scan",
        replace_existing=True,
    )
    _scheduler.add_job(
        _daily_summary_job,
        "cron",
        hour=8,
        minute=0,
        id="daily_summary",
        replace_existing=True,
    )
    _scheduler.start()
    log.info("APScheduler started (hourly scan job registered).")


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("APScheduler stopped.")


def trigger_item_scan(item_id: int) -> None:
    """Schedule an immediate one-shot scan for the given item (fires as soon as possible)."""
    _scheduler.add_job(
        scanner.scan_single_item,
        args=[item_id],
        id=f"immediate_scan_{item_id}",
        replace_existing=True,
        misfire_grace_time=60,
    )
    log.info("Immediate scan scheduled for item %d.", item_id)


def _full_scan_job() -> None:
    log.info("Manual full sync starting.")
    conn = db.get_connection()
    try:
        items = db.fetch_all_items_for_scan(conn)
    finally:
        conn.close()
    scanner.run_scan_for_items(items)
    log.info("Manual full sync complete.")


def trigger_full_scan() -> None:
    """Schedule an immediate one-shot scan of every tracked item."""
    _scheduler.add_job(
        _full_scan_job,
        id="manual_full_scan",
        replace_existing=True,
        misfire_grace_time=300,
    )
    log.info("Manual full sync scheduled.")
