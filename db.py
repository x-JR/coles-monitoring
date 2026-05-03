import os

import pymysql
from dotenv import load_dotenv

load_dotenv()

DB_HOST = os.environ["DB_HOST"]
DB_PORT = int(os.environ.get("DB_PORT", 3306))
DB_USER = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]
DB_NAME = os.environ["DB_NAME"]
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", 2))


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
    """Return up to BATCH_SIZE items not scanned in the last 48 hours (for scheduler)."""
    sql = """
        SELECT id, name, url, price, path, updated_at
        FROM   coles_monitor
        WHERE  updated_at < NOW() - INTERVAL 48 HOUR
        ORDER  BY updated_at ASC
        LIMIT  %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (BATCH_SIZE,))
        return cur.fetchall()


def fetch_all_items_for_scan(conn: pymysql.Connection) -> list[dict]:
    """Return all tracked items for a manual full sync."""
    sql = """
        SELECT id, name, url, price, path, updated_at
        FROM   coles_monitor
        ORDER  BY updated_at ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        return cur.fetchall()


def fetch_sale_items(conn: pymysql.Connection) -> list[dict]:
    """Return items where the current price is below target_price or historical average."""
    sql = """
        SELECT cm.id, cm.name, cm.url, cm.price, cm.target_price,
               ph.avg_price
        FROM coles_monitor cm
        LEFT JOIN (
            SELECT item_id, AVG(price) AS avg_price
            FROM price_history
            GROUP BY item_id
        ) ph ON ph.item_id = cm.id
        WHERE (cm.target_price IS NOT NULL AND cm.price < cm.target_price)
           OR (ph.avg_price IS NOT NULL AND cm.price < ph.avg_price)
        ORDER BY cm.name ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        return cur.fetchall()


def fetch_all_items(conn: pymysql.Connection) -> list[dict]:
    """Return all tracked items with avg price and scan count for dashboard display."""
    sql = """
        SELECT cm.*,
               COALESCE(ph.avg_price, cm.price) AS avg_price,
               COALESCE(ph.scan_count, 0)       AS scan_count
        FROM coles_monitor cm
        LEFT JOIN (
            SELECT item_id, AVG(price) AS avg_price, COUNT(*) AS scan_count
            FROM price_history
            GROUP BY item_id
        ) ph ON ph.item_id = cm.id
        ORDER BY cm.name ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql)
        items = cur.fetchall()

    if not items:
        return []

    # Fetch the 2 most recent price_history rows per item in a single query.
    # The correlated COUNT gives rn-style ranking without window functions.
    item_ids = [row["id"] for row in items]
    placeholders = ",".join(["%s"] * len(item_ids))
    sql_recent = f"""
        SELECT ph.item_id, ph.price
        FROM price_history ph
        WHERE ph.item_id IN ({placeholders})
          AND (
              SELECT COUNT(*) FROM price_history ph2
              WHERE ph2.item_id = ph.item_id AND ph2.id >= ph.id
          ) <= 2
        ORDER BY ph.item_id, ph.id DESC
    """
    with conn.cursor() as cur:
        cur.execute(sql_recent, item_ids)
        recent_rows = cur.fetchall()

    # Build {item_id: [latest_price, prev_price]}
    recent: dict[int, list] = {}
    for row in recent_rows:
        iid = row["item_id"]
        if iid not in recent:
            recent[iid] = []
        recent[iid].append(float(row["price"]))

    for item in items:
        prices = recent.get(item["id"], [])
        item["latest_price"] = prices[0] if len(prices) >= 1 else None
        item["prev_price"] = prices[1] if len(prices) >= 2 else None
        _attach_badges(item)

    return items


def _attach_badges(row: dict) -> None:
    """Attach boolean badge flags and is_pending to an item dict (mutates in place)."""
    price = float(row["price"] or 0)
    target = float(row["target_price"]) if row.get("target_price") else None
    avg = float(row["avg_price"]) if row.get("avg_price") else None
    latest = row.get("latest_price")
    prev = row.get("prev_price")

    row["badge_dropped"] = latest is not None and prev is not None and latest < prev
    row["badge_below_target"] = target is not None and price < target
    row["badge_below_avg"] = avg is not None and price < avg

    updated_at = row.get("updated_at")
    if updated_at is None:
        row["is_pending"] = True
    elif hasattr(updated_at, "year"):
        row["is_pending"] = updated_at.year < 2001
    else:
        row["is_pending"] = str(updated_at).startswith("2000")


def fetch_item_by_id(conn: pymysql.Connection, item_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM coles_monitor WHERE id = %s", (item_id,))
        row = cur.fetchone()
    if row is None:
        return None

    with conn.cursor() as cur:
        cur.execute(
            "SELECT AVG(price) AS avg_price, COUNT(*) AS scan_count "
            "FROM price_history WHERE item_id = %s",
            (item_id,),
        )
        stats = cur.fetchone()

    row["avg_price"] = stats["avg_price"]
    row["scan_count"] = int(stats["scan_count"] or 0)

    with conn.cursor() as cur:
        cur.execute(
            "SELECT price FROM price_history WHERE item_id = %s "
            "ORDER BY scanned_at DESC LIMIT 2",
            (item_id,),
        )
        recent = cur.fetchall()

    row["latest_price"] = float(recent[0]["price"]) if len(recent) >= 1 else None
    row["prev_price"] = float(recent[1]["price"]) if len(recent) >= 2 else None
    _attach_badges(row)
    return row


def add_item(conn: pymysql.Connection, name: str, url: str, target_price: float | None) -> int:
    sql = """
        INSERT INTO coles_monitor (name, url, price, target_price, path)
        VALUES (%s, %s, 0.00, %s, NULL)
    """
    with conn.cursor() as cur:
        cur.execute(sql, (name, url, target_price))
        new_id = cur.lastrowid
    conn.commit()
    return new_id


def update_item(
    conn: pymysql.Connection,
    item_id: int,
    price_float: float,
) -> None:
    sql = """
        UPDATE coles_monitor
        SET    price      = %s,
               updated_at = NOW()
        WHERE  id = %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (price_float, item_id))
    conn.commit()


def update_item_image(
    conn: pymysql.Connection,
    item_id: int,
    path: str,
) -> None:
    sql = "UPDATE coles_monitor SET path = %s WHERE id = %s"
    with conn.cursor() as cur:
        cur.execute(sql, (path, item_id))
    conn.commit()


def record_price_history(
    conn: pymysql.Connection,
    item_id: int,
    price_float: float,
    raw_price: str,
) -> None:
    sql = """
        INSERT INTO price_history (item_id, price, raw_price)
        VALUES (%s, %s, %s)
    """
    with conn.cursor() as cur:
        cur.execute(sql, (item_id, price_float, raw_price))
    conn.commit()


def fetch_price_history_for_item(conn: pymysql.Connection, item_id: int) -> list[dict]:
    sql = """
        SELECT price, raw_price, scanned_at
        FROM price_history
        WHERE item_id = %s
        ORDER BY scanned_at ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql, (item_id,))
        rows = cur.fetchall()

    return [
        {
            "price": float(row["price"]),
            "raw_price": row["raw_price"],
            "scanned_at": (
                row["scanned_at"].isoformat()
                if hasattr(row["scanned_at"], "isoformat")
                else str(row["scanned_at"])
            ),
        }
        for row in rows
    ]
