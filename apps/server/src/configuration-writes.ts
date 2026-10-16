import { CategoryUpdate, ProductUpdate, SettingsUpdate, VariantUpdate, type Database } from '@forkflow/domain';
import { httpError } from './http-error.js';
import { validateMenuPhoto } from './menu-photo.js';

/** Shared synchronous operations for local staff handlers and authorized cloud commands. */
export function updateSettings(db: Database, input: unknown) {
  const body = SettingsUpdate.parse(input);
  db.prepare('UPDATE settings SET restaurant_name=?,address=?,gstin=?,fssai=?,receipt_footer=?,upi_id=COALESCE(?,upi_id),receipt_style=COALESCE(?,receipt_style),gst_mode=COALESCE(?,gst_mode),gst_rate=COALESCE(?,gst_rate) WHERE id=1')
    .run(body.restaurantName, body.address, body.gstin, body.fssai, body.receiptFooter, body.upiId ?? null, body.receiptStyle ?? null, body.gstMode ?? null, body.gstRate ?? null);
}
export function updateCatalog(db: Database, kind: 'category' | 'product' | 'variant', id: string, input: unknown) {
  const schema = kind === 'category' ? CategoryUpdate : kind === 'product' ? ProductUpdate : VariantUpdate;
  const body = schema.parse(input) as Record<string, unknown>;
  const table = kind === 'category' ? 'categories' : kind === 'product' ? 'products' : 'variants';
  if (!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) throw httpError(404, `${kind} not found`);
  if (typeof body['categoryId'] === 'string' && !db.prepare('SELECT id FROM categories WHERE id=?').get(body['categoryId'])) throw httpError(400, 'unknown category');
  if (typeof body['kotStationId'] === 'string' && !db.prepare('SELECT id FROM kot_stations WHERE id=?').get(body['kotStationId'])) throw httpError(400, 'unknown KOT station');
  const fields: Record<string, string> = { name: 'name', sortOrder: 'sort_order', categoryId: 'category_id', pricePaise: 'price_paise', acPricePaise: 'ac_price_paise', takeawayPricePaise: 'takeaway_price_paise', zomatoPricePaise: 'zomato_price_paise', gstRate: 'gst_rate', isVeg: 'is_veg', kotStationId: 'kot_station_id', isActive: 'is_active', description: 'description', isSoldOut: 'is_sold_out' };
  const columns: string[] = []; const values: unknown[] = [];
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || name === 'photo') continue;
    const column = fields[name]; if (!column) throw httpError(400, 'Unsupported configuration field');
    columns.push(`${column}=?`); values.push(typeof value === 'boolean' ? Number(value) : value);
  }
  if (body['photo'] !== undefined) {
    const photo = validateMenuPhoto(body['photo'] as string | null);
    columns.push('photo_data=?', 'photo_hash=?'); values.push(photo?.data ?? null, photo?.hash ?? null);
  }
  if (columns.length) db.prepare(`UPDATE ${table} SET ${columns.join(',')} WHERE id=?`).run(...values, id);
}
