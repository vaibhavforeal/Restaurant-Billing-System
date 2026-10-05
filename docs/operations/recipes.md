# Recipe editing

A recipe lists the stock consumed by one menu item. It applies to every variant
of that product. For example, enter `200 g` of rice measured in kg and `15 ml`
of oil measured in L. The editor converts these to `0.200 kg` and `0.015 L`
before saving. You can also enter kg or L directly.

To see what a recipe costs and the profit it earns, see
[Inventory costing and profit](costing.md).

## Access

Recipe editing requires an administrator and the Pro `recipes` entitlement.
The development build also permits administrators to edit recipes. Basic supports
a single ingredient in the same editor. Cashiers and
Basic customers can view existing recipes, but Basic cannot change a
multiple-ingredient recipe.

An active connection to the restaurant's local server is required to load and
save recipes. Internet loss does not prevent editing while the local license
permits offline operation. Cloud accounts and restaurant-data synchronization
remain unfinished; recipe changes currently live on the restaurant hub.

## Create or change a recipe

1. Open **Inventory → Recipes** and find the menu item. Stock balances,
   purchases, adjustments and history remain in the default **Stock** tab.
2. Choose **Add ingredient**, search the active stock items, and select one.
   Ingredients already in the recipe and archived stock items are excluded.
3. Enter the amount for one sale. kg stock defaults to g; L stock defaults to ml.
   Switching the unit preserves the represented amount. kg/L stock requires
   whole g/ml amounts; other entries allow three decimal places. The converted
   quantity must be from 0.001 to 1,000,000 stock units. Unsupported precision
   shows beside the amount and is never silently rounded.
4. If an ingredient is missing, choose **Create stock item** in the picker.
   Enter its name, permanent stock unit, opening quantity (default zero), and
   optional low-stock threshold. Creation saves the stock item immediately and
   adds it to the preserved recipe draft with a blank amount.
5. Review and choose **Save recipe**. The complete list replaces the previous
   recipe atomically. The editor stays open with a saved message; a failed save
   keeps the draft. Pro supports up to 100 ingredients; Basic supports one.

On mobile, choose a product from the list, then use **Back to menu items** to
return. Product, tab, Back, navigation and logout actions protect unsaved changes.
**Discard changes** restores the saved quantities. Leaving is blocked while a
recipe or stock-item creation request is in progress.

To remove the recipe, remove every ingredient, save, and confirm removal. Future
deductions will no longer consume stock for that product. Existing movements and
their cancellation reversals remain intact. Remove an ingredient from every
product recipe or stock link before archiving its stock item.

If another administrator changes the recipe while you are editing, saving is
blocked with a conflict (HTTP 409). Choose **Load latest recipe**, review the latest
saved recipe, then reapply any intended changes before saving again. Reloading
replaces the unsaved draft with the saved version after confirmation. Live
updates do not overwrite a dirty draft. Failed loads offer **Retry loading recipe**.

Changing products, navigating to another screen, or logging out asks before
discarding an unsaved recipe. Navigation is paused while a save is in progress.

## When quantities affect stock

Kitchen items deduct stock when sent. Items without a kitchen station deduct
stock when their bill is issued. Punching an order does not reserve or deduct
ingredients, so a recipe change also affects already-punched items that have not
yet reached their deduction step.

Saving a recipe does not recalculate previous deductions. Cancelling a sent item
restores its original recorded quantities even if the recipe has since changed
or been removed. Settlement and reprinting do not deduct stock again.

Downgrading from Pro to Basic preserves recipes and history. Existing recipes
continue to deduct stock and cancellation continues to reverse original
deductions. Multiple-ingredient recipes become read-only until recipe editing is
enabled again. A recipe does not prevent ordering below zero stock; staff still
receive the existing stock warnings.
