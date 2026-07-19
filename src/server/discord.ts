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

export async function sendDiscordDailySummary(items: ItemRow[]): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const lines = items.map((item) => {
    const price = Number(item.price);
    const reasons: string[] = [];
    if (item.target_price && price < Number(item.target_price)) {
      reasons.push(`below target $${Number(item.target_price).toFixed(2)}`);
    }
    if (item.avg_price && price < Number(item.avg_price)) {
      reasons.push(`below avg $${Number(item.avg_price).toFixed(2)}`);
    }
    const reason = reasons.length > 0 ? reasons.join(", ") : "on sale";
    return `[${item.name}](${item.url}) - **$${price.toFixed(2)}** (${reason})`;
  });

  await postEmbed({
    author: { name: "Coles Monitoring" },
    title: "Daily Sale Summary",
    description: lines.join("\n"),
    color: 0x1bb513
  });
}

export async function sendDiscordFailure(item: ItemRow, error: string): Promise<void> {
  await postEmbed({
    author: { name: "Coles Monitoring" },
    title: `Failure: Coles Scan - ${item.name}`,
    url: item.url,
    description: error,
    color: 0xff0000
  });
}
