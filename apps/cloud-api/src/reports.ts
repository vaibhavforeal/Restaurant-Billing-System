import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './db.js';

type Row = Record<string, any>;
type Facts = Record<string, Row[]>;
type Column = [string, string, string?];
const factTables = ['outlet_meta', 'bills', 'bill_report_lines', 'payments', 'refund_payments', 'bill_settlements', 'credit_notes', 'credit_note_lines', 'orders', 'order_items', 'kots', 'kot_stations', 'dining_tables', 'stock_moves', 'stock_items', 'staff_roster'];
const money = (value: unknown): bigint => {
  if (value == null) return 0n;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ApiError(422, 'Financial fact exceeds safe integer range');
  try { return BigInt(value as string | number); } catch { throw new ApiError(422, 'Invalid financial fact'); }
};
const total = (rows: Row[], key: string) => rows.reduce((sum, row) => sum + money(row[key]), 0n);
const quantity = (rows: Row[], key: string) => rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
const distinct = (rows: Row[], key: string) => new Set(rows.map(row => row[key]).filter(value => value != null)).size;
const compare = (a: any, b: any) => a === b ? 0 : a < b ? -1 : 1;
const byId = (rows: Row[]) => new Map(rows.map(row => [row.id, row]));
const group = (rows: Row[], key: (row: Row) => unknown): Row[][] => {
  const groups = new Map<string, Row[]>();
  for (const row of rows) { const id = JSON.stringify(key(row)); const entries = groups.get(id) ?? []; entries.push(row); groups.set(id, entries); }
  return [...groups.values()];
};
// BigInt division truncates toward zero; reports use Math.round's half-toward-positive-infinity rule.
function roundedRatio(n: bigint, d: bigint): bigint {
  if (d === 0n) return 0n;
  if (d < 0n) { n = -n; d = -d; }
  const shifted = 2n * n + d, divisor = 2n * d;
  return shifted / divisor - (shifted < 0n && shifted % divisor !== 0n ? 1n : 0n);
}
const percent = (part: bigint, whole: bigint) => whole === 0n ? null : Number(roundedRatio(part * 1000n, whole)) / 10;
const jsonRow = (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
function table(title: string, definitions: Column[], rows: Row[], totals?: Row) {
  return { title, columns: definitions.map(([key, label, format]) => ({ key, label, ...(format ? { format } : {}) })), rows: rows.map(jsonRow), ...(totals ? { totals: jsonRow(totals) } : {}) };
}
const sums = (rows: Row[], amounts: string[], quantities: string[] = []) => Object.fromEntries([...amounts.map(key => [key, total(rows, key)]), ...quantities.map(key => [key, quantity(rows, key)])]);

async function facts(client: PoolClient, outletId: string): Promise<Facts> {
  // A single statement reads one projection snapshot, including its timezone.
  const result: Facts = Object.fromEntries(factTables.map(name => [name, []]));
  const rows = (await client.query('SELECT entity_table,row_data FROM projections WHERE outlet_id=$1 AND entity_table=ANY($2::text[])', [outletId, factTables])).rows;
  for (const row of rows) result[row.entity_table]!.push(row.row_data);
  return result;
}
function calendar(data: Facts, query: unknown, now: number) {
  const parsed = z.object({ from: z.string().optional(), to: z.string().optional(), timezone: z.string().optional(), type: z.enum(['all', 'parcel', 'dine_in', 'zomato']).default('all') }).strict().safeParse(query);
  if (!parsed.success) throw new ApiError(400, 'Invalid report date range');
  const timezone = data.outlet_meta![0]?.timezone ?? 'UTC';
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  catch { throw new ApiError(422, 'Outlet timezone is invalid'); }
  if (parsed.data.timezone && parsed.data.timezone !== timezone) throw new ApiError(400, 'Reports use the outlet timezone');
  const calendarCache = new Map<number, Record<string, string>>();
  const parts = (at: unknown) => {
    const timestamp = Number(at), cached = calendarCache.get(timestamp);
    if (cached) return cached;
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8640000000000000) throw new ApiError(422, 'Invalid report timestamp fact');
    const result = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    calendarCache.set(timestamp, result); return result;
  };
  const date = (at: unknown) => { const p = parts(at); return `${p.year}-${p.month}-${p.day}`; };
  const hour = (at: unknown) => Number(parts(at).hour);
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 10) === value;
  const today = date(now), to = parsed.data.to ?? today;
  if (!valid(to)) throw new ApiError(400, 'Invalid report end date');
  const from = parsed.data.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  if (!valid(from) || from > to || Date.parse(to) - Date.parse(from) >= 366 * 86400000) throw new ApiError(400, 'Invalid report date range (maximum 366 days)');
  const inRange = (row: Row, field = 'created_at') => row[field] != null && date(row[field]) >= from && date(row[field]) <= to;
  const dates: string[] = []; for (let at = Date.parse(from); at <= Date.parse(to); at += 86400000) dates.push(new Date(at).toISOString().slice(0, 10));
  return { from, to, today, timezone, date, hour, inRange, dates, orderType: parsed.data.type };
}
function sales(data: Facts, period: ReturnType<typeof calendar>) {
  const bills = data.bills!.filter(row => period.inRange(row)), notes = data.credit_notes!.filter(row => period.inRange(row));
  const payments = data.payments!.filter(row => period.inRange(row) && row.mode !== 'zomato'), refunds = data.refund_payments!.filter(row => period.inRange(row));
  const methodRows = [...payments.map(row => ({ mode: row.mode, amount: money(row.amount_paise) })), ...refunds.map(row => ({ mode: row.mode, amount: -money(row.amount_paise) }))];
  return { currency: 'INR', from: period.from, to: period.to, timezone: period.timezone,
    totals: { billCount: bills.length, taxablePaise: String(total(bills, 'subtotal_paise') - total(bills, 'discount_paise') - total(notes, 'taxable_paise')),
      cgstPaise: String(total(bills, 'cgst_paise') - total(notes, 'cgst_paise')), sgstPaise: String(total(bills, 'sgst_paise') - total(notes, 'sgst_paise')), igstPaise: String(total(bills, 'igst_paise') - total(notes, 'igst_paise')),
      grandTotalPaise: String(total(bills, 'total_paise')), paidPaise: String(total(payments, 'amount_paise') - total(refunds, 'amount_paise')), creditNotePaise: String(total(notes, 'total_paise')), netSalesPaise: String(total(bills, 'total_paise') - total(notes, 'total_paise')),
      outstandingPaise: String(total(bills.filter(row => row.status === 'unpaid'), 'total_paise')), refundPaise: String(total(refunds, 'amount_paise')), collectedBillCount: distinct(payments, 'bill_id'), zomatoReceivablePaise: String(total(data.payments!.filter(row => period.inRange(row) && row.mode === 'zomato'), 'amount_paise')) },
    daily: group(bills, row => period.date(row.created_at)).map(rows => ({ date: period.date(rows[0]!.created_at), billCount: rows.length, grandTotalPaise: String(total(rows, 'total_paise')) })).sort((a, b) => compare(a.date, b.date)),
    paymentMethods: group(methodRows, row => row.mode).map(rows => ({ method: String(rows[0]!.mode), amountPaise: String(total(rows, 'amount')) })).sort((a, b) => compare(a.method, b.method)) };
}
export async function salesReport(client: PoolClient, outletId: string, query: unknown) {
  const data = await facts(client, outletId); return sales(data, calendar(data, query, Date.now()));
}

