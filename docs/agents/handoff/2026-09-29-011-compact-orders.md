# Compact order workspace

The user requested smaller order-screen elements and no scrolling of the entire
order window. The dine-in, parcel, and quick takeaway screens now share a bounded
workspace that fills the viewport.

## Layout

- Slim icon navigation on desktop; reduced headers, padding, menu tiles, and
  cart rows. Search and category selection share one toolbar. Each portion is
  directly selectable as its own menu tile.
- Menu and order item lists scroll independently. Cart subtotal, Punch, Send to
  kitchen, and billing actions stay below the item list and remain visible.
- The displayed subtotal includes the open order's local cart. Closed orders
  exclude any stale local draft from their displayed total and item count.
- Phones use Menu / Order buttons and View cart rather than vertically stacking
  both panes. View cart moves keyboard focus into the visible order item list.
- Bill options, tax details, payment forms, and receipts use a native modal
  dialog. Checkout still prepares a takeaway immediately. Closing the dialog
  returns to the order; a settled takeaway then offers Next takeaway.
- The dialog is portaled to the document body so it stays visible even when the
  mobile menu hides the cart. Native focus trapping and Close/Escape guards
  protect the existing save flow. Long receipt/payment details scroll within
  the bounded dialog.

## Boundaries

No server, database, schema, licensing, payment, or stock rules changed. Billing
API payloads, retry identities, and save sequencing are unchanged. The existing
M10 browser scripts use the new category selector and modal navigation.

Relevant source: `App.tsx`, `screens/OrderScreen.tsx`, `order-screen.css`,
`screens/BillingPanel.tsx`, and `billing-panel.css` under `apps/ui/src`.

## Verification

Full TypeScript checks and UI production build passed. Browser verification uses
an isolated installation on port 4121, seeded with 40 dishes in eight categories,
long names, portions, and populated dine-in/parcel orders. The actual desktop
installation on port 4100 is kept separate from test data.

The baseline populated page was 2670px tall at 1366x768. The bounded layout fits
the viewport at 1366x768, 1024x768, 1280x600, 1920x1080, and 390x844. Checks cover
internal scrolling, pinned totals/actions, portion selection, mobile focus,
dialog resizing, visible billing errors while the mobile cart is hidden,
checkout, payment, receipt, and Next takeaway. Expanded low-stock warnings also
fit a 1280x600 window.

Both quick UPI payment and ordinary dine-in bill issue/cash settlement persisted
one exact payment. No browser page errors were recorded. Accumulated browser
assertions: 249, including the scoped final-build check. Results are stored in
`.e2e-scratch/compact-order-results.json`, with visual captures named
`compact-order-final-*.png`. The test browser and disposable server were stopped.

Existing M10 gate scripts were adapted and pass syntax checks. Their full
56+8 assertion runs were not repeated for this visual change.

The updated assets were copied into `build/desktop/app/ui`; port 4100 serves the
exact current index and `index-DD7hEXNQ.js` (content hash verified). No desktop
restart or database change was needed. The user's existing renderer needs
**Ctrl+R** to load the compact layout.
