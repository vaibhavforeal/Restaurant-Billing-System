export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface Variant {
  id: string;
  name: string;
  pricePaise: number;
  isActive: boolean;
}

export interface Product {
  id: string;
  categoryId: string;
  name: string;
  pricePaise: number;
  gstRate: number;
  isVeg: boolean;
  kotStationId: string | null;
  isActive: boolean;
  variants: Variant[];
}

export interface Station {
  id: string;
  name: string;
}

export interface AdminUser {
  id: string;
  name: string;
  role: "admin" | "cashier" | "waiter" | "kitchen";
  isActive: boolean;
  createdAt: number;
}

export interface SettingsData {
  restaurantName: string;
  address: string;
  gstin: string;
  fssai: string;
  receiptFooter: string;
}

export interface TableInfo {
  id: string;
  name: string;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "free" | "occupied" | "billed";
  openOrderId: string | null;
}

export interface OrderItem {
  id: string;
  clientRef: string | null;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  gstRate: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancelReason: string | null;
  kotId: string | null;
}

export interface Order {
  id: string;
  clientRef: string;
  type: "dine_in" | "parcel";
  tableId: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  openedBy: string;
  openedAt: number;
  closedAt: number | null;
  items: OrderItem[];
  kots: Kot[];
}

export interface Kot {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
}

export interface KotWithContext {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    note: string | null;
    status: "pending" | "sent" | "cancelled";
  }>;
}
