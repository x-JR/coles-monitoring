import json
import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markupsafe import Markup

import db
import scheduler as sched

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    sched.start_scheduler()
    yield
    sched.stop_scheduler()


app = FastAPI(title="Coles Price Monitor", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ---------------------------------------------------------------------------
# Custom Jinja2 filters
# ---------------------------------------------------------------------------

def _money(value) -> str:
    if value is None:
        return "—"
    return f"${float(value):.2f}"


def _datefmt(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, datetime):
        return value.strftime("%d %b %Y %H:%M")
    return str(value)


def _tojson(value) -> Markup:
    """HTML-safe JSON serialisation for embedding in <script> tags."""
    raw = json.dumps(value, ensure_ascii=False, default=str)
    safe = raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return Markup(safe)


templates.env.filters["money"] = _money
templates.env.filters["datefmt"] = _datefmt
templates.env.filters["tojson"] = _tojson


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    conn = db.get_connection()
    try:
        items = db.fetch_all_items(conn)
    finally:
        conn.close()
    syncing = request.query_params.get("syncing") == "1"
    return templates.TemplateResponse(request, "index.html", {"items": items, "syncing": syncing})


@app.get("/on-sale", response_class=HTMLResponse)
def on_sale(request: Request, mode: str = "dropped"):
    if mode not in ("dropped", "target", "average"):
        mode = "dropped"

    conn = db.get_connection()
    try:
        all_items = db.fetch_all_items(conn)
    finally:
        conn.close()

    if mode == "dropped":
        items = [i for i in all_items if i["badge_dropped"]]
    elif mode == "target":
        items = [i for i in all_items if i["badge_below_target"]]
    else:
        items = [i for i in all_items if i["badge_below_avg"]]

    return templates.TemplateResponse(
        request, "on_sale.html", {"items": items, "mode": mode}
    )


@app.get("/item/{item_id}", response_class=HTMLResponse)
def item_detail(request: Request, item_id: int):
    conn = db.get_connection()
    try:
        item = db.fetch_item_by_id(conn, item_id)
        history = db.fetch_price_history_for_item(conn, item_id) if item else []
    finally:
        conn.close()

    if item is None:
        return HTMLResponse("Item not found.", status_code=404)

    return templates.TemplateResponse(
        request, "item.html", {"item": item, "history": history}
    )


@app.get("/add", response_class=HTMLResponse)
def add_form(request: Request):
    return templates.TemplateResponse(
        request, "add.html", {"errors": [], "name": "", "url": "", "target_price": ""}
    )


@app.post("/add")
def add_item(
    request: Request,
    name: str = Form(...),
    url: str = Form(...),
    target_price: str = Form(""),
):
    errors: list[str] = []
    name = name.strip()
    url = url.strip()

    if not name:
        errors.append("Name is required.")
    if not url.startswith("https://www.coles.com.au/"):
        errors.append("URL must be a Coles product URL starting with https://www.coles.com.au/.")

    target: float | None = None
    if target_price.strip():
        try:
            target = float(target_price.strip().lstrip("$"))
            if target <= 0:
                errors.append("Target price must be a positive number.")
        except ValueError:
            errors.append("Target price must be a valid number.")

    if errors:
        return templates.TemplateResponse(
            request,
            "add.html",
            {"errors": errors, "name": name, "url": url, "target_price": target_price},
            status_code=422,
        )

    conn = db.get_connection()
    try:
        new_id = db.add_item(conn, name, url, target)
    finally:
        conn.close()

    sched.trigger_item_scan(new_id)
    return RedirectResponse("/", status_code=303)


@app.post("/sync-all")
def sync_all():
    sched.trigger_full_scan()
    return RedirectResponse("/?syncing=1", status_code=303)
