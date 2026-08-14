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
