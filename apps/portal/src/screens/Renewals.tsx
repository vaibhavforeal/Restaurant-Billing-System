import { useState } from "react";
import type { RenewalRow, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { PLAN_NAMES, roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, query } from "../api";
import { date, daysFromToday, inDays, plural, relativeDay } from "../format";
import { Link, navigate } from "../router";
import { EmptyRow, LoadError, PageHead, Person, Pill, Tabs, useData } from "../ui";
import { counterName } from "./Counter";
import { AddFollowUp } from "./FollowUps";

type Window = "7" | "30" | "60" | "expired" | "trials";

/** Counters whose licence ends soon, with what is already in hand (a renewal order, a follow-up) and the next step one click away. */
export function Renewals({ me }: { me: StaffUser }) {
  const [window, setWindow] = useState<Window>("30");
  const { data, error, reload } = useData(() => api<{ renewals: RenewalRow[]; counts: Record<Window, number> }>(`/renewals${query({ window })}`), window);
  const [following, setFollowing] = useState<RenewalRow | null>(null);
  const counts = data?.counts;
  const rows = data?.renewals ?? [];
  const handled = rows.filter((r) => r.openRenewal).length;
  const canOrder = roleCan(me.role, "orders.write"), canFollow = roleCan(me.role, "followups.write");
  return <>
    <PageHead title="Renewals" sub={counts ? `${plural(counts["30"], "counter")} end in the next 30 days; ${plural(counts.expired, "counter")} already ended in the last 90 days.` : "Loading renewals…"} />
    <Tabs label="When" value={window} onChange={setWindow} tabs={[
      { id: "7", label: <>Next 7 days<span className="count">{counts?.["7"] ?? ""}</span></> }, { id: "30", label: <>Next 30 days<span className="count">{counts?.["30"] ?? ""}</span></> },
      { id: "60", label: <>Next 60 days<span className="count">{counts?.["60"] ?? ""}</span></> }, { id: "expired", label: <>Ended<span className="count">{counts?.expired ?? ""}</span></> },
      { id: "trials", label: <>Trials<span className="count">{counts?.trials ?? ""}</span></> },
    ]} />
    {data && rows.length > 0 && <p className="muted" style={{ marginBottom: 12 }}>{handled ? `${handled} of ${rows.length} already have a renewal order.` : "None of these has a renewal order yet."}</p>}
    {error && <LoadError message={error} retry={reload} />}
    <div className="table-wrap"><table className="data stack-phone">
      <thead><tr><th>Counter</th><th className="phone-hide">Plan</th><th className="phone-hide">Rep</th><th className="phone-hide">In hand</th><th className="num">Ends</th><th className="num phone-hide"></th></tr></thead>
      <tbody>
        {rows.map((r) => { const l = r.installation.licence!; const days = daysFromToday(l.expiresAt);
          return <tr key={r.installation.id}>
            <td><Link className="name" to={`/customers/${r.customer.id}`}>{r.customer.name}</Link><span className="sub">{counterName(r.installation)}</span></td>
            <td className="phone-hide">{PLAN_NAMES[l.plan]}{l.trial ? " trial" : ""}<span className="sub">{l.maxDevices} devices</span></td>
            <td className="phone-hide">{r.customer.owner ? <Person name={r.customer.owner.name} id={r.customer.owner.id} /> : <span className="muted">Not assigned</span>}</td>
            <td className="phone-hide">{r.openRenewal ? <Link className="mono" to={`/orders/${r.openRenewal.id}`}>{r.openRenewal.code}</Link> : r.nextFollowUpAt ? <span className="muted">Follow-up {relativeDay(r.nextFollowUpAt).toLowerCase()}</span> : <span className="muted">Nothing yet</span>}</td>
            <td className="num">{days < 0 ? <Pill tone="negative">Ended {date(l.expiresAt)}</Pill> : days <= 7 ? <Pill tone="warning">{date(l.expiresAt)}</Pill> : date(l.expiresAt)}<span className="sub">{inDays(l.expiresAt)}</span></td>
            <td className="num phone-hide"><div className="actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
              {canFollow && <button className="ghost small" onClick={() => setFollowing(r)}>Follow up</button>}
              {canOrder && !r.openRenewal && !l.trial && <button className="secondary small" onClick={() => navigate(`/orders/new${query({ customerId: r.customer.id, kind: "renewal", installations: r.installation.id })}`)}>Renewal order</button>}
              {canOrder && l.trial && <button className="secondary small" onClick={() => navigate(`/orders/new${query({ customerId: r.customer.id })}`)}>Paid order</button>}
            </div></td>
          </tr>; })}
        {data && rows.length === 0 && <EmptyRow columns={6}>{window === "expired" ? "No licence has ended in the last 90 days." : window === "trials" ? "No trials running." : "No licence ends in this window."}</EmptyRow>}
      </tbody>
    </table></div>
    {following && <AddFollowUp about={{ customerId: following.customer.id }} me={me} kind="renewal" onClose={() => setFollowing(null)} onSaved={() => { setFollowing(null); void reload(); }} />}
  </>;
}
