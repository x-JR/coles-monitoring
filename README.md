# Coles Price Monitor

A self-hosted web app that tracks product prices on [Coles](https://www.coles.com.au), sends Discord alerts on price drops, and displays price history graphs.

## Features

- Dashboard showing all tracked items with current price, badges, and thumbnails
- **On Sale** page with three filter modes: Price Dropped, Below Target, Below Average
- Per-item price history graph (Chart.js)
- Add new items via the web UI — triggers an immediate scrape
- Manual **Sync All** button to kick off a full scan on demand
- Hourly background scanner (APScheduler) with random inter-item delays to reduce detection
- Product images downloaded and served locally
- Discord webhook notifications on price drops or scrape failures

## Stack

- **FastAPI** + Jinja2 templates + Bootstrap 5
- **Playwright** (Chromium, headless) for scraping
- **APScheduler** for the background scan schedule
- **MySQL / MariaDB** for item and price history storage
- Docker + Docker Compose for deployment

## Requirements

- Docker & Docker Compose
- A MySQL / MariaDB instance accessible from the container
- A Discord webhook URL

## Setup

### 1. Database

Run `init.sql` once against your database:

```bash
mysql -u <user> -p <database> < init.sql
```

If you are migrating an existing install, see the `ALTER TABLE` comments at the top of `init.sql`.

### 2. Environment variables

Copy the example below to a `.env` file in the project root:

```env
DB_HOST=your-db-host
DB_PORT=3306
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_NAME=your-db-name
BATCH_SIZE=5
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### 3. Run with Docker Compose

```bash
docker compose up -d
```

The app is available at `http://localhost:8000`.

Product images are persisted to `./static/images/` on the host via a bind mount and survive container rebuilds.

### 4. Run locally (development)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
uvicorn app:app --reload
```

## CI / CD

Pushing to `main` triggers the GitHub Actions workflow (`.github/workflows/docker-image.yml`) which builds and pushes the Docker image to Docker Hub under `ultimatedl/coles-monitoring`.

## Project structure

```
app.py               FastAPI application, routes, lifespan
db.py                Database helpers
scanner.py           Playwright scraping logic
scheduler.py         APScheduler setup
discord_notify.py    Discord webhook helpers
templates/           Jinja2 HTML templates
static/
  style.css
  images/            Downloaded product images (git-ignored)
init.sql             Database schema
Dockerfile
docker-compose.yml
```
