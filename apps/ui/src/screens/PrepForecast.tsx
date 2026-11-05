import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PrepForecast } from "@masalapos/domain";
import { apiFetch } from "../api";
import { prepDayChoices, prepSheet, type PrepSheet } from "../prep-forecast";
import "../prep-forecast.css";

const MARGINS = [0, 10, 20];
const amount = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/** The forecast's tables; shown on screen and again, alone, on the printed sheet. */
function PrepTables({ forecast, sheet }: { forecast: PrepForecast; sheet: PrepSheet }) {
  const day = weekday(forecast.date);
  return <>
    <section aria-labelledby="prep-dishes-title"><h3 id="prep-dishes-title">Dishes to prep</h3>
      {!sheet.categories.length ? <p className="muted">No dish sold on at least 2 of the last {forecast.basedOn.length} {day}s.</p> : <table className="prep-table">
        <thead><tr><th scope="col">Dish</th><th scope="col">Expected plates</th><th scope="col">Last {forecast.basedOn.length} {day}s</th></tr></thead>
        {sheet.categories.map((group) => <tbody key={group.category}>
          <tr className="prep-category"><th scope="rowgroup" colSpan={3}>{group.category}</th></tr>
          {group.dishes.map((dish) => <tr key={dish.name}><th scope="row">{dish.name}</th><td>{dish.plates}</td><td className="muted">{dish.days.join(" · ")}</td></tr>)}
        </tbody>)}
      </table>}
    </section>
    <section aria-labelledby="prep-ingredients-title"><h3 id="prep-ingredients-title">Ingredients needed</h3>
      {!sheet.ingredients.length ? <p className="muted">No ingredients: the expected dishes have no stock links.</p> : <table className="prep-table">
        <thead><tr><th scope="col">Stock item</th><th scope="col">Need</th><th scope="col">In stock</th><th scope="col">Buy</th></tr></thead>
        <tbody>{sheet.ingredients.map((item) => <tr key={item.name} className={item.buy > 0 ? "prep-buy" : ""}>
          <th scope="row">{item.name}</th><td>{amount(item.need)} {item.unit}</td><td>{amount(item.onHand)} {item.unit}</td>
          <td>{item.buy > 0 ? <strong>{amount(item.buy)} {item.unit}</strong> : "Enough"}</td></tr>)}</tbody>
      </table>}
      {forecast.unlinkedDishes.length > 0 && <p className="muted">{forecast.unlinkedDishes.length} dish{forecast.unlinkedDishes.length === 1 ? " has" : "es have"} no recipe, so {forecast.unlinkedDishes.length === 1 ? "its" : "their"} ingredients are not counted: {forecast.unlinkedDishes.join(", ")}.</p>}
    </section>
  </>;
}

/**
 * Inventory → Prep forecast: expected plates for a day (tomorrow by default) from the same weekday in the last 4 weeks,
 * and the ingredients they need against stock on hand. Print gives a clean sheet for the kitchen.
 */
export function PrepForecastPanel({ refresh }: { refresh: number }) {
  const days = prepDayChoices(localToday());
  const [date, setDate] = useState(days[1]!.value);
  const [margin, setMargin] = useState(0);
  const [forecast, setForecast] = useState<PrepForecast | null>(null);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    let active = true;
    setError("");
    apiFetch<{ forecast: PrepForecast }>(`/api/prep-forecast?date=${date}`)
      .then((r) => { if (active) setForecast(r.forecast); })
      .catch((e: unknown) => { if (active) { setForecast(null); setError(e instanceof Error ? e.message : "Could not load the prep forecast"); } });
    return () => { active = false; };
  }, [date, refresh]);

  useEffect(() => {
    if (!printing) return;
    const done = () => { document.body.classList.remove("printing-prep"); setPrinting(false); };
    document.body.classList.add("printing-prep");
    window.addEventListener("afterprint", done, { once: true });
    try { window.print(); } catch { done(); }
    return () => window.removeEventListener("afterprint", done);
  }, [printing]);

  const sheet = forecast?.date === date ? prepSheet(forecast, margin) : null;
  const label = days.find((d) => d.value === date)?.label ?? date;
  const basis = forecast && forecast.date === date && forecast.basedOn.length
    ? `Based on the last ${forecast.basedOn.length} ${weekday(date)}s: ${forecast.basedOn.map(shortDay).join(", ")}${margin ? ` · plus ${margin}% safety margin` : ""}.`
    : `Not enough sales history yet: the forecast needs bills on a past ${weekday(date)}.`;
  return <div className="prep-forecast">
    <div className="prep-controls">
      <label>Day<select value={date} onChange={(e) => setDate(e.target.value)}>{days.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</select></label>
      <label>Safety margin<select value={margin} onChange={(e) => setMargin(Number(e.target.value))}>{MARGINS.map((m) => <option key={m} value={m}>{m ? `+${m}%` : "None"}</option>)}</select></label>
      <button type="button" disabled={!sheet || printing} onClick={() => setPrinting(true)}>Print</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {forecast && sheet && <>
      <p className="prep-basis" role="status">{basis}</p>
      <PrepTables forecast={forecast} sheet={sheet} />
      {printing && createPortal(<div className="prep-print-sheet"><h1>Prep list · {label.replace(/^(Today|Tomorrow) · /, "")}</h1><p>{basis}</p><PrepTables forecast={forecast} sheet={sheet} /></div>, document.body)}
    </>}
  </div>;
}
