# ForkFlow Portal: redesign brief

For an agent (or person) redesigning the portal's look and layout. It covers what the portal is, how to get a safe working copy, who can do what, every page and sub-surface, the current design system, and the rules a redesign must keep.

Scope: the **web app** in `apps/portal`. The API, the database and the licensing logic live in `apps/licensing-worker` and are not part of a redesign. Keep them as they are unless a screen truly needs new data, and then say so first.

## 1. What the portal is

An internal web app for the ForkFlow team (staff), not for restaurants. ForkFlow sells its restaurant POS through a sales team, so the portal runs that business:

- keep **leads** and **follow-ups**, turn a lead into a **customer** with a Customer ID;
- price an **order** (new outlets, a renewal, or a 7-day trial) with GST, take payment (cash, bank, UPI, cheque or a **Razorpay payment link**), issue a **GST tax invoice** (PDF);
- paying an order issues the **licence** for the customer's **counters** (a counter is one restaurant computer running the POS). A counter activates by entering a Customer ID and an Order ID;
- watch **renewals**, run **support tickets**, see **reports**, and keep an **activity log**.

Money is stored and sent as **paise** (integers). Dates are milliseconds since the epoch. The UI is English, India-formatted (`Rs. 1,23,456.00`, Indian digit grouping, India time).

## 2. Access

### The live test portal (do not use it for design work)

- URL: `https://portal.billnroll.in/portal/` (a test environment with a test signing key and Razorpay **test** keys).
- It holds the owner's real test data and one admin account. **Credentials are not in this repo and must not be shared with a redesign agent.** Ask the owner to sign in for you, or to give you a screenshot.

### A local sandbox (use this)

You need Node 22+ and the repo's `npm install`.

```powershell
# 1. Build the portal and the Node host once (and again after UI changes if you serve the built copy)
npm.cmd run build -w @forkflow/portal
npm.cmd run build -w @forkflow/licensing-node

# 2. Start a throwaway server on a free port (8811 here; 8799 is often taken by `wrangler dev`). Use your own temp folder.
$env:LICENSE_SIGNING_KEY = (node -e "console.log(require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))")
$env:RAZORPAY_KEY_ID = "rzp_test_dummy"; $env:RAZORPAY_KEY_SECRET = "dummy"; $env:RAZORPAY_WEBHOOK_SECRET = "dummy"
$env:PUBLIC_ORIGIN = "http://127.0.0.1:8811"; $env:PORT = "8811"; $env:DATA_DIR = "$env:TEMP\portal-sandbox"
node apps/licensing-node/dist/main.mjs

# 3. In another terminal: staff accounts and sample data (customers, leads, orders, payments, tickets, follow-ups)
node --import tsx tools/portal-dev-seed.ts "$env:TEMP\portal-sandbox\licensing.db" --api http://127.0.0.1:8811

# 4. Work on the screens with hot reload; Vite passes /portal/api to the server above
$env:PORTAL_WORKER_URL = "http://127.0.0.1:8811"
npm.cmd run dev -w @forkflow/portal      # then open the URL it prints, plus /portal/
```

If you only want the built copy, open `http://127.0.0.1:8811/portal/` after step 2 and rebuild the portal to see changes.

**Sandbox accounts** (local only, password for all: `portal-demo-pass`):

| Email | Role | What to look at |
|---|---|---|
| `vaibhav@forkflow.test` | Admin | everything, including Staff, Settings, Activity |
| `ritu@forkflow.test` | Sales | owns 3 of the 5 customers and some leads; sees only her own |
| `kabir@forkflow.test` | Sales | the other rep, for checking that a rep can't see a colleague's records |
| `imran@forkflow.test` | Accounts | payments and invoices; no leads, no support |
| `neha@forkflow.test` | Support | tickets, counters, follow-ups; no orders to edit |

Check **every screen as every role**: navigation items, buttons and whole pages change with the role.

### Roles and permissions

Source of truth: `apps/licensing-worker/src/portal/shared.ts` (`PERMISSIONS`). The server enforces it; the UI only hides what a role can't do. A redesign must keep both in step (use `roleCan(role, permission)`, as the screens already do).

