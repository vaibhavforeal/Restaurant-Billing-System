import { MenuError } from "@masalapos/cafe-data";

/** What the cashier reads when a menu change is refused. */
export function menuErrorMessage(e: unknown): string {
  if (!(e instanceof MenuError)) return "That change could not be saved. Try again.";
  switch (e.code) {
    case "duplicate_name": return "There is already a category with this name.";
    case "category_not_empty": return "Move or delete this category's items first.";
    case "invalid": return "Check the name and price.";
    case "not_found": return "This was already deleted.";
  }
}
