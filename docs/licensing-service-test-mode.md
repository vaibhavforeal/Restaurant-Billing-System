# Licensing service: Razorpay test-mode checklist

A manual end-to-end run of the licensing service in Razorpay **test mode**. It needs your Razorpay test keys, so it is not automated. Do it against the test Worker environment before the live one; the deployment steps are in `apps/licensing-worker/README.md`.

> [!WARNING]
> The test Worker signs with its own **test** key pair (`C:\secure\license-test-private.pem`), never the production key. Anyone can pay the test Worker with Razorpay's public test card, so a test Worker holding the production key would hand out licences that production counters accept. The README's "What you need" and step 4 show how to set this up.

Use a disposable counter: a test build that embeds the **test** public key (`FORKFLOW_LICENSE_PUBLIC_KEY` from `C:\secure\license-test-public.pem`) and the test Worker's URL (`FORKFLOW_LICENSE_SERVICE_URL`), run with a fresh data folder so it is a new installation. Never give a test build to a restaurant. Keep `npx wrangler tail --env test` open in a terminal for the whole run.

Test-mode helpers (check Razorpay's current test-mode documentation if any of these has changed): test card `4111 1111 1111 1111` with any future expiry and any CVV, and the test UPI id `success@razorpay` (for a failing UPI payment use `failure@razorpay`).

## Setup

- [ ] The test Worker is deployed, its database migrated, the four secrets (with `LICENSE_SIGNING_KEY` from the test key pair) and the four plan-id variables set, and the Razorpay test-mode webhook points at `https://<test-worker>/webhooks/razorpay` for the five `subscription.*` events.
- [ ] `POST https://<test-worker>/v1/activate` with an invalid body answers `400`, not `500`, and `wrangler tail` shows no `rate limiter unavailable` line. (The Worker fails open if the rate-limit binding errors, which is what local `wrangler dev` currently does, so a deployed Worker that logs this line is running without rate limiting. Fix the binding before going live.)
- [ ] The counter starts, you complete setup, and you open **Settings > Plan and devices** as the admin.

## 1. A fresh install gets a trial

- [ ] Within a few seconds of starting (or after pressing **Check for renewal**) the plan reads **Pro**, state active, with the line "Pro trial — ends <date 14 days out>", and the history shows an install by "Automatic renewal".
- [ ] Register the browser (**Device name**, **Register this device**); the workspace unlocks.
- [ ] Press **Check for renewal** again: "Your licence is up to date." No second trial, no new history entry.
- [ ] **Subscribe** is shown (a trial is not a paid plan). It is a link that opens in a new tab.

## 2. Subscribe and pay

- [ ] **Subscribe** opens `https://<test-worker>/subscribe?installation=<this installation id>` in a new tab, showing plan, period and email.
- [ ] Choose Basic, monthly, enter an email and continue to Razorpay Checkout. Pay with the test card or `success@razorpay`.
- [ ] The success screen says "Payment received. Return to ForkFlow and press Check for renewal."
- [ ] In the Razorpay dashboard the subscription is `active` and the webhook shows a delivered `subscription.charged` with a `200` response.
- [ ] In `wrangler tail` there is no error (the Worker only logs problems). In Razorpay's webhook delivery view for the `subscription.charged` event, the response body is `{"outcome":"issued"}`.

## 3. Check for renewal installs revision 2

- [ ] Back in ForkFlow press **Check for renewal**: "A new licence was installed."
- [ ] The plan now reads **Basic**, the trial line is gone, **Manage plan** replaces **Subscribe**, the renewal date matches the subscription's next charge date in Razorpay, and the licence revision is 2.
- [ ] History shows the install by "Automatic renewal". Other open browsers update without a reload.
- [ ] Billing, the kitchen screen and a second registered device all keep working throughout.

## 4. An unknown installation cannot subscribe

- [ ] Open `https://<test-worker>/subscribe?installation=<a random UUID>` directly. It says "Open ForkFlow while connected to the internet, press Check for renewal in Settings > Plan and devices, then try again."

## 5. A plan change cancels the old subscription

- [ ] Press **Manage plan**, choose Pro, monthly, and pay. The new subscription is `active` in Razorpay.
- [ ] Until the new subscription's first charge succeeds the old one stays active (the restaurant is never left without a paid subscription).
- [ ] After the charge, the old Basic subscription shows `cancelled` in the Razorpay dashboard, and `wrangler tail` has no "could not cancel" message. If it is still active, cancel it by hand in the dashboard and note it in the run.
- [ ] **Check for renewal** installs revision 3 as **Pro**.

## 6. A failed charge issues nothing

- [ ] Start another subscription from **Manage plan** and let the payment fail (for example UPI `failure@razorpay`, or close Checkout without paying).
- [ ] No licence is issued: **Check for renewal** says "Your licence is up to date." and the plan and revision are unchanged.
- [ ] If a renewal charge on an active subscription is made to fail in test mode, Razorpay sends `subscription.halted` and the Worker records it with outcome `status`; the existing licence keeps running to its expiry and then its 7-day grace, and nothing new is issued.

## 7. Offline and error behaviour

- [ ] Disconnect the counter from the internet and press **Check for renewal**: "Couldn't reach the licensing service. Billing continues on your current licence." Billing pages still load.
- [ ] Reconnect and press it again: "Your licence is up to date."
- [ ] Re-deliver the same `subscription.charged` event from the Razorpay dashboard: the Worker answers `200` and issues nothing new (revision unchanged).

## Wrap-up

- [ ] Note any step that behaved differently from this list, with the `wrangler tail` output, before repeating the run in live mode.
- [ ] Cancel the test subscriptions in the Razorpay test dashboard and delete the disposable counter's data folder and the test build.
- [ ] Take the test Worker off the internet: `npx wrangler delete --env test`, or set `"workers_dev": false` in the `env.test` block of `wrangler.jsonc` and run `npx wrangler deploy --env test` again.
- [ ] Before going live, confirm the production Worker's `LICENSE_SIGNING_KEY` is the production key and the test Worker never held it.
