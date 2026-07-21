import "dotenv/config";
import type { ItemRow } from "./types";

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

async function postEmbed(embed: Record<string, unknown>): Promise<void> {
  if (!webhookUrl) {
    console.warn("DISCORD_WEBHOOK_URL is not set; skipping Discord notification.");
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
  }
}

const dashboardUrl = "https://coles.tekkie.com.au";

export async function sendDiscordDailySummary(items: ItemRow[]): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const blocks = items.map((item) => {
    const price = Number(item.price);
    const highest = item.max_price ? Number(item.max_price) : null;
    const discountPct = highest && highest > price ? Math.round((1 - price / highest) * 100) : null;

    const priceLine =
      discountPct !== null
        ? `**$${price.toFixed(2)}** ~~$${highest!.toFixed(2)}~~ · 🔻 **${discountPct}% off** highest`
        : `**$${price.toFixed(2)}**`;

    const reasons: string[] = [];
    if (item.target_price && price < Number(item.target_price)) {
      reasons.push(`below target $${Number(item.target_price).toFixed(2)}`);
    }
    if (item.avg_price && price < Number(item.avg_price)) {
      reasons.push(`below avg $${Number(item.avg_price).toFixed(2)}`);
    }
    const reason = reasons.length > 0 ? reasons.join(", ") : "on sale";

    return `**[${item.name}](${item.url})**\n${priceLine}\n_${reason}_`;
  });

  await postEmbed({
    author: { name: "Coles Monitoring", url: dashboardUrl },
    title: "🛒 Daily Sale Summary",
    url: dashboardUrl,
    description: blocks.join("\n\n"),
    color: 0x1bb513,
    footer: { text: "coles.tekkie.com.au" },
    timestamp: new Date().toISOString()
  });
}

export async function sendDiscordFailure(item: ItemRow, error: string): Promise<void> {
  await postEmbed({
    author: { name: "Coles Monitoring", url: dashboardUrl },
    title: `⚠️ Failure: Coles Scan - ${item.name}`,
    url: item.url,
    description: error,
    color: 0xff0000,
    footer: { text: "coles.tekkie.com.au" },
    timestamp: new Date().toISOString()
  });
}
