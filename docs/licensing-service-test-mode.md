# Licensing service and portal: Razorpay test-mode checklist

A manual end-to-end run of the licensing service and the ForkFlow Portal in Razorpay **test mode**. It needs your Razorpay test keys, so it is not automated. Do it against the test Worker before the live one; the deployment steps are in `apps/licensing-worker/README.md`.

> [!WARNING]
> The test Worker signs with its own **test** key pair (`C:\secure\license-test-private.pem`), never the production key. Anyone with a portal account on the test Worker can issue licences, so a test Worker holding the production key would hand out licences that production counters accept.

Use a disposable counter: a test build that embeds the **test** public key (`FORKFLOW_LICENSE_PUBLIC_KEY` from `C:\secure\license-test-public.pem`) and the test Worker's URL (`FORKFLOW_LICENSE_SERVICE_URL`), run with a fresh data folder so it is a new installation. Never give a test build to a restaurant. Keep `npx wrangler tail --env test` open in a terminal for the whole run.

Test-mode helpers (check Razorpay's current test-mode documentation if any of these has changed): test card `4111 1111 1111 1111` with any future expiry and any CVV, and the test UPI id `success@razorpay` (for a failing UPI payment use `failure@razorpay`).

## Setup

- [ ] The test Worker is deployed with the portal built, its database migrated (`0001` to `0007`), and the four secrets set (`LICENSE_SIGNING_KEY` from the test key pair). The Razorpay test-mode webhook points at `https://<test-worker>/webhooks/razorpay` for the four `payment_link.*` events.
- [ ] `POST https://<test-worker>/v1/activate` with an invalid body answers `400`, not `500`, and `wrangler tail` shows no `rate limiter unavailable` line. (A deployed Worker that logs this line is running without rate limiting. Fix the binding before going live.)
- [ ] The first admin was created with `tools/portal-create-admin.ts` and can sign in at `https://<test-worker>/portal/`. Settings has the seller details (legal name, state, GSTIN), the invoice wording and a price list.
- [ ] Add a sales user and an accounts user from **Staff**; each signs in with the temporary password and is made to choose a new one.

## 1. A lead becomes a customer with a trial

- [ ] As the sales user, add a lead and a follow-up on it; **Today** and **Follow-ups** show it.
- [ ] **Convert to customer**: the customer has a Customer ID, the sales user as its rep, and the follow-up moved across.
- [ ] **Start a trial**: the trial order is ready at once and shows the setup card.
- [ ] Start the disposable counter. Setup asks for the Customer ID and Order ID.
  - A typo (change one character) is refused on the counter with "Check the Customer ID and Order ID" and nothing is sent.
  - The right pair activates: the setup shows "Activated for <customer>: Pro trial until <date>", the restaurant name is filled in, and after the admin step the counter opens without a device-registration step.
- [ ] In the portal the customer's **Counters** shows the counter on the timeline with its version and "last seen"; the order shows 1 of 1 outlets activated.

## 2. A paid order, by payment link

- [ ] Draft an order for the same customer (Pro, 1 year, 1 outlet) and confirm it. The order shows CGST and SGST (same state as the seller) or IGST, and the totals match the preview.
- [ ] **Send payment link**. Razorpay test mode sends an SMS or email (see the Razorpay dashboard), and the order lists the link.
  - Pay it with the test card or `success@razorpay`.
- [ ] Within seconds the order is **Paid**:
  - the payment is listed as Razorpay;
  - the tax invoice `FF/<year>/00001` is listed, and its PDF opens with every field filled in;
  - in Razorpay's webhook delivery view the `payment_link.paid` response is `{"outcome":"paid"}`.
- [ ] On the counter, **Settings > Plan and devices > Activation details > Use a different Order ID** with the paid order's ID moves the counter from the trial to the paid order. The trial line disappears and the paid end date shows; the trial order's seat is free again.
- [ ] Re-deliver the same `payment_link.paid` event from the Razorpay dashboard: the Worker answers `200 {"outcome":"duplicate"}` and nothing changes.

## 3. Offline payments, credit and a renewal

- [ ] Draft a second order and confirm it; as the admin **Approve on credit** until next week. A second disposable counter activates with it, and its licence ends on the credit date.
- [ ] As the accounts user, **Record payment** for part of it (UPI). The order still waits.
  - Record the rest as a cheque, *not cleared yet*: still waiting.
  - **Cleared**: the order is paid, its invoice is issued (`00002`), and the counter's licence reaches a year from activation at its next check.
- [ ] **Renewals** lists the counters by end date. **Renewal order** on one of them opens a renewal draft for that counter. Confirm and record its payment: the counter's licence is extended from its current end date, and **Check for renewal** installs it.

## 4. Counters and support

- [ ] On a counter, admin: block a module and save. The counter shows "Waiting for its next check-in" until **Check for renewal**, after which the counter refuses that module.
- [ ] **Change this licence**: add devices with a reason; the counter's device limit rises after **Check for renewal**, and the activity log shows the reason.
- [ ] As support: **Release seat** on a counter, then a fresh counter activates with the same IDs. **Reset pairing** on a counter, then its next check-in claims it again.
- [ ] Open a support ticket for the customer, add a note (it becomes "Working on it"), resolve it; Reports counts it.
- [ ] Disconnect a counter from the internet and press **Check for renewal**: "Couldn't reach the licensing service. Billing continues on your current licence."

## 5. Who sees what

- [ ] A second sales user does not see the first user's lead, customer, orders or tickets (each opens as "not found"), and Reports shows only their own figures.
- [ ] The accounts user can record payments but not edit customers or draft orders; support can release seats but not change licences.

## Wrap-up

- [ ] Note any step that behaved differently from this list, with the `wrangler tail` output, before repeating the run in live mode.
- [ ] Delete the disposable counters' data folders and the test build.
- [ ] Take the test Worker off the internet: `npx wrangler delete --env test`, or set `"workers_dev": false` in the `env.test` block of `wrangler.jsonc` and run `npx wrangler deploy --env test` again.
- [ ] Before going live, confirm the production Worker's `LICENSE_SIGNING_KEY` is the production key and the test Worker never held it.
