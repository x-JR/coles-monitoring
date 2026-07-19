# Coles Price Monitor

A self-hosted web app that tracks product prices on [Coles](https://www.coles.com.au), sends Discord alerts on price drops, and displays price history graphs.

## Features

- Dashboard showing all tracked items with current price, badges, and thumbnails
- **On Sale** page with three filter modes: Price Dropped, Below Target, Below Average
- Per-item price history graph
- Add new items via the web UI — triggers an immediate scrape
- Manual **Sync All** button to kick off a full scan on demand
- Daily background scanner with random inter-item delays to reduce detection
- Product images downloaded and served locally
- Discord webhook notifications on price drops or scrape failures

## Stack

- **React** + **Vite** + TypeScript for the web UI
- **Express** + TypeScript for API routes
- **mysql2** for MySQL / MariaDB access
- **Playwright** (Chromium, headless) for scraping
- **node-cron** for the background scan schedule
- **Recharts** for price history graphs

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

### 4. Run locally

```bash
npm install
npm run playwright:install
npm run dev
```

The React app runs at `http://localhost:5173` and proxies API requests to the Express server at `http://localhost:8000`.

Build and serve the TypeScript app:

```bash
npm run build
npm start
```

The production server is available at `http://localhost:8000`.

## Project structure

```
src/server/          TypeScript Express API, DB, scanner, scheduler, Discord helpers
src/client/          React/Vite frontend
static/
  images/            Downloaded product images
init.sql             Database schema
Dockerfile
docker-compose.yml
```