export async function operationalReport(client: PoolClient, outletId: string, kind: string, query: unknown, now: number) {
  if (!['items', 'cashiers', 'hourly', 'kots', 'cancellations', 'stock', 'credit-notes', 'analytics', 'profit', 'day-end'].includes(kind)) throw new ApiError(404, 'Report not found');
  const data = await facts(client, outletId), period = calendar(data, query, now), { inRange } = period;
  const allBills = byId(data.bills!), allNotes = byId(data.credit_notes!), orders = byId(data.orders!), items = byId(data.order_items!), stations = byId(data.kot_stations!), kots = byId(data.kots!), dining = byId(data.dining_tables!), stock = byId(data.stock_items!);
  const names = new Map(data.staff_roster!.map(row => [row.id, row.name]));
  const bills = data.bills!.filter(row => inRange(row)), notes = data.credit_notes!.filter(row => inRange(row));
  const billIds = new Set(bills.map(row => row.id)), noteIds = new Set(notes.map(row => row.id));
  const lines = data.bill_report_lines!.filter(row => billIds.has(row.bill_id));
  const originals = new Map(data.bill_report_lines!.map(row => [JSON.stringify([row.bill_id, row.order_item_id]), row]));
  const credits = data.credit_note_lines!.filter(row => noteIds.has(row.credit_note_id)).flatMap(row => {
    const note = allNotes.get(row.credit_note_id)!, original = originals.get(JSON.stringify([note.bill_id, row.order_item_id]));
    return original ? [{ credit: row, note, original }] : [];
  });
  const tables: ReturnType<typeof table>[] = [], warnings = ['Values reflect the last acknowledged outlet upload. Issued bills remain on their issue date; credit notes offset sales on their own issue date.'];
  const location = (order: Row | undefined) => dining.get(order?.table_id)?.name ?? 'Takeaway';
  if (kind === 'items') {
    const entries = [...lines.map(line => ({ ...line, subtotal: money(line.subtotal_paise), discount: money(line.discount_paise), taxable: money(line.taxable_paise), gst: money(line.cgst_paise) + money(line.sgst_paise), rounding: money(line.rounding_paise), total: money(line.total_paise), creditQty: 0, credit: 0n })),
      ...credits.map(({ credit, original }) => ({ ...original, bill_id: null, qty: 0, subtotal: 0n, discount: 0n, taxable: 0n, gst: 0n, rounding: 0n, total: 0n, creditQty: Number(credit.qty), credit: money(credit.total_paise) }))];
    const amounts = ['subtotal', 'discount', 'taxable', 'gst', 'rounding', 'total', 'credit'];
    const aggregate = (rows: Row[]) => ({ qty: quantity(rows, 'qty'), bills: distinct(rows, 'bill_id'), ...sums(rows, amounts), creditQty: quantity(rows, 'creditQty'), netQty: quantity(rows, 'qty') - quantity(rows, 'creditQty'), netTotal: total(rows, 'total') - total(rows, 'credit') });
    const itemRows = group(entries, row => [row.product_id, row.variant_id, row.name, row.category_id, row.category_name]).map(rows => ({ name: rows[0]!.name, category: rows[0]!.category_name, ...aggregate(rows) })).sort((a, b) => compare(b.netTotal, a.netTotal) || compare(a.name, b.name));
    const categoryRows = group(entries, row => [row.category_id, row.category_name]).map(rows => ({ category: rows[0]!.category_name, ...aggregate(rows) })).sort((a, b) => compare(b.netTotal, a.netTotal) || compare(a.category, b.category));
    const cols: Column[] = [['qty', 'Quantity', 'quantity'], ['bills', 'Bills'], ['subtotal', 'Subtotal', 'money'], ['discount', 'Discount', 'money'], ['taxable', 'Taxable', 'money'], ['gst', 'GST', 'money'], ['rounding', 'Round off', 'money'], ['total', 'Sales', 'money'], ['creditQty', 'Credited quantity', 'quantity'], ['credit', 'Credit notes', 'money'], ['netQty', 'Net quantity', 'quantity'], ['netTotal', 'Net sales', 'money']];
    const totals = { ...sums(itemRows, [...amounts, 'netTotal'], ['qty', 'creditQty', 'netQty']), bills: distinct(entries, 'bill_id') };
    tables.push(table('Item sales', [['name', 'Item / variant'], ['category', 'Category'], ...cols], itemRows, { name: 'Total', ...totals }), table('Category sales', [['category', 'Category'], ...cols], categoryRows, { category: 'Total', ...totals }));
    const supplies = bills.filter(bill => orders.get(bill.order_id)?.type === 'zomato').sort((a, b) => compare(a.created_at, b.created_at) || compare(a.bill_no, b.bill_no)).map(bill => ({ billNo: bill.bill_no, zomatoOrderId: orders.get(bill.order_id)!.zomato_order_id, date: bill.created_at, value: money(bill.total_paise) }));
    tables.push(table('Aggregator supplies — GST paid by Zomato (section 9(5))', [['billNo', 'Bill no.'], ['zomatoOrderId', 'Zomato order'], ['date', 'Date', 'time'], ['value', 'Value', 'money']], supplies, { billNo: 'Total', value: total(supplies, 'value') }));
    warnings.push('Bill counts overlap across items and categories; totals count distinct bills. Historical credit notes without recorded item lines cannot be itemised.');
  }
  if (kind === 'cashiers') {
    const settlements = new Map(data.bill_settlements!.map(row => [row.bill_id, row]));
    const entries = [...data.payments!.filter(row => inRange(row) && row.mode !== 'zomato').map(row => ({ userId: settlements.get(row.bill_id)?.created_by ?? null, bill_id: row.bill_id, mode: row.mode, amount: money(row.amount_paise), refund: 0n })),
      ...data.refund_payments!.filter(row => inRange(row) && allNotes.has(row.credit_note_id)).map(row => ({ userId: allNotes.get(row.credit_note_id)!.requested_by, bill_id: null, mode: row.mode, amount: -money(row.amount_paise), refund: money(row.amount_paise) }))];
    const rows = group(entries, row => row.userId).map(group => ({ cashier: names.get(group[0]!.userId) ?? 'Unknown', bills: distinct(group, 'bill_id'), cash: total(group.filter(row => row.mode === 'cash'), 'amount'), upi: total(group.filter(row => row.mode === 'upi'), 'amount'), card: total(group.filter(row => row.mode === 'card'), 'amount'), refunds: total(group, 'refund'), total: total(group, 'amount') })).sort((a, b) => compare(b.total, a.total) || compare(a.cashier, b.cashier));
    tables.push(table('Cashier collections', [['cashier', 'Collecting cashier'], ['bills', 'Bills'], ['cash', 'CASH', 'money'], ['upi', 'UPI', 'money'], ['card', 'CARD', 'money'], ['refunds', 'Refunded', 'money'], ['total', 'Net received', 'money']], rows, { cashier: 'Total', ...sums(rows, ['cash', 'upi', 'card', 'refunds', 'total'], ['bills']) }));
    warnings.push('Collections use payment date and settlement cashier. Legacy receipts without a settlement actor are Unknown. Refunds subtract from the requesting cashier by refund date.');
  }
  if (kind === 'hourly') {
    const rows = Array.from({ length: 24 }, (_, hour) => {
      const issued = bills.filter(row => period.hour(row.created_at) === hour), credited = notes.filter(row => period.hour(row.created_at) === hour), amount = total(issued, 'total_paise') - total(credited, 'total_paise');
      return { hour: `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59`, bills: issued.length, total: amount, discount: total(issued, 'discount_paise'), gst: total(issued, 'cgst_paise') + total(issued, 'sgst_paise') - total(credited, 'cgst_paise') - total(credited, 'sgst_paise'), credit: total(credited, 'total_paise'), average: roundedRatio(amount, BigInt(issued.length)) };
    });
    tables.push(table('Hourly sales', [['hour', 'Hour'], ['bills', 'Bills'], ['discount', 'Discount', 'money'], ['gst', 'Net GST', 'money'], ['credit', 'Credit notes', 'money'], ['total', 'Net sales', 'money'], ['average', 'Average bill', 'money']], rows, { hour: 'Total', ...sums(rows, ['total', 'discount', 'gst', 'credit'], ['bills']), average: roundedRatio(total(rows, 'total'), BigInt(bills.length)) }));
  }
  if (kind === 'credit-notes') {
    const rows = notes.filter(note => allBills.has(note.bill_id) && names.has(note.requested_by) && names.has(note.approved_by)).sort((a, b) => compare(a.cn_no, b.cn_no)).map(note => ({ cnNo: `CN-${note.cn_no}`, date: note.created_at, billNo: allBills.get(note.bill_id)!.bill_no, kind: note.kind === 'void' ? 'Void' : 'Refund', reason: note.reason, requestedBy: names.get(note.requested_by), approvedBy: names.get(note.approved_by), refundModes: [...new Set(data.refund_payments!.filter(row => row.credit_note_id === note.id).sort((a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id)).map(row => row.mode === 'cash' ? 'Cash' : row.mode === 'upi' ? 'UPI' : 'Card'))].join(', ') || 'None', taxable: money(note.taxable_paise), gst: money(note.cgst_paise) + money(note.sgst_paise), total: money(note.total_paise) }));
    tables.push(table('Credit notes', [['cnNo', 'CN'], ['date', 'Date', 'time'], ['billNo', 'Bill'], ['kind', 'Kind'], ['reason', 'Reason'], ['requestedBy', 'Requested by'], ['approvedBy', 'Approved by'], ['refundModes', 'Refund methods'], ['taxable', 'Taxable', 'money'], ['gst', 'GST', 'money'], ['total', 'Total', 'money']], rows, { cnNo: 'Total', ...sums(rows, ['taxable', 'gst', 'total']) }));
  }
  if (kind === 'kots') {
    const rows = data.kots!.filter(row => inRange(row) && stations.has(row.station_id) && orders.has(row.order_id)).sort((a, b) => compare(b.created_at, a.created_at) || compare(a.id, b.id)).map(kot => {
      const children = data.order_items!.filter(item => item.kot_id === kot.id), qty = quantity(children.filter(item => item.status !== 'cancelled'), 'qty'), completed = kot.done_at ?? null;
      return { id: kot.id, stationId: kot.station_id, ticket: kot.kot_no, kitchen: stations.get(kot.station_id)!.name, staff: names.get(kot.created_by) ?? 'Unknown', location: location(orders.get(kot.order_id)), sent: kot.created_at, completed, qty, cancelled: quantity(children.filter(item => item.status === 'cancelled'), 'qty'), status: !qty ? 'Cancelled' : completed == null ? 'Pending' : 'Completed', minutes: qty && completed != null && completed >= kot.created_at ? (completed - kot.created_at) / 60000 : null, age: qty && completed == null ? Math.max(0, now - kot.created_at) / 60000 : null };
    });
    const summary = group(rows, row => row.stationId).map(rows => { const completed = rows.filter(row => row.minutes != null); return { kitchen: rows[0]!.kitchen, tickets: rows.length, completed: rows.filter(row => row.status === 'Completed').length, pending: rows.filter(row => row.status === 'Pending').length, cancelled: rows.filter(row => row.status === 'Cancelled').length, average: completed.length ? quantity(completed, 'minutes') / completed.length : null, longest: completed.length ? Math.max(...completed.map(row => row.minutes)) : null }; });
    tables.push(table('Kitchen performance', [['kitchen', 'Kitchen'], ['tickets', 'Tickets'], ['completed', 'Completed'], ['pending', 'Pending'], ['cancelled', 'Cancelled'], ['average', 'Average minutes', 'minutes'], ['longest', 'Longest minutes', 'minutes']], summary), table('KOT details', [['ticket', 'KOT'], ['kitchen', 'Kitchen'], ['staff', 'Sent by'], ['location', 'Table / takeaway'], ['sent', 'Sent at', 'time'], ['completed', 'Completed at', 'time'], ['status', 'Status'], ['qty', 'Active qty'], ['cancelled', 'Cancelled qty'], ['minutes', 'Completion minutes', 'minutes'], ['age', 'Pending minutes', 'minutes']], rows));
    warnings.push('Duration measures send-to-completion (done), not acceptance or active cooking time. Fully cancelled tickets are excluded from averages. Pending age uses report refresh time.');
  }
  if (kind === 'cancellations') {
    const rows = data.order_items!.filter(row => row.status === 'cancelled' && inRange(row, 'cancelled_at') && orders.has(row.order_id)).sort((a, b) => compare(b.cancelled_at, a.cancelled_at) || compare(a.id, b.id)).map(row => ({ time: row.cancelled_at, orderId: row.order_id, ticket: kots.get(row.kot_id)?.kot_no ?? null, item: row.name_snapshot, qty: Number(row.qty), value: decimalProduct(row.qty, money(row.price_paise_snapshot)), staff: names.get(row.cancelled_by) ?? 'Unknown', reason: row.cancel_reason ?? 'Not recorded', location: location(orders.get(row.order_id)) }));
    tables.push(table('Cancelled items', [['time', 'Cancelled at', 'time'], ['orderId', 'Order reference'], ['ticket', 'KOT'], ['location', 'Table / takeaway'], ['item', 'Item'], ['qty', 'Quantity'], ['value', 'Menu value', 'money'], ['staff', 'Cancelled by'], ['reason', 'Reason']], rows, { item: 'Total', qty: quantity(rows, 'qty'), value: decimalSum(rows.map(row => row.value)) }));
    const cancelled = data.orders!.filter(row => row.status === 'cancelled' && row.merged_into == null && inRange(row, 'closed_at')).sort((a, b) => compare(b.closed_at, a.closed_at) || compare(a.id, b.id)).map(row => ({ orderId: row.id, time: row.closed_at, location: location(row), staff: names.get(row.cancelled_by) ?? 'Unknown', reason: row.cancel_reason ?? 'Not recorded' }));
    tables.push(table('Cancelled orders', [['time', 'Cancelled at', 'time'], ['orderId', 'Order reference'], ['location', 'Table / takeaway'], ['staff', 'Cancelled by'], ['reason', 'Reason']], cancelled));
    const unknown = data.order_items!.filter(row => row.status === 'cancelled' && row.cancelled_at == null).length;
    if (unknown) warnings.push(`${unknown} historical cancelled item entries have no cancellation timestamp and cannot be assigned to this date range.`);
    warnings.push('Cancelled menu values are before discounts and are not refunds. Cancelled orders must not be added to item values.');
  }
  if (kind === 'stock') {
    const round = (n: number) => { const value = Math.sign(n) * Math.round(Math.abs(n) * 1000) / 1000; return value === 0 ? 0 : value; };
    const rows = data.stock_items!.slice().sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id)).map(item => {
      const all = data.stock_moves!.filter(row => row.stock_item_id === item.id), selected = all.filter(row => inRange(row));
      return { item: item.name, unit: item.unit, opening: round(Number(item.qty) - quantity(all.filter(row => period.date(row.created_at) >= period.from), 'delta')), received: round(quantity(selected.filter(row => row.reason === 'purchase'), 'delta')), consumed: round(-quantity(selected.filter(row => row.reason === 'sale'), 'delta')), restored: round(quantity(selected.filter(row => row.reason === 'cancel_reversal'), 'delta')), wastage: round(-quantity(selected.filter(row => row.reason === 'wastage'), 'delta')), adjustment: round(quantity(selected.filter(row => row.reason === 'adjustment'), 'delta')), closing: round(Number(item.qty) - quantity(all.filter(row => period.date(row.created_at) > period.to), 'delta')) };
    });
    tables.push(table('Stock movement summary', [['item', 'Stock item'], ['unit', 'Unit'], ...['opening', 'received', 'consumed', 'restored', 'wastage', 'adjustment', 'closing'].map(key => [key, key[0]!.toUpperCase() + key.slice(1), 'quantity'] as Column)], rows));
    const details = data.stock_moves!.filter(row => inRange(row) && stock.has(row.stock_item_id)).sort((a, b) => compare(b.created_at, a.created_at) || compare(a.id, b.id)).map(row => ({ time: row.created_at, item: stock.get(row.stock_item_id)!.name, unit: stock.get(row.stock_item_id)!.unit, reason: row.reason, quantity: Number(row.delta), staff: names.get(row.created_by) ?? 'Unknown', note: row.note ?? null, orderId: items.get(row.order_item_id)?.order_id ?? null }));
    tables.push(table('Stock movement details', [['time', 'Recorded at', 'time'], ['item', 'Stock item'], ['unit', 'Unit'], ['reason', 'Movement'], ['quantity', 'Change', 'quantity'], ['staff', 'Recorded by'], ['note', 'Reason / reference'], ['orderId', 'Order reference']], details));
    warnings.push('Stock quantities use each item’s own unit. Opening and closing quantities include the full recorded movement history; units are never added together.');
  }
  if (kind === 'profit') profitTables(data, lines, credits, allBills, inRange, tables, warnings);
  if (kind === 'analytics') analyticsTables(lines, credits, bills, notes, allBills, orders, period, tables);
  if (kind === 'day-end') {
    const report = sales(data, period);
    tables.push(table('Day-end totals', [['billCount', 'Issued bills'], ['grandTotalPaise', 'Issued sales', 'money'], ['creditNotePaise', 'Credits', 'money'], ['netSalesPaise', 'Net sales', 'money'], ['paidPaise', 'Net collections', 'money'], ['refundPaise', 'Refunds paid', 'money'], ['collectedBillCount', 'Bills collected'], ['zomatoReceivablePaise', 'Zomato receivable', 'money'], ['outstandingPaise', 'Issued bills still unpaid', 'money']], [report.totals]), table('Collections', [['method', 'Method'], ['amountPaise', 'Net collections', 'money']], report.paymentMethods));
    warnings.push('Cloud day-end is a report snapshot, not a cash-drawer close or a fiscal lock. Collections exclude Zomato receivables.');
  }
  return { kind, from: period.from, to: period.to, today: period.today, timezone: period.timezone, generatedAt: now, notes: warnings, tables };
}

