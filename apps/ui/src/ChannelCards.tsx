import { Icon, type IconName } from "./Icon";
import type { ChannelCard, channelCards } from "./dashboard-data";
import { reportMoney } from "./sales-report";

const orders = (count: number) => `${count} ${count === 1 ? "Order" : "Orders"}`;

/** Total Sales, Dine In and Takeaway (and Zomato when Zomato is on) for the selected day. `cards` is null until the first load. */
export function ChannelCards({ cards }: { cards: ReturnType<typeof channelCards> | null }) {
  const list: Array<{ key: string; label: string; icon: IconName; card: ChannelCard | undefined }> = [
    { key: "total", label: "Total Sales", icon: "reports", card: cards?.total },
    { key: "dine-in", label: "Dine In", icon: "tables", card: cards?.dineIn },
    { key: "takeaway", label: "Takeaway", icon: "bag", card: cards?.takeaway },
    ...(cards?.zomato ? [{ key: "zomato", label: "Zomato", icon: "marketplace" as const, card: cards.zomato }] : []),
  ];
  return <div className="dash-channels" aria-label="Sales by channel">
    {list.map(({ key, label, icon, card }) => <section key={key} className={`dash-channel dash-channel-${key}`} aria-label={label}>
      <header><h3>{label}</h3><span className="dash-channel-icon" aria-hidden="true"><Icon name={icon} size={18} /></span></header>
      <strong className="dash-channel-amount">{card ? reportMoney(card.amountPaise) : "—"}</strong>
      <small>{card ? orders(card.orderCount) : "—"}</small>
    </section>)}
  </div>;
}
