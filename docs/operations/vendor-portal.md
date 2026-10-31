# MasalaPOS Portal

The portal is where MasalaPOS's own staff run the business. It covers leads and follow-ups, customers, orders and payments, GST tax invoices, the counters each customer runs (their licences, modules and seats), renewals, support tickets and reports.

It lives at `https://<licensing-service>/portal/`. Setting it up (deploying, the first admin, Razorpay) is in the [licensing worker README](../../apps/licensing-worker/README.md).

## The whole journey

1. **Lead.** A restaurant shows interest. Add it under **Leads** with how it found us, and plan follow-ups (a call, a demo).
2. **Customer.** When it is ready to try or buy, **Convert to customer**. The customer gets a **Customer ID** such as `FC-7K3M-9QX`.
3. **Trial (optional).** On the customer, **Start a trial** makes a free trial order, ready at once. Its length comes from Settings and is 7 days by default.
4. **Order.** **New order** prices the outlets, devices and extra lines from the price list. **Confirm** fixes the price. The order gets an **Order ID** such as `FO-2X8H-PD4`.
5. **Setup card.** Every order shows both IDs, large, with **Print**. At first run, MasalaPOS asks for them; the counter then gets the order's licence and takes one of its seats.
6. **Payment.** Either way, the order is paid when the money covers it:
   - **Send payment link**: Razorpay texts and emails the customer, and the payment records itself.
   - **Record payment**: for cash, bank transfer, UPI, card or cheque.
7. **Invoice.** The GST tax invoice is issued automatically when the order is paid in full. Download the PDF from the order or from **Invoices**.
8. **Renewal.** **Renewals** lists licences ending soon. **Renewal order** extends the chosen counters when it is paid; each counter's licence then reaches from its current end date (or today, if it has ended) to the end of the new term.

## Who can do what

| | Admin | Sales | Accounts | Support |
| --- | --- | --- | --- | --- |
| Leads and their follow-ups | All | Their own | — | — |
| Customers | All | Their own: add, edit | See all | See all |
| Orders | All, plus credit and cancelling | Their customers': draft, confirm, payment links | See all | See |
| Payments and invoices | All, plus cancelling an invoice | See their customers' | Record payments, clear cheques, issue invoices | — |
| Counters and licences | Change licences and modules, move a counter, offline licences | See their customers' | — | Release a seat, reset pairing, download a licence |
| Support tickets | All | Read their customers' | — | All |
| Renewals, reports | All | Their own figures | All figures | All figures |
| Staff, settings, activity log | Yes | — | — | — |

"Their own" is enforced by the server, not just hidden on screen. A record outside someone's reach answers as if it did not exist.

## Staff accounts

- An admin adds staff under **Staff** with a temporary password. Each person chooses their own at first sign-in.
- Changing a role or deactivating someone signs them out at once. **Reset password** gives a new temporary one.
- The portal always keeps at least one active admin.
- A session lasts 12 hours, or 2 hours without use. Five wrong passwords lock an account for 15 minutes.

## Customer and Order IDs

- Both are a prefix and seven characters: `FC-` for customers, `FO-` for orders. The last character is a check character, so a typo is caught on the counter before it goes online.
- They are typed without caring about case, spaces or dashes; `I` and `L` read as `1`, and `O` as `0`.
- At setup, a wrong pair, an unknown order and another customer's order all get the same answer: "Check the Customer ID and Order ID". So the IDs cannot be probed.
- A counter can activate with an order only when it is:
  - paid;
  - approved on credit and still within the credit date;
  - or a trial.
- A draft, a cancelled order and a renewal order cannot activate a counter.

## Orders

- **New outlets.** The licence line is the price per outlet times the outlets.
  - Devices beyond the plan's (Basic 2, Pro 5) add an "Extra devices" line at the price in Settings.
  - Extra lines (installation, training) can be added with their own SAC.
  - A discount reduces the licence line.
- **Renewal.** Choose the customer's counters to extend. The licence line counts the counters chosen.
- **Trial.** Free, no invoice, ready at once.
- **GST.** CGST and SGST when MasalaPOS and the customer are in the same state, IGST otherwise.
  - The customer's state comes from their GSTIN, or from their address when they have none.
  - An order can be confirmed only when both states are known and the seller details are filled in.
- **On credit.** An admin can let a confirmed order activate before payment, until a date.
  - The counters' licences end on that date.
  - When the order is paid they get the full term from the day each activated. Extending the credit date re-signs them.
- **Cancel.** Only an admin, and only before any payment. Counters already active keep their licences until they end.

## Payments