// Menu cancellation values are derived estimates, not billed facts: retain fractional paise exactly.
function decimalParts(value: unknown): { coefficient: bigint; scale: number } {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new ApiError(422, 'Invalid quantity fact');
  const fraction = match[3] ?? '', exponent = Number(match[4] ?? 0), scale = fraction.length - exponent;
  if (Math.abs(scale) > 100) throw new ApiError(422, 'Quantity fact exceeds supported precision');
  return { coefficient: BigInt(`${match[1]}${match[2]}${fraction}`) * (scale < 0 ? 10n ** BigInt(-scale) : 1n), scale: Math.max(0, scale) };
}
function decimalString(coefficient: bigint, scale: number) {
  const sign = coefficient < 0n ? '-' : '', digits = String(coefficient < 0n ? -coefficient : coefficient).padStart(scale + 1, '0');
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : sign + digits;
}
function decimalSum(values: string[]) {
  const parts = values.map(decimalParts), scale = Math.max(0, ...parts.map(value => value.scale));
  return decimalString(parts.reduce((sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale), 0n), scale);
}
function decimalProduct(qty: unknown, price: bigint) {
  const value = decimalParts(qty); return decimalString(value.coefficient * price, value.scale);
}

function profitTables(data: Facts, issued: Row[], credits: Row[], bills: Map<any, Row>, inRange: (row: Row) => boolean, tables: ReturnType<typeof table>[], warnings: string[]) {
  const reversed = new Set(data.stock_moves!.map(row => row.reversal_of).filter(Boolean));
  const recipe = (line: Row) => data.stock_moves!.filter(move => move.order_item_id === line.order_item_id && move.reason === 'sale' && !reversed.has(move.id));
  const entry = (line: Row, credit?: Row, note?: Row) => {
    const moves = recipe(line), unknown = moves.some(move => move.cost_paise == null);
    return { category: line.category_name, name: line.name, qty: credit ? -Number(credit.qty) : Number(line.qty), revenue: credit ? -money(credit.taxable_paise) : money(line.taxable_paise), cost: unknown ? null : credit ? 0n : moves.length ? -total(moves, 'cost_paise') : null, status: moves.length === 0 ? 'none' : unknown ? 'unknown' : 'costed', billId: line.bill_id, itemId: line.order_item_id, at: note?.created_at ?? bills.get(line.bill_id)!.created_at };
  };
  const lines = [...issued.map(line => entry(line)), ...credits.map(({ original, credit, note }) => entry(original, credit, note))].sort((a, b) => compare(a.category.toLowerCase(), b.category.toLowerCase()) || compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.billId, b.billId) || compare(a.itemId, b.itemId) || compare(a.at, b.at));
  const costed = lines.filter(line => line.status === 'costed'), revenue = total(lines, 'revenue'), costedRevenue = total(costed, 'revenue'), cost = total(costed, 'cost');
  const movements = (reason: string) => data.stock_moves!.filter(row => inRange(row) && row.reason === reason && (reason !== 'adjustment' || row.client_ref != null));
  const summary = (metric: string, amount: bigint | null, percentage: number | null = null) => ({ metric, amount, percent: percentage });
  tables.push(table('Summary', [['metric', 'Metric'], ['amount', 'Amount', 'money'], ['percent', 'Percent', 'percent']], [summary('Revenue (pre-GST)', revenue), summary('Costed revenue', costedRevenue), summary('Ingredient cost', cost), summary('Gross profit', costedRevenue - cost), summary('Food cost %', null, percent(cost, costedRevenue)), summary('Wastage cost', -total(movements('wastage'), 'cost_paise')), summary('Count adjustments (net)', -total(movements('adjustment'), 'cost_paise')), summary('Excluded: cost unknown', total(lines.filter(line => line.status === 'unknown'), 'revenue')), summary('Excluded: no recipe', total(lines.filter(line => line.status === 'none'), 'revenue'))]));
  const labels: Record<string, string> = { costed: 'Costed', unknown: 'Cost unknown', none: 'No recipe' };
  for (const withCategory of [false, true]) {
    const rows = group(lines, row => withCategory ? [row.category, row.name] : row.category).map(rows => {
      const costed = rows.filter(row => row.status === 'costed'), cost = total(costed, 'cost'), revenue = total(costed, 'revenue');
      const statuses = Object.keys(labels).filter(status => rows.some(row => row.status === status));
      return { ...(withCategory ? { category: rows[0]!.category } : {}), name: withCategory ? rows[0]!.name : rows[0]!.category, qty: quantity(rows, 'qty'), revenue: total(rows, 'revenue'), costedRevenue: costed.length ? revenue : null, cost: costed.length ? cost : null, profit: costed.length ? revenue - cost : null, costPercent: costed.length ? percent(cost, revenue) : null, status: statuses.length === 1 ? labels[statuses[0]!] : statuses.map(status => `${rows.filter(row => row.status === status).length} ${labels[status]!.toLowerCase()}`).join(', ') };
    });
    tables.push(table(withCategory ? 'By dish' : 'By category', [...(withCategory ? [['category', 'Category'] as Column] : []), ['name', withCategory ? 'Dish' : 'Category'], ['qty', 'Quantity', 'quantity'], ['revenue', 'Revenue', 'money'], ['costedRevenue', 'Costed revenue', 'money'], ['cost', 'Cost', 'money'], ['profit', 'Gross profit', 'money'], ['costPercent', 'Food cost %', 'percent'], ['status', 'Status']], rows));
  }
  warnings.push('Revenue is taxable value after discount, excluding GST. Ingredient costs come from unreversed sale movements linked to each billed item, regardless of movement date. Credit notes reduce revenue without returning stock. Profit excludes sales with unknown cost or no recipe.');
  for (const reason of ['wastage', 'adjustment']) { const count = movements(reason).filter(row => row.cost_paise == null).length; if (count) warnings.push(`${count} ${reason} movements have no recorded cost and are excluded from the recorded ${reason} cost.`); }
}