| Permission | Admin | Sales | Accounts | Support |
|---|:-:|:-:|:-:|:-:|
| See customers, orders, invoices, renewals, reports | yes | yes (own only) | yes | yes |
| Add / edit customers, create / edit / confirm orders, send payment links | yes | yes (own only) | no | no |
| Leads (read, write) | yes | yes (own only) | no | no |
| Follow-ups | yes | yes (own only) | no | yes |
| Support tickets: read / write | yes / yes | read only | no | yes / yes |
| Record payments and issue invoices | yes | no | yes | no |
| Cancel orders, approve credit, cancel invoices | yes | no | no | no |
| Counter licence, modules, move counter, offline licence | yes | no | no | no |
| Counter support: download licence, release seat, reset pairing | yes | no | no | yes |
| Staff, Settings, Activity | yes | no | no | no |

"Own only" means the server returns only records owned by that rep. A wrong role gets a 403/404 and a plain-words message; the UI shows "This page doesn't exist, or your role can't open it."

## 3. Technology and structure

- **React 19 + TypeScript + Vite 8.** No UI library, no router library, no state library, no CSS framework. Plain CSS in one file with design tokens.
- Served by the server under **`/portal/`** (Vite `base`). The build goes to `apps/portal/dist/portal`.
- **API base** `/portal/api`, same origin, session cookie (HttpOnly). All calls go through `src/api.ts` (`api`, `post`, `patch`, `put`, `del`, `query`); errors come back as `ApiError` with plain-words messages shown to the user.
- **Shared code** is imported straight from the worker package: `../../licensing-worker/src/portal/api-types` (all request/response types) and `.../shared` (roles, permissions, GST states, money helpers). Do not copy these; do not change a type without changing the API and its tests.

```
apps/portal/src/
  main.tsx          mounts <App/>, imports portal.css
  App.tsx           session states (loading / signed out / forced password change / signed in), the Shell, and the route table
  router.tsx        tiny History router: match(), navigate(), Link, useLocation, useLeaveGuard (unsaved-form prompt)
  api.ts  format.ts API client; date/number/plural formatting
  ui.tsx            PageHead, Tabs, Pill, Field, Dialog, Person, EmptyRow, LoadError, CopyButton, useData, useRun
  icons.tsx         inline SVG icons and the ForkFlow mark
  Search.tsx        global search box in the top bar
  portal.css        the whole design (294 lines): tokens, layout, tables, forms, dialogs, responsive, print
  screens/          one file per page (below)
```

### Hard rules from the server (a redesign must respect these)

- **Content Security Policy:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'`. So: no CDN scripts, no web fonts from other hosts (ship fonts in the bundle or use the system stack), no `<style>` tags or inline `<script>`, images only from the site or `data:` URIs. Setting `style` through React's `style={{...}}` is fine (it uses the CSSOM, not markup).
- The app is **not framed** (`X-Frame-Options: DENY`) and sends `no-referrer`.
- Every change request (POST/PUT/PATCH/DELETE) must come from the portal's own origin; the `api` helper already does that.
- Money shows as `Rs.` (the invoice PDF font has no rupee sign). Use the existing `format.ts` / `shared.ts` helpers.

## 4. Pages and sub-pages

Routes below are relative to `/portal`. "Dialog" means a modal opened from the page (not a route). Pages not listed for a role are hidden from its navigation.

### Sign-in and account

| Route / surface | What it is |
|---|---|
| (signed out) | **Sign in**: email and password; one message for every refusal; a locked account looks like a wrong password; rate-limited. |
| (forced) | **Change password**: shown instead of the app when an admin set a temporary password. |
| `/account` | **Your password**: change your own password (ends your other sessions). |

### Navigation (the Shell)

Left sidebar: brand, **Workspace** group (Today, Follow-ups, Leads, Customers, Orders, Invoices, Renewals, Support, Reports), **Administration** group (Staff, Settings, Activity; admin only), account block (name, role, Password, Sign out). Top bar: menu button (phone), a "Workspace > current section" label, **global search**, account link. On narrow screens the sidebar becomes a slide-in menu with a focus trap. `/` redirects to the first allowed item.

### Workspace