- **Record payment** (Accounts or admins). A cheque can be recorded as *not cleared yet*; it counts only when marked **Cleared**, and a bounced one never counts.
- **Payment links** (Sales or admins) go to the customer's phone and email, for what is still owed. Razorpay needs at least one of the two on the customer.
  - Each link stays open for 15 days.
  - A new link can be sent at any time; when one is paid, the order's other open links are cancelled.
  - Cancelling an order cancels its links.
- The payment that covers the order completes it at once:
  - the order is paid;
  - counters on credit get their full term;
  - a renewal extends its counters;
  - the tax invoice is issued.
- An overpayment is shown on the order, to refund by hand.

## GST tax invoices

- Numbered `FF/26-27/00001`: the prefix from Settings, the Indian financial year (April to March, in India time), then a running number. Numbers never repeat or skip. GST allows at most 16 characters.
- An invoice copies the seller, the buyer and the lines as they were when issued. Later edits to Settings or the customer do not change it.
- The PDF carries every field a tax invoice needs:
  - seller and buyer names, addresses and GSTINs ("Unregistered" when the buyer has none);
  - the invoice number and date, the place of supply, and "Reverse charge: No";
  - SAC, quantity, rate and taxable value per line;
  - CGST and SGST or IGST with their rates, and the total in figures and in words;
  - the bank details and terms from Settings;
  - the signatory line.
- **Issue invoice now** (Accounts) invoices a credit order before it is paid. Payment later issues no second invoice.
- **Cancel** an invoice (admins) only before it goes into a GST return; a corrected invoice then takes the next number. Credit notes are not issued by the portal yet.
- **Invoices** lists every invoice, filtered by month for the GST return.

## Counters

Each customer's **Counters** tab and every order show the licences on one timeline. Each bar runs from the day the counter activated to its end date. The lighter end is the grace period, when billing still works but the licence is due. A line marks today. Open a counter for:

- **Licence**: plan, devices, end date, revision. **Waiting for its next check-in** means a new revision is signed but the counter hasn't collected it; it does within the hour.
- **Last seen** and the MasalaPOS version the counter reports.
- **Modules** (admins change them): see [Feature controls](feature-controls.md).
- **Change this licence** (admins): another plan, end date or number of devices, with a reason that goes into the activity log. Use it for a goodwill extension or a correction.
- **Move to another order** (admins): for example from the trial to the paid order, when the restaurant doesn't re-enter the IDs itself. The term starts that day.
- **Release seat** (Support): for a counter that died or was reinstalled.
  - The order can then activate the new computer.
  - The old computer's licence is signed and offline, so it keeps working until it ends.
- **Reset pairing** (Support): after the restaurant restored its data folder and now holds a different installation secret. The next computer to check in with that installation ID claims it.
- **Download licence file** (Support): for a counter that can't reach the service.

**A counter without internet:** on the counter, Settings › Plan and devices › Activation details › **Download activation request**. In the portal, open the order and choose **Activate a counter without internet**, then pick that file. The counter takes a seat and you get its licence file to apply on the counter.

## Follow-ups, leads and support

- **Follow-ups** are dated tasks on a lead or a customer: a call, a visit, a demo, WhatsApp, email, a renewal or a payment.
  - Each person's list puts overdue first. Closing one records what happened, or moves it to another day.
  - Admins can give one to a colleague and look at anyone's list.
- **Leads** move through the stages: new, contacted, demo booked, demo given, proposal sent, then won or lost.
  - A lost lead needs the reason, and its open follow-ups are dropped.
  - Converting a lead keeps its rep and moves its open follow-ups to the new customer.
- **Support** tickets are numbered from T-1001. Each one has:
  - a customer and, optionally, a counter;
  - a kind, a priority and the person it's with;
  - notes. Adding the first note marks it as being worked on.
  - Urgent means the restaurant can't bill.

  Support sees "Mine and unassigned" first.

## Today, renewals and reports

- **Today** opens on:
  - your follow-ups (overdue, then due later today);
  - money waiting on confirmed orders;
  - licences ending in 30 days;
  - open tickets and the lead pipeline;
  - this month's payments, invoices and new customers.
- **Renewals** shows paid licences ending in the next 7, 30 or 60 days, those that ended in the last 90 days, and running trials. For each it shows any renewal order or follow-up already in hand, with **Renewal order** and **Follow up** one click away.
- **Reports** covers this financial year, or the last 90 or 30 days:
  - payments received by month (the last 12) and paid orders by plan;
  - the lead funnel and where leads came from, with win rates;
  - each rep's leads won, orders paid and what they were worth;
  - licences renewed on time and trials that bought;
  - support volumes and the median time to resolve.

  A sales rep sees only their own customers and leads.

## Activity

Every change, by staff, by a payment or by a counter activating, is written to the activity log in the same step as the change itself, so the log never shows something that didn't happen. Each customer has an **Activity** tab. Admins see everything under **Activity**, filtered by person or by kind of record.
