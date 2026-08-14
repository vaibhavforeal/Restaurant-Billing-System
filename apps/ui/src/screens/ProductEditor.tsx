import type { Category, Product, Station } from "../types";

export function ProductEditor(_props: {
  product: Product | null;
  defaultCategoryId: string | null;
  categories: Category[];
  stations: Station[];
  onDone: () => void;
}) {
  return <p style={{ fontFamily: "system-ui", padding: 16 }}>Product editor arrives in the next task.</p>;
}
