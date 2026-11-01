import { useState } from "react";
import type { ActivityItem, ActivityPage, Colleague } from "../../../licensing-worker/src/portal/api-types";
import { api, query } from "../api";
import { dateTime } from "../format";
import { Link } from "../router";
import { EmptyRow, LoadError, PageHead, Person, useData, useRun } from "../ui";

const KINDS: Record<string, string> = { customer: "Customers", order: "Orders", installation: "Counters", invoice: "Invoices", payment: "Payments",
  lead: "Leads", followup: "Follow-ups", ticket: "Tickets", user: "Staff", settings: "Settings" };

/** Where an activity row's record lives in the portal, when it has a page. */
export function recordLink(item: Pick<ActivityItem, "entityType" | "entityId" | "customer">): string | null {
  switch (item.entityType) {
    case "customer": return `/customers/${item.entityId}`;
    case "order": return `/orders/${item.entityId}`;
    case "lead": return `/leads/${item.entityId}`;
    case "ticket": return `/tickets/${item.entityId}`;
    case "installation": case "invoice": case "payment": return item.customer ? `/customers/${item.customer.id}` : null;
    default: return null;
  }
}

export function Activity() {
  const [actorId, setActorId] = useState("");
  const [entityType, setEntityType] = useState("");
  const filters = query({ actorId: actorId === "system" ? null : actorId, system: actorId === "system", entityType });
  const { data, error, reload, setData } = useData(() => api<ActivityPage>(`/activity${filters}`), filters);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const more = useRun();
  return <>
    <PageHead title="Activity" sub="Every change made in the portal, by a payment or by a counter activating, newest first." />
    <div className="toolbar">
      <select aria-label="Who" value={actorId} onChange={(e) => setActorId(e.target.value)} style={{ width: 220 }}>
        <option value="">Everyone</option><option value="system">MasalaPOS (automatic)</option>
        {staff.data?.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <select aria-label="What" value={entityType} onChange={(e) => setEntityType(e.target.value)} style={{ width: 200 }}>
        <option value="">Every kind of record</option>{Object.entries(KINDS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </div>
    {error && <LoadError message={error} retry={reload} />}
    <ActivityTable entries={data?.entries ?? []} loaded={!!data} />
    {data?.nextBefore && <div className="more"><button className="secondary" disabled={more.busy} onClick={() => void more.run(async () => {
      const page = await api<ActivityPage>(`/activity${query({ actorId: actorId === "system" ? null : actorId, system: actorId === "system", entityType, before: data.nextBefore })}`);
      setData({ entries: [...data.entries, ...page.entries], nextBefore: page.nextBefore });
    })}>Load older changes</button></div>}
    {more.status}
  </>;
}

export function ActivityTable({ entries, loaded, compact }: { entries: ActivityItem[]; loaded: boolean; compact?: boolean }) {
  return <div className="table-wrap"><table className="data stack-phone">
    <thead><tr><th>What happened</th>{!compact && <th className="phone-hide">Customer</th>}<th>Who</th><th className="num">When</th></tr></thead>
    <tbody>
      {entries.map((e) => {
        const to = recordLink(e);
        return <tr key={e.id}>
          <td>{to ? <Link className="name" to={to}>{e.summary}</Link> : e.summary}</td>
          {!compact && <td className="phone-hide muted">{e.customer ? <Link to={`/customers/${e.customer.id}`}>{e.customer.name}</Link> : "—"}</td>}
          <td>{e.actor ? <Person name={e.actor.name} id={e.actor.id} /> : <span className="muted">MasalaPOS</span>}</td>
          <td className="num muted">{dateTime(e.at)}</td>
        </tr>;
      })}
      {loaded && entries.length === 0 && <EmptyRow columns={compact ? 3 : 4}>Nothing recorded yet.</EmptyRow>}
    </tbody>
  </table></div>;
}
