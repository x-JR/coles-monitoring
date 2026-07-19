import { FormEvent, useEffect, useState, startTransition } from "react";
import {
  Activity,
  ArrowDownRight,
  CalendarClock,
  ExternalLink,
  History,
  KeyRound,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShoppingBasket,
  Sun,
  Target,
  Trash2,
  TrendingDown,
  X
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type SaleMode = "dropped" | "target" | "average";

interface Item {
  id: number;
  name: string;
  url: string;
  price: number;
  target_price: number | null;
  auto_pricing_enabled: boolean;
  path: string | null;
  unavailable: boolean;
  updated_at: string | null;
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  scan_count: number;
  latest_price: number | null;
  prev_price: number | null;
  auto_target: number | null;
  badge_lowest_price: boolean;
  badge_below_avg: boolean;
  badge_dropped: boolean;
  badge_below_target: boolean;
  badge_using_auto_target: boolean;
  is_pending: boolean;
  can_manage: boolean;
  owner_visitor_id?: string | null;
}

interface PriceHistoryPoint {
  price: number;
  raw_price: string;
  scanned_at: string;
}

interface SalePrediction {
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

type View =
  | { name: "dashboard" }
  | { name: "admin" }
  | { name: "add" }
  | { name: "sale"; mode: SaleMode }
  | { name: "item"; id: number };

type Theme = "light" | "dark";

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : `$${Number(value).toFixed(2)}`;

const effectiveTarget = (item: Item) => item.target_price ?? (item.auto_pricing_enabled ? item.auto_target : null);
const storeTimeZone = "Australia/Brisbane";

const dateTime = (value: string | null | undefined) => {
  if (!value) return "Never";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: storeTimeZone,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((datePart) => datePart.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}${part("dayPeriod").toUpperCase()}`;
};

const longDateTime = (value: string | null | undefined) => {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: storeTimeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(value));
};

const dateOnly = (value: string | null | undefined) => {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: storeTimeZone,
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
};

function parseView(): View {
  const path = window.location.pathname;
  if (path === "/admin") return { name: "admin" };
  if (path === "/add") return { name: "add" };
  if (path === "/on-sale") {
    const mode = new URLSearchParams(window.location.search).get("mode");
    return { name: "sale", mode: mode === "target" || mode === "average" ? mode : "dropped" };
  }
  const itemMatch = path.match(/^\/item\/(\d+)$/);
  if (itemMatch) return { name: "item", id: Number(itemMatch[1]) };
  return { name: "dashboard" };
}

function useView() {
  const [view, setView] = useState<View>(() => parseView());
  useEffect(() => {
    const onPopState = () => setView(parseView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (href: string) => {
    window.history.pushState(null, "", href);
    startTransition(() => setView(parseView()));
  };

  return { view, navigate };
}

function readCookie(name: string): string | null {
  const cookie = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : null;
}

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function getInitialTheme(): Theme {
  return readCookie("coles_monitor_theme") === "dark" ? "dark" : "light";
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeCookie("coles_monitor_theme", theme);
  }, [theme]);

  return { theme, setTheme };
}

function useVisitorId() {
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [visitorLoaded, setVisitorLoaded] = useState(false);

  async function loadVisitorId() {
    const response = await fetch("/api/visitor");
    const data = await response.json();
    setVisitorId(data.visitor_id);
    setIsAdmin(Boolean(data.is_admin));
    setVisitorLoaded(true);
  }

  useEffect(() => {
    loadVisitorId().catch(console.error);
  }, []);

  async function overwriteVisitorId(nextVisitorId: string): Promise<string> {
    const response = await fetch("/api/visitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor_id: nextVisitorId })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? "Unable to update visitor ID.");
    }
    const data = await response.json();
    setVisitorId(data.visitor_id);
    setIsAdmin(Boolean(data.is_admin));
    return data.visitor_id;
  }

  return { visitorId, isAdmin, visitorLoaded, overwriteVisitorId };
}

function Badge({ children, tone }: { children: string; tone: "green" | "amber" | "blue" | "red" | "gray" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function AppShell({ children, navigate, theme, visitorId, isAdmin, onToggleTheme, onOverwriteVisitorId }: { children: React.ReactNode; navigate: (href: string) => void; theme: Theme; visitorId: string | null; isAdmin: boolean; onToggleTheme: () => void; onOverwriteVisitorId: (visitorId: string) => Promise<string> }) {
  const shortVisitorId = visitorId ? visitorId.slice(0, 8) : "loading";
  const [visitorPanelOpen, setVisitorPanelOpen] = useState(false);
  const [visitorDraft, setVisitorDraft] = useState("");
  const [visitorError, setVisitorError] = useState<string | null>(null);
  const [savingVisitorId, setSavingVisitorId] = useState(false);

  function openVisitorPanel() {
    setVisitorDraft(visitorId ?? "");
    setVisitorError(null);
    setVisitorPanelOpen((open) => !open);
  }

  async function submitVisitorId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextVisitorId = visitorDraft.trim();
    if (!nextVisitorId || nextVisitorId === visitorId) {
      setVisitorPanelOpen(false);
      return;
    }

    setSavingVisitorId(true);
    setVisitorError(null);
    try {
      await onOverwriteVisitorId(nextVisitorId);
      window.location.reload();
    } catch (error) {
      setVisitorError(error instanceof Error ? error.message : "Unable to update visitor ID.");
      setSavingVisitorId(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={() => navigate("/")}>
          <ShoppingBasket size={24} />
          <span>Coles Monitor</span>
        </button>
        <nav>
          <button onClick={() => navigate("/")}>Dashboard</button>
          <button onClick={() => navigate("/on-sale")}>On Sale</button>
          {isAdmin ? <button onClick={() => navigate("/admin")}>Admin</button> : null}
          <button className="nav-primary" onClick={() => navigate("/add")}>
            <Plus size={16} /> Add Item
          </button>
          <div className="visitor-menu">
            <button className="visitor-button" onClick={openVisitorPanel} title={visitorId ?? "Visitor ID loading"} aria-expanded={visitorPanelOpen}>
              <KeyRound size={16} /> {shortVisitorId}
            </button>
            {visitorPanelOpen ? (
              <form className="visitor-popover" onSubmit={submitVisitorId}>
                <label>Visitor ID<input value={visitorDraft} onChange={(event) => setVisitorDraft(event.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" /></label>
                {visitorError ? <p>{visitorError}</p> : null}
                <div className="actions left">
                  <button className="button primary" disabled={savingVisitorId}>{savingVisitorId ? "Saving..." : "Save ID"}</button>
                  <button type="button" className="button ghost" onClick={() => setVisitorPanelOpen(false)}>Cancel</button>
                </div>
              </form>
            ) : null}
          </div>
          <button className="icon-button" onClick={onToggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </nav>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

function ItemStatus({ item }: { item: Item }) {
  if (item.unavailable) return <Badge tone="red">Unavailable</Badge>;
  if (item.is_pending) return <Badge tone="gray">Pending</Badge>;
  if (item.badge_lowest_price) return <Badge tone="green">Lowest Price</Badge>;
  if (item.badge_below_avg) return <Badge tone="blue">Special</Badge>;
  if (item.badge_dropped) return <Badge tone="green">Price Dropped</Badge>;
  if (item.badge_below_target) return <Badge tone="amber">Below Target</Badge>;
  return <Badge tone="gray">Normal</Badge>;
}

function Dashboard({ navigate, isAdmin }: { navigate: (href: string) => void; isAdmin: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");

  const load = async () => {
    const response = await fetch("/api/items");
    const data = await response.json();
    setItems(data.items);
    setLoading(false);
  };

  useEffect(() => {
    load().catch(console.error);
  }, []);

  const filtered = items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  const saleCount = items.filter((item) => item.badge_dropped || item.badge_below_avg || item.badge_below_target).length;

  async function syncAll() {
    setSyncing(true);
    await fetch("/api/sync-all", { method: "POST" });
  }

  return (
    <section>
      <div className="hero-panel">
        <div>
          <p className="eyebrow">Live grocery watchlist</p>
          <h1>Tracked Items</h1>
          <p className="subtle">{items.length} products watched, {saleCount} currently flagged.</p>
        </div>
        <div className="actions">
          {isAdmin ? (
            <button className="button ghost" onClick={syncAll} disabled={syncing}>
              <RefreshCw size={16} className={syncing ? "spin" : ""} /> {syncing ? "Sync queued" : "Sync All"}
            </button>
          ) : null}
          <button className="button primary" onClick={() => navigate("/add")}>
            <Plus size={16} /> Add Item
          </button>
        </div>
      </div>

      <div className="toolbar">
        <Search size={18} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tracked products" />
      </div>

      {loading ? <div className="empty">Loading products...</div> : null}
      {!loading && filtered.length === 0 ? <div className="empty">No items tracked yet.</div> : null}

      {filtered.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Current</th>
                <th>Target</th>
                <th>Lowest</th>
                <th>Last scanned</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id} onClick={() => navigate(`/item/${item.id}`)}>
                  <td>{item.path ? <img className="thumb" src={item.path} alt="" /> : <div className="thumb placeholder" />}</td>
                  <td><strong>{item.name}</strong></td>
                  <td>{item.is_pending ? <span className="muted">-</span> : <strong>{money(item.price)}</strong>}</td>
                  <td>
                    {effectiveTarget(item) ? money(effectiveTarget(item)) : <span className="muted">{item.auto_pricing_enabled ? "collecting" : "off"}</span>}
                  </td>
                  <td>{item.scan_count > 0 ? money(item.min_price) : <span className="muted">-</span>}</td>
                  <td>{item.is_pending ? <span className="muted">Pending first scan</span> : dateTime(item.updated_at)}</td>
                  <td><ItemStatus item={item} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function AddItem({ navigate }: { navigate: (href: string) => void }) {
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setErrors([]);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form))
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setErrors(data.errors ?? [data.error ?? "Unable to add item."]);
      return;
    }
    navigate("/");
  }

  return (
    <section className="form-page">
      <div>
        <p className="eyebrow">New watch item</p>
        <h1>Add Tracked Item</h1>
      </div>
      {errors.length > 0 ? <div className="error-box">{errors.map((error) => <p key={error}>{error}</p>)}</div> : null}
      <form className="panel form" onSubmit={submit}>
        <label>Product Name<input name="name" placeholder="Coles Full Cream Milk 2L" required /></label>
        <label>Coles Product URL<input name="url" type="url" placeholder="https://www.coles.com.au/product/..." required /></label>
        <label>Target Price<input name="target_price" type="number" step="0.01" min="0.01" placeholder="3.50" /></label>
        <div className="actions left">
          <button className="button primary" disabled={saving}>{saving ? "Adding..." : "Add & Scan Now"}</button>
          <button type="button" className="button ghost" onClick={() => navigate("/")}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

function OnSale({ mode, navigate }: { mode: SaleMode; navigate: (href: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    fetch(`/api/on-sale?mode=${mode}`).then((response) => response.json()).then((data) => setItems(data.items)).catch(console.error);
  }, [mode]);

  return (
    <section>
      <div className="section-head">
        <div><p className="eyebrow">Sale filters</p><h1>On Sale</h1></div>
        <div className="segmented">
          <button className={mode === "dropped" ? "active" : ""} onClick={() => navigate("/on-sale?mode=dropped")}>Dropped</button>
          <button className={mode === "target" ? "active" : ""} onClick={() => navigate("/on-sale?mode=target")}>Target</button>
          <button className={mode === "average" ? "active" : ""} onClick={() => navigate("/on-sale?mode=average")}>Average</button>
        </div>
      </div>
      {items.length === 0 ? <div className="empty">No items match this filter.</div> : null}
      <div className="cards-grid">
        {items.map((item) => (
          <article className="product-card" key={item.id}>
            {item.path ? <img src={item.path} alt="" /> : <div className="product-image-placeholder" />}
            <div>
              <h2>{item.name}</h2>
              <p className="price">{money(item.price)}</p>
              <p className="muted">
                {mode === "dropped" && item.prev_price ? `Was ${money(item.prev_price)}` : null}
                {mode === "target" ? `Target ${money(effectiveTarget(item))}` : null}
                {mode === "average" ? `Average ${money(item.avg_price)}` : null}
              </p>
            </div>
            <div className="card-actions">
              <button className="button ghost" onClick={() => navigate(`/item/${item.id}`)}><History size={16} /> History</button>
              <a className="button ghost" href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Coles</a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Admin({ navigate }: { navigate: (href: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editAutoPricingEnabled, setEditAutoPricingEnabled] = useState(true);

  async function loadItems() {
    setLoading(true);
    setError(null);
    const response = await fetch("/api/admin/items");
    setLoading(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error ?? "Unable to load admin items.");
      return;
    }
    const data = await response.json();
    setItems(data.items);
  }

  useEffect(() => {
    loadItems().catch(console.error);
  }, []);

  async function deleteItem(item: Item) {
    if (!window.confirm(`Delete ${item.name}?`)) return;
    setDeletingId(item.id);
    setError(null);
    const response = await fetch(`/api/admin/items/${item.id}`, { method: "DELETE" });
    setDeletingId(null);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error ?? "Unable to delete item.");
      return;
    }
    setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
  }

  function startEditing(item: Item) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditAutoPricingEnabled(item.auto_pricing_enabled);
    setError(null);
  }

  function stopEditing() {
    setEditingId(null);
    setEditName("");
    setEditAutoPricingEnabled(true);
  }

  async function saveItem(item: Item) {
    setSavingId(item.id);
    setError(null);
    const response = await fetch(`/api/admin/items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, auto_pricing_enabled: editAutoPricingEnabled })
    });
    setSavingId(null);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError((data.errors ?? [data.error ?? "Unable to update item."]).join(" "));
      return;
    }
    setItems((current) => current.map((currentItem) => currentItem.id === item.id ? data.item : currentItem));
    stopEditing();
  }

  return (
    <section>
      <div className="section-head">
        <div><p className="eyebrow">Admin tools</p><h1>Manage Items</h1></div>
      </div>

      {error ? <div className="error-box admin-message">{error}</div> : null}
      {loading ? <div className="empty admin-message">Loading admin items...</div> : null}
      {!loading && !error && items.length === 0 ? <div className="empty admin-message">No tracked items found.</div> : null}

      {items.length > 0 ? (
        <div className="table-wrap admin-table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Current</th>
                <th>Auto Pricing</th>
                <th>Owner</th>
                <th>Last scanned</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isEditing = editingId === item.id;
                return (
                <tr key={item.id}>
                  <td>
                    {isEditing ? (
                      <input className="table-input" value={editName} onChange={(event) => setEditName(event.target.value)} aria-label={`Name for ${item.name}`} />
                    ) : (
                      <button className="row-link" onClick={() => navigate(`/item/${item.id}`)}>{item.name}</button>
                    )}
                  </td>
                  <td>{item.is_pending ? <span className="muted">-</span> : <strong>{money(item.price)}</strong>}</td>
                  <td>
                    {isEditing ? (
                      <label className="switch-label">
                        <input type="checkbox" checked={editAutoPricingEnabled} onChange={(event) => setEditAutoPricingEnabled(event.target.checked)} />
                        <span>{editAutoPricingEnabled ? "Enabled" : "Disabled"}</span>
                      </label>
                    ) : (
                      <Badge tone={item.auto_pricing_enabled ? "green" : "gray"}>{item.auto_pricing_enabled ? "Enabled" : "Disabled"}</Badge>
                    )}
                  </td>
                  <td><span className="mono">{item.owner_visitor_id ?? "shared"}</span></td>
                  <td>{item.is_pending ? <span className="muted">Pending first scan</span> : dateTime(item.updated_at)}</td>
                  <td>
                    <div className="table-actions">
                      {isEditing ? (
                        <>
                          <button className="button primary" onClick={() => saveItem(item)} disabled={savingId === item.id}>
                            <Save size={16} /> {savingId === item.id ? "Saving..." : "Save"}
                          </button>
                          <button className="button ghost" onClick={stopEditing} disabled={savingId === item.id}>
                            <X size={16} /> Cancel
                          </button>
                        </>
                      ) : (
                        <button className="button ghost" onClick={() => startEditing(item)}>
                          <Pencil size={16} /> Edit
                        </button>
                      )}
                      <button className="button danger" onClick={() => deleteItem(item)} disabled={deletingId === item.id || savingId === item.id}>
                        <Trash2 size={16} /> {deletingId === item.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function ItemDetail({ id, navigate }: { id: number; navigate: (href: string) => void }) {
  const [item, setItem] = useState<Item | null>(null);
  const [history, setHistory] = useState<PriceHistoryPoint[]>([]);
  const [salePrediction, setSalePrediction] = useState<SalePrediction | null>(null);
  const [days, setDays] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/items/${id}`).then((response) => response.json()).then((data) => {
      setItem(data.item);
      setHistory(data.history);
      setSalePrediction(data.sale_prediction ?? null);
    }).catch(console.error);
  }, [id]);

  if (!item) return <div className="empty">Loading item...</div>;

  const filteredHistory = days === 0 ? history : history.filter((point) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return new Date(point.scanned_at) >= cutoff;
  });
  const chartData = filteredHistory.map((point) => ({ ...point, label: longDateTime(point.scanned_at) }));

  async function deleteItem() {
    if (!item || !window.confirm(`Delete ${item.name}?`)) return;
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error ?? "Unable to delete item.");
      return;
    }
    navigate("/");
  }

  return (
    <section>
      <button className="text-button" onClick={() => navigate("/")}>Back to dashboard</button>
      <div className="detail-head">
        <div className="detail-title">
          {item.path ? <img src={item.path} alt="" /> : null}
          <div>
            <h1>{item.name}</h1>
            <a href={item.url} target="_blank" rel="noreferrer">View on Coles <ExternalLink size={14} /></a>
          </div>
        </div>
        <div className="current-price">
          <span>{item.unavailable ? "Unavailable" : item.is_pending ? "Pending" : money(item.price)}</span>
          {item.unavailable ? <small>Last known {money(item.price)}</small> : null}
        </div>
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      {item.can_manage ? (
        <div className="actions left detail-actions">
          <button className="button danger" onClick={deleteItem} disabled={deleting}>
            <Trash2 size={16} /> {deleting ? "Deleting..." : "Delete Item"}
          </button>
        </div>
      ) : null}

      <div className="stats-grid">
        <Stat icon={<Target />} label="Target Price" value={money(effectiveTarget(item))} />
        <Stat icon={<Activity />} label="Average Price" value={item.scan_count > 0 ? money(item.avg_price) : "-"} />
        <Stat icon={<TrendingDown />} label="Total Scans" value={String(item.scan_count)} />
        <Stat icon={<CalendarClock />} label="Last Scanned" value={item.is_pending ? "Never" : dateTime(item.updated_at)} />
      </div>

      <div className="badge-row">
        {item.unavailable ? <Badge tone="red">Unavailable</Badge> : null}
        {item.badge_dropped ? <Badge tone="green">Price Dropped</Badge> : null}
        {item.badge_below_target ? <Badge tone="amber">Below Target</Badge> : null}
        {item.badge_below_avg ? <Badge tone="blue">Below Average</Badge> : null}
      </div>

      {salePrediction ? <SalePredictionPanel prediction={salePrediction} /> : null}

      {history.length > 0 ? (
        <div className="panel chart-panel">
          <div className="section-head compact">
            <h2>Price History</h2>
            <div className="segmented">
              {[7, 30, 365, 0].map((range) => (
                <button key={range} className={days === range ? "active" : ""} onClick={() => setDays(range)}>
                  {range === 0 ? "All" : range === 7 ? "Week" : range === 30 ? "Month" : "Year"}
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={340}>
            <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
              <defs><linearGradient id="priceFill" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="var(--chart-line)" stopOpacity={0.32} /><stop offset="95%" stopColor="var(--chart-line)" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--chart-axis)" }} tickLine={{ stroke: "var(--chart-grid)" }} axisLine={{ stroke: "var(--chart-grid)" }} minTickGap={24} />
              <YAxis tick={{ fontSize: 12, fill: "var(--chart-axis)" }} tickLine={{ stroke: "var(--chart-grid)" }} axisLine={{ stroke: "var(--chart-grid)" }} tickFormatter={(value) => `$${Number(value).toFixed(2)}`} width={70} />
              <Tooltip formatter={(value) => money(Number(value))} cursor={{ stroke: "var(--chart-axis)", strokeWidth: 1 }} contentStyle={{ background: "var(--chart-tooltip-bg)", border: "1px solid var(--chart-tooltip-border)", borderRadius: 8, color: "var(--chart-tooltip-label)", boxShadow: "var(--shadow)" }} labelStyle={{ color: "var(--chart-tooltip-label)" }} itemStyle={{ color: "var(--chart-line)" }} />
              <Area type="monotone" dataKey="price" stroke="var(--chart-line)" fill="url(#priceFill)" strokeWidth={3} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : <div className="empty">No price history recorded yet.</div>}
    </section>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="stat">{icon}<span>{label}</span><strong>{value}</strong></div>;
}

function SalePredictionPanel({ prediction }: { prediction: SalePrediction }) {
  if (prediction.status === "insufficient_history") {
    return (
      <div className="panel prediction-panel muted-panel">
        <CalendarClock size={22} />
        <div>
          <h2>Sale Pattern</h2>
          <p>Collecting more scans before forecasting this product.</p>
        </div>
      </div>
    );
  }

  if (prediction.status === "no_cycle") {
    return (
      <div className="panel prediction-panel muted-panel">
        <CalendarClock size={22} />
        <div>
          <h2>Sale Pattern</h2>
          <p>No repeating sale cycle is clear from the recorded prices yet.</p>
        </div>
      </div>
    );
  }

  const headline = prediction.current_sale
    ? "This looks like a sale window now"
    : prediction.days_until_next_sale === 0
      ? "Likely sale window is due now"
      : `Next likely sale in ${prediction.days_until_next_sale} days`;

  return (
    <div className="panel prediction-panel">
      <div className="prediction-icon"><CalendarClock size={24} /></div>
      <div className="prediction-copy">
        <div className="section-head compact">
          <div>
            <p className="eyebrow">Sale forecast</p>
            <h2>{headline}</h2>
          </div>
          {prediction.confidence ? <Badge tone={prediction.confidence === "high" ? "green" : prediction.confidence === "medium" ? "blue" : "amber"}>{`${prediction.confidence} confidence`}</Badge> : null}
        </div>
        <div className="prediction-grid">
          <span><strong>{dateOnly(prediction.next_sale_start)}</strong><small>Next likely start</small></span>
          <span><strong>{prediction.cycle_days} days</strong><small>Typical cycle</small></span>
          <span><strong>{prediction.sale_duration_days} days</strong><small>Typical sale length</small></span>
          <span><strong>{money(prediction.typical_sale_price)}</strong><small>Typical sale price</small></span>
        </div>
        <p className="prediction-note">
          Based on {prediction.observed_sale_windows} previous sale windows below about {money(prediction.sale_threshold)}.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const { view, navigate } = useView();
  const { theme, setTheme } = useTheme();
  const { visitorId, isAdmin, visitorLoaded, overwriteVisitorId } = useVisitorId();

  useEffect(() => {
    if (visitorLoaded && view.name === "admin" && !isAdmin) {
      navigate("/");
    }
  }, [isAdmin, navigate, view.name, visitorLoaded]);

  return (
    <AppShell navigate={navigate} theme={theme} visitorId={visitorId} isAdmin={isAdmin} onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")} onOverwriteVisitorId={overwriteVisitorId}>
      {view.name === "dashboard" ? <Dashboard navigate={navigate} isAdmin={isAdmin} /> : null}
      {view.name === "admin" && isAdmin ? <Admin navigate={navigate} /> : null}
      {view.name === "add" ? <AddItem navigate={navigate} /> : null}
      {view.name === "sale" ? <OnSale mode={view.mode} navigate={navigate} /> : null}
      {view.name === "item" ? <ItemDetail id={view.id} navigate={navigate} /> : null}
    </AppShell>
  );
}
