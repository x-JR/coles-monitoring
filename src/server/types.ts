export type SaleMode = "dropped" | "target" | "average";

export interface ItemRow {
  id: number;
  name: string;
  url: string;
  price: number | string;
  target_price: number | string | null;
  path: string | null;
  unavailable: number | boolean;
  updated_at: Date | string | null;
  avg_price?: number | string | null;
  min_price?: number | string | null;
  max_price?: number | string | null;
  scan_count?: number | string | null;
  latest_price?: number | null;
  prev_price?: number | null;
  auto_target?: number | null;
  badge_lowest_price?: boolean;
  badge_below_avg?: boolean;
  badge_dropped?: boolean;
  badge_below_target?: boolean;
  badge_using_auto_target?: boolean;
  is_pending?: boolean;
}

export interface PriceHistoryRow {
  price: number;
  raw_price: string;
  scanned_at: string;
}
