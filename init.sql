-- Run this once against your existing MariaDB/MySQL instance to create the monitoring tables.
-- Adjust the database name to match your environment.
--
-- EXISTING INSTALLATIONS: run the following ALTERs to migrate:
--   ALTER TABLE coles_monitor ADD COLUMN target_price DECIMAL(10,2) DEFAULT NULL
--       COMMENT 'Optional alert threshold; badge shown when price drops below this';
--   ALTER TABLE coles_monitor ADD COLUMN path TEXT DEFAULT NULL
--       COMMENT 'Product image URL scraped on first scan';
--   ALTER TABLE coles_monitor DROP COLUMN last_recorded_price;
--   ALTER TABLE coles_monitor ADD COLUMN unavailable TINYINT(1) NOT NULL DEFAULT 0
--       COMMENT 'Set to 1 when price selector is not found during a scan';

CREATE TABLE IF NOT EXISTS coles_monitor (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(255)   NOT NULL,
    url          TEXT           NOT NULL,
    price        DECIMAL(10, 2) NOT NULL           COMMENT 'Last known price (updated every scan)',
    target_price DECIMAL(10, 2) DEFAULT NULL       COMMENT 'Optional alert threshold; badge shown when price drops below this',
    path         TEXT           DEFAULT NULL       COMMENT 'Product image URL scraped on first scan',
    unavailable  TINYINT(1)     NOT NULL DEFAULT 0  COMMENT 'Set to 1 when price selector is not found during a scan',
    updated_at   DATETIME       NOT NULL
                     DEFAULT '2000-01-01 00:00:00' COMMENT 'Set to old date so new rows are scanned immediately'
);

-- Price history: one row per successful scan, never updated
CREATE TABLE IF NOT EXISTS price_history (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    item_id     INT             NOT NULL,
    price       DECIMAL(10, 2)  NOT NULL    COMMENT 'Parsed numeric price',
    raw_price   VARCHAR(50)     NOT NULL    COMMENT 'Raw price string as scraped e.g. $3.50',
    scanned_at  DATETIME        NOT NULL    DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_price_history_item FOREIGN KEY (item_id)
        REFERENCES coles_monitor (id)
        ON DELETE CASCADE
);

-- Example row:
-- INSERT INTO coles_monitor (name, url, price)
-- VALUES ('Coles Milk 2L', 'https://www.coles.com.au/product/coles-fresh-milk-2l-123456', 3.50);
