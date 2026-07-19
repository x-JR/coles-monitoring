import { FormEvent, useEffect, useState, startTransition } from "react";
import {
  Activity,
  ArrowDownRight,
  CalendarClock,
  ExternalLink,
  History,
  Plus,
  RefreshCw,
  Search,
  ShoppingBasket,
  Target,
  TrendingDown
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
}

interface PriceHistoryPoint {
  price: number;
  raw_price: string;
  scanned_at: string;
}

type View =
  | { name: "dashboard" }
  | { name: "add" }
  | { name: "sale"; mode: SaleMode }
  | { name: "item"; id: number };

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : `$${Number(value).toFixed(2)}`;

const dateTime = (value: string | null | undefined) => {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
};

function parseView(): View {
  const path = window.location.pathname;
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

function Badge({ children, tone }: { children: string; tone: "green" | "amber" | "blue" | "red" | "gray" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function AppShell({ children, navigate }: { children: React.ReactNode; navigate: (href: string) => void }) {
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
          <button className="nav-primary" onClick={() => navigate("/add")}>
            <Plus size={16} /> Add Item
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

function Dashboard({ navigate }: { navigate: (href: string) => void }) {
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
          <button className="button ghost" onClick={syncAll} disabled={syncing}>
            <RefreshCw size={16} className={syncing ? "spin" : ""} /> {syncing ? "Sync queued" : "Sync All"}
          </button>
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
                    {item.target_price ? money(item.target_price) : item.auto_target ? money(item.auto_target) : <span className="muted">collecting</span>}
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
                {mode === "target" ? `Target ${money(item.target_price ?? item.auto_target)}` : null}
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

function ItemDetail({ id, navigate }: { id: number; navigate: (href: string) => void }) {
  const [item, setItem] = useState<Item | null>(null);
  const [history, setHistory] = useState<PriceHistoryPoint[]>([]);
  const [days, setDays] = useState(0);

  useEffect(() => {
    fetch(`/api/items/${id}`).then((response) => response.json()).then((data) => {
      setItem(data.item);
      setHistory(data.history);
    }).catch(console.error);
  }, [id]);

  if (!item) return <div className="empty">Loading item...</div>;

  const filteredHistory = days === 0 ? history : history.filter((point) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return new Date(point.scanned_at) >= cutoff;
  });
  const chartData = filteredHistory.map((point) => ({ ...point, label: dateTime(point.scanned_at) }));

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

      <div className="stats-grid">
        <Stat icon={<Target />} label="Target Price" value={money(item.target_price ?? item.auto_target)} />
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
              <defs><linearGradient id="priceFill" x1="0" x2="0" y1="0" y2="1"><stop offset="5%" stopColor="#138a52" stopOpacity={0.28} /><stop offset="95%" stopColor="#138a52" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />
              <YAxis tickFormatter={(value) => `$${Number(value).toFixed(2)}`} width={70} />
              <Tooltip formatter={(value) => money(Number(value))} />
              <Area type="monotone" dataKey="price" stroke="#138a52" fill="url(#priceFill)" strokeWidth={3} />
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

export function App() {
  const { view, navigate } = useView();
  return (
    <AppShell navigate={navigate}>
      {view.name === "dashboard" ? <Dashboard navigate={navigate} /> : null}
      {view.name === "add" ? <AddItem navigate={navigate} /> : null}
      {view.name === "sale" ? <OnSale mode={view.mode} navigate={navigate} /> : null}
      {view.name === "item" ? <ItemDetail id={view.id} navigate={navigate} /> : null}
    </AppShell>
  );
}