function analyticsTables(lines: Row[], credits: Row[], bills: Row[], notes: Row[], allBills: Map<any, Row>, orders: Map<any, Row>, period: ReturnType<typeof calendar>, tables: ReturnType<typeof table>[]) {
  const billEntries = [...bills.filter(bill => orders.has(bill.order_id)).map(bill => ({ at: bill.created_at, orderId: bill.order_id, type: orders.get(bill.order_id)!.type, total: money(bill.total_paise) })), ...notes.filter(note => orders.has(allBills.get(note.bill_id)?.order_id)).map(note => ({ at: note.created_at, orderId: null, type: orders.get(allBills.get(note.bill_id)!.order_id)!.type, total: -money(note.total_paise) }))];
  const lineEntries = [...lines.filter(line => orders.has(allBills.get(line.bill_id)?.order_id)).map(line => ({ ...line, orderId: allBills.get(line.bill_id)!.order_id, type: orders.get(allBills.get(line.bill_id)!.order_id)!.type, total: money(line.total_paise) })), ...credits.filter(({ original }) => orders.has(allBills.get(original.bill_id)?.order_id)).map(({ original, credit }) => ({ ...original, orderId: null, type: orders.get(allBills.get(original.bill_id)!.order_id)!.type, qty: -Number(credit.qty), total: -money(credit.total_paise) }))];
  const comparison = ['parcel', 'dine_in', 'zomato'].map(type => ({ type, orderCount: distinct(billEntries.filter(row => row.type === type), 'orderId'), totalPaise: total(billEntries.filter(row => row.type === type), 'total'), qty: quantity(lineEntries.filter(row => row.type === type), 'qty') }));
  tables.push(table('Service type', [['type', 'Service'], ['orderCount', 'Orders'], ['totalPaise', 'Net sales', 'money'], ['qty', 'Net quantity', 'quantity']], comparison));
  const selected = (row: Row) => period.orderType === 'all' || row.type === period.orderType, selectedBills = billEntries.filter(selected), selectedLines = lineEntries.filter(selected);
  const selectedComparison = comparison.filter(selected);
  tables.push(table('Order analytics totals', [['orderCount', 'Orders'], ['totalPaise', 'Net sales', 'money'], ['qty', 'Net quantity', 'quantity']], [sums(selectedComparison, ['totalPaise'], ['orderCount', 'qty'])]));
  const aggregate = (rows: Row[]) => ({ qty: quantity(rows, 'qty'), orderCount: distinct(rows, 'orderId'), totalPaise: total(rows, 'total') });
  const itemRows = group(selectedLines, row => [row.product_id, row.variant_id, row.name, row.category_id, row.category_name]).map(rows => ({ productId: rows[0]!.product_id, variantId: rows[0]!.variant_id, categoryId: rows[0]!.category_id, name: rows[0]!.name, category: rows[0]!.category_name, ...aggregate(rows), takeawayQty: quantity(rows.filter(row => row.type === 'parcel'), 'qty'), tableQty: quantity(rows.filter(row => row.type === 'dine_in'), 'qty') })).sort((a, b) => compare(b.qty, a.qty) || compare(b.totalPaise, a.totalPaise) || compare(a.name, b.name) || compare(a.productId, b.productId) || compare(a.variantId, b.variantId) || compare(a.categoryId, b.categoryId) || compare(a.category, b.category));
  tables.push(table('Item order analytics', [['name', 'Item'], ['category', 'Category'], ['qty', 'Net quantity', 'quantity'], ['orderCount', 'Orders'], ['totalPaise', 'Net sales', 'money'], ['takeawayQty', 'Takeaway quantity', 'quantity'], ['tableQty', 'Table quantity', 'quantity']], itemRows));
  const categoryRows = group(selectedLines, row => [row.category_id, row.category_name]).map(rows => ({ categoryId: rows[0]!.category_id, name: rows[0]!.category_name, ...aggregate(rows) })).sort((a, b) => compare(b.totalPaise, a.totalPaise) || compare(b.qty, a.qty) || compare(a.name, b.name) || compare(a.categoryId, b.categoryId));
  tables.push(table('Category order analytics', [['name', 'Category'], ['qty', 'Net quantity', 'quantity'], ['orderCount', 'Orders'], ['totalPaise', 'Net sales', 'money']], categoryRows));
  const daily = period.dates.map(date => { const rows = selectedBills.filter(row => period.date(row.at) === date); return { date, takeawayOrders: distinct(rows.filter(row => row.type === 'parcel'), 'orderId'), tableOrders: distinct(rows.filter(row => row.type === 'dine_in'), 'orderId'), totalPaise: total(rows, 'total') }; });
  tables.push(table('Daily order analytics', [['date', 'Date'], ['takeawayOrders', 'Takeaway orders'], ['tableOrders', 'Table orders'], ['totalPaise', 'Net sales', 'money']], daily));
  const hourly = Array.from({ length: 24 }, (_, hour) => { const rows = selectedBills.filter(row => period.hour(row.at) === hour); return { hour, orderCount: distinct(rows, 'orderId'), totalPaise: total(rows, 'total') }; });
  tables.push(table('Hourly order analytics', [['hour', 'Hour'], ['orderCount', 'Orders'], ['totalPaise', 'Net sales', 'money']], hourly));
}