| Route | Who | Content and actions |
|---|---|---|
| `/home` ("Today") | all | Greeting and "Business overview". Cards: **Your follow-ups** (overdue / due today), **Waiting for payment** (confirmed orders and what is owed), **Open tickets** (or "Your tickets" for support), **Lead pipeline** (counts by stage), **Licences ending soon** (next 30 days, plus already ended). Each card links to its list. Admin sees everyone's; a rep sees their own. |
| `/follow-ups` | admin, sales, support | List of calls, visits and demos. Tabs **To do / Done** (Done includes dropped ones). Admin can switch whose list (Mine / Everyone's / a colleague). Each row can be marked done with an outcome, moved to another day, or dropped. |
| `/leads` | admin, sales | Pipeline list with tabs **Open, New, Contacted, Demo scheduled, Demo done, Proposal, Won, Lost** (counts on each), search, and **Add lead** (dialog). Shows open pipeline value. |
| `/leads/:id` | admin, sales | **Lead**: Details (contact, source, expected plan/outlets/value, owner), stage buttons (a lost lead needs a reason), **Follow-ups** for this lead, activity, **Convert to customer**. |
| `/customers` | all | Search, a **sales rep** filter and owner column (hidden for a sales rep, who only has their own), paged list, **Add customer** (dialog, admin and sales). |
| `/customers/:id` | all | **Customer** with tabs **Overview, Orders, Counters, Follow-ups, Support** (if allowed), **Activity**. Overview: Details (edit, owner change), Licences summary, Recent orders. Counters tab: the customer's counters with licence state, plan, expiry; opens the **Counter dialog**. Buttons: New order, New trial, renewal shortcuts. |
| `/orders` | all | Tabs **Waiting for payment, Drafts, Paid, Cancelled, All** with counts, search by Order ID or customer, **New order**. |
| `/orders/new` | admin, sales | **Order editor**: tab for kind (New outlets / Renewal / Trial), customer, plan, term, outlets, devices, module choices, price per outlet, discount, extra lines, live **Invoice preview** (GST split by state). Query params prefill customer / kind / counters. |
| `/orders/:id/edit` | admin, sales | The same editor for a draft. Unsaved changes are guarded. |
| `/orders/:id` | all | **Order**: summary and lines, totals with CGST/SGST or IGST, a **Payment** panel (what is owed and paid; **Record payment** dialog for cash, bank, UPI, cheque or card; **Send payment link** (Razorpay); the list of payments with a pending cheque's **Cleared / Bounced**; the list of payment links with copy and cancel; the invoice with **Issue invoice**, PDF download and **Cancel invoice** dialog), **Counters on this order** (seat strip; opens the Counter dialog), **Setup card** (Customer ID and Order ID for the restaurant), dialogs **Approve on credit** and **Activate a counter without internet** (offline licence file), Cancel order, activity. |
| `/invoices` | all | Invoice list only (no invoice detail page): search by number or customer, a month picker, total value not counting cancelled ones. The invoice number is a link that downloads the PDF; cancelled invoices are struck through. Customer and Order links. |
| `/renewals` | all | Counters grouped by when their licence ends: tabs **Next 7 days, Next 30, Next 60, Ended, Trials**, with counts; each row shows plan, rep, whether a renewal order exists, and a button to create the renewal order. |
| `/tickets` | admin, sales (read), support | Support list with tabs **Mine and unassigned** (admin, support), **Open, Resolved and closed, All**; search by T-number, subject or customer; **New ticket** (dialog, support/admin). |
| `/tickets/:id` | admin, sales (read), support | **Ticket**: status, priority, assignee, category, linked counter, comment thread, add comment (first support reply moves it to "Working on it"). |
| `/reports` | all | Period picker (this financial year, 90 days, 30 days). Four KPI tiles (received in 12 months, leads won %, renewed on time %, trials that bought %); **Payments received by month** (a 12-column bar chart with a table beneath); **Paid orders by plan** (bars); **Leads added, by where they are now**; **Where leads came from** (win rate by source); **Sales reps** (admin: leads won, orders paid, worth); **Support** (opened, resolved, median hours to resolve, open now by priority). A rep sees their own. |

### Administration (admin only)

| Route | Content and actions |
|---|---|
| `/admin/users` | **Staff**: list with role and status, status pills (Deactivated, Locked for now, Temporary password), **Add staff** (dialog, temporary password of at least 10 characters), edit name/role, **Reset password**, **Deactivate / Reactivate**, and the **What each role can do** table. |
| `/admin/settings` | **Seller on invoices** (legal name, GSTIN, address, state, contact), **Invoice wording** (prefix, SAC, GST rate, bank details, terms), **Price list** and extra-device price, trial length. |
| `/admin/activity` | **Activity**: every change in the portal, newest first, "Load more". Filters **Who** (Everyone / ForkFlow (automatic) / a staff member) and **What** (Customers, Orders, Counters, Invoices, Payments, Leads, Follow-ups, Tickets, Staff, Settings). Rows link to their record. |

### Counter dialog (opened from a customer or an order)

A counter's licence state and last check-in, then, by role: **Download licence file** (admin, support), **Release seat** and **Reset pairing** (admin, support), **Change licence** (plan, devices, expiry, with a required note; admin), **Modules** (per-counter on/off/follow-plan with a history of changes; admin; support sees it read-only), **Move to another order** (admin).

## 5. Current design system

Declared at the top of `portal.css`; keep a redesign's tokens in one place like this.

- **Look:** a tinted "L" chrome (sidebar + top bar) with the work on a white rounded sheet inset 8px from the window edge. ForkFlow red (`#b92335`) is the accent for data, the selected tab and focus; the one primary action per screen is near-black. Text is Segoe UI Variable / system stack.
- **Tokens:** colours (`--chrome --surface --raised --active --border --rule --control --text --muted --accent --primary --positive --negative --warning`, plus pill background/ink pairs), type (`--fs-title 24px`, section 16, body 14, small 12), spacing (`--pad 24px`, `--gap 16px`, `--card-pad 20px`), radii (sheet 16, card 10, control 8), sizes (sidebar 228px, top bar 48px, control 34px, row 48px).
- **Components** (`ui.tsx`): `PageHead` (title, sub-line, actions, back link), `Tabs` (with counts), `Pill` (tones: neutral, positive, negative, warning, accent), `Field` (label + hint), `Dialog`, `Person`, `EmptyRow`, `LoadError`, `CopyButton`, hooks `useData` (load + reload on key) and `useRun` (busy/error for actions).
- **Patterns:** data tables with a `stack-phone` class (rows become cards on phones, `phone-hide` columns drop away), KPI tiles, panels with a head, two-column grids (`grid-main`), "rail" side panels, toolbars with a search box.
- **Responsive:** breakpoints at 1100px and 900px; the sidebar becomes a menu on phones. Staff do use it on phones.
- **Accessibility already present** (keep it): skip link, `aria-current` on navigation, focus trap and Escape in the mobile menu, labelled form fields, focus rings, `prefers-reduced-motion`, a print stylesheet. No dark mode today.

## 6. Rules for the redesign

1. **Do not change behaviour:** same routes, same permissions, same API calls and payloads. Layout, styling, copy and component structure are yours to change.
2. **Keep role-aware UI:** anything the server refuses for a role should stay hidden or disabled for it, using `roleCan`.
3. **Respect the CSP** (section 3) and keep the app free of external requests.
4. **Keep plain-words error and empty states.** Every list has a loading, empty and error state (`EmptyRow`, `LoadError`); keep all three for each screen.
5. **Keep forms safe:** the leave guard on the order editor, disabled buttons while saving, confirmations for cancelling an order or an invoice.
6. **Numbers:** paise in, `Rs.` out, Indian grouping, India dates. Don't format money by hand.
7. **Keep it dependency-light.** Ask before adding a library; the bundle is currently about 385 kB (110 kB gzipped).
8. **Accessibility:** keyboard-operable everywhere, visible focus, contrast that passes WCAG AA, tap targets that work on a phone.

## 7. Checking your work

```powershell
npm.cmd run typecheck -w @forkflow/portal      # must stay clean
npx vitest run apps/portal apps/licensing-worker   # the router test and every API test
npm.cmd run build -w @forkflow/portal          # must build
```

Then walk every page in the sandbox as each of the five accounts, on a wide window and a phone-width window, with the seed data and with an empty database (skip the seed step for the empty case).

## 8. Known gaps a redesign could address

- There is no screen listing all counters across customers; counters are reached through a customer or an order.
- Customers and orders list with simple search only; no saved filters or sorting controls.
- Reports have one hand-built bar chart and a few tables; there is no charting library and nothing interactive beyond hover titles.
- No dark mode and no user-facing theme or density setting.
- The portal has no notifications; overdue follow-ups and renewals only appear on Today and their lists.

## 9. Pointers

- API reference and operations: `apps/licensing-worker/README.md`.
- All request and response shapes: `apps/licensing-worker/src/portal/api-types.ts`.
- Routes and their permissions: `apps/licensing-worker/src/portal/*.ts` (search for `path("`).
- Tests that show real payloads for every action: `apps/licensing-worker/src/portal/*.test.ts`.
- Deployment of the live test portal: the owner handles this; a redesign is delivered as a branch and a pull request.
