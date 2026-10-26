import { customReportProblem, customReportSource, filterOpsFor, isNumericField, type CustomFilterOp, type CustomReportConfigValue } from "@forkflow/domain/custom-reports";

/** What the builder edits. Filter values stay as text while typing; money is typed in rupees and saved in paise. */
export interface CustomDraft {
  source: string;
  columns: Array<{ field: string; label: string }>;
  filters: Array<{ field: string; op: CustomFilterOp; text: string }>;
  groupBy: string[];
  sort: { field: string; dir: "asc" | "desc" } | null;
}

const DEFAULTS: Record<string, { columns: string[]; groupBy: string[] }> = {
  bills: { columns: ["date", "bills", "subtotal", "discount", "gst", "total"], groupBy: ["date"] },
  bill_items: { columns: ["item", "category", "qty", "total"], groupBy: ["item", "category"] },
  payments: { columns: ["mode", "payments", "amount"], groupBy: ["mode"] },
  customers: { columns: ["name", "phone", "visits", "spend", "pointsBalance"], groupBy: [] },
};

export function newDraft(source: string): CustomDraft {
  const d = DEFAULTS[source] ?? { columns: [], groupBy: [] };
  return { source, columns: d.columns.map((field) => ({ field, label: "" })), filters: [], groupBy: [...d.groupBy], sort: null };
}

/** The draft as a definition the server accepts, or the reason it cannot be one yet. */
export function draftToConfig(draft: CustomDraft): { config: CustomReportConfigValue } | { problem: string } {
  const source = customReportSource(draft.source);
  if (!source) return { problem: "Choose a data source" };
  if (!draft.columns.length) return { problem: "Pick at least one column" };
  const filters: CustomReportConfigValue["filters"] = [];
  for (const filter of draft.filters) {
    const field = source.fields.find((f) => f.id === filter.field);
    if (!field) return { problem: "A filter uses a column that is not in this data source" };
    const text = filter.text.trim();
    if (!text) return { problem: `Enter a value for the ${field.label} filter` };
    if (isNumericField(field)) {
      const n = Number(text);
      if (!Number.isFinite(n)) return { problem: `${field.label} needs a number` };
      filters.push({ field: filter.field, op: filter.op, value: field.type === "money" ? Math.round(n * 100) : n });
    } else filters.push({ field: filter.field, op: filter.op, value: text });
  }
  const config: CustomReportConfigValue = {
    source: draft.source,
    columns: draft.columns.map((c) => ({ field: c.field, ...(c.label.trim() ? { label: c.label.trim() } : {}) })),
    filters, groupBy: draft.groupBy, ...(draft.sort ? { sort: draft.sort } : {}),
  };
  const problem = customReportProblem(config);
  return problem ? { problem } : { config };
}

/**
 * A saved definition as a draft, or why it can no longer be opened (a field it uses was renamed or removed in a later
 * release). Checked before the builder renders it, so an outdated saved report shows a message instead of breaking the screen.
 */
export function savedToDraft(config: CustomReportConfigValue): { draft: CustomDraft } | { problem: string } {
  const problem = customReportProblem(config);
  return problem ? { problem: `This saved report no longer matches the available columns (${problem}). Rebuild it and save, or delete it.` } : { draft: configToDraft(config) };
}

export function configToDraft(config: CustomReportConfigValue): CustomDraft {
  const source = customReportSource(config.source);
  return {
    source: config.source,
    columns: config.columns.map((c) => ({ field: c.field, label: c.label ?? "" })),
    filters: config.filters.map((f) => {
      const field = source?.fields.find((x) => x.id === f.field);
      return { field: f.field, op: f.op, text: field?.type === "money" && typeof f.value === "number" ? String(f.value / 100) : String(f.value) };
    }),
    groupBy: config.groupBy, sort: config.sort ?? null,
  };
}

/** A new filter on the first column that can be filtered. */
export function newFilter(draft: CustomDraft): CustomDraft["filters"][number] | null {
  const source = customReportSource(draft.source);
  const field = source?.fields.find((f) => filterOpsFor(f.type).length > 0);
  return field ? { field: field.id, op: filterOpsFor(field.type)[0]!, text: "" } : null;
}

/**
 * Turning grouping on or off keeps the report runnable. Grouping by a field shows it as a column; descriptive columns that are
 * not grouped by are dropped (a grouped row has no single value for them), and so is a sort on a dropped column.
 */
export function withGrouping(draft: CustomDraft, field: string, on: boolean): CustomDraft {
  const groupBy = on ? [...draft.groupBy.filter((g) => g !== field), field] : draft.groupBy.filter((g) => g !== field);
  if (!groupBy.length) return { ...draft, groupBy };
  const source = customReportSource(draft.source);
  const keep = (id: string) => groupBy.includes(id) || source?.fields.find((f) => f.id === id)?.role === "measure";
  const columns = draft.columns.filter((c) => keep(c.field));
  if (on && !columns.some((c) => c.field === field)) columns.unshift({ field, label: "" });
  return { ...draft, groupBy, columns, sort: draft.sort && columns.some((c) => c.field === draft.sort!.field) ? draft.sort : null };
}

/**
 * Ticking or unticking a column. On a grouped report a descriptive column only makes sense as a group, so ticking one groups by
 * it, and unticking one stops grouping by it (unticking the last group returns the report to one row per record).
 */
export function withColumn(draft: CustomDraft, field: string, on: boolean): CustomDraft {
  const f = customReportSource(draft.source)?.fields.find((x) => x.id === field);
  if (draft.groupBy.length && f?.role === "dimension") {
    // A value unique to each row (a timestamp) cannot be grouped, so it cannot be added to a grouped report.
    if (on && f.groupable === false) return draft;
    return withGrouping(on ? draft : { ...draft, columns: draft.columns.filter((c) => c.field !== field) }, field, on);
  }
  const columns = on ? [...draft.columns, { field, label: "" }] : draft.columns.filter((c) => c.field !== field);
  return { ...draft, columns, sort: draft.sort && columns.some((c) => c.field === draft.sort!.field) ? draft.sort : null };
}
