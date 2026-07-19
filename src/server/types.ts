export type SaleMode = "dropped" | "target" | "average";

export interface ItemRow {
  id: number;
  name: string;
  url: string;
  price: number | string;
  target_price: number | string | null;
  auto_pricing_enabled: number | boolean;
  path: string | null;
  owner_visitor_id?: string | null;
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
  can_manage?: boolean;
}

export interface PriceHistoryRow {
  price: number;
  raw_price: string;
  scanned_at: string;
}

export interface SalePrediction {
  status: "insufficient_history" | "no_cycle" | "predictable";
  sale_threshold: number | null;
  typical_sale_price: number | null;
  typical_regular_price: number | null;
  cycle_days: number | null;
  sale_duration_days: number | null;
  next_sale_start: string | null;
  next_sale_end: string | null;
  confidence: "low" | "medium" | "high" | null;
  observed_sale_windows: number;
  interval_days: number[];
  current_sale: boolean;
  days_until_next_sale: number | null;
}
