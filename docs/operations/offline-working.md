# Working offline

Counters and captain tablets reach the ForkFlow server (the hub) over the
restaurant network. When that link drops, staff keep working. Each action is
saved on the device and sent to the hub when the link returns. The hub applies
each action exactly once.

## What keeps working

| Action | Offline |
|---|---|
| Open a table, add a split, start a takeaway from Tables | Yes. The order opens at once. |
| Add items, punch, send to the kitchen (KOT) | Yes. The kitchen ticket prints when the hub has the order. |
| Cancel an item or an order, edit a sent item | Yes. |
| Change the captain or the takeaway order type | Yes. |
| Issue a bill and take payment | Only from a bill preview fetched while connected. With the preview on screen, **Record payment** saves both steps together. |
| Preview a new bill, print, reports, settings, customers | No. These need the hub. |
| Quick takeaway checkout | Needs the hub, because checkout previews the bill. |

## What staff see

- **Working offline** banner on Tables and the order screen. It shows the time of
  the copy on screen. The copy is the last one this device loaded for the person
  signed in.
- Cart rows marked **Saved to send** or **Saved · goes to the kitchen when back
  online**.
- Orders and tables marked **Saved** while they have actions waiting, or
  **Review** when an action needs attention.
- The status bar at the bottom of the screen:
  - "Working offline · 3 saved actions"
  - "Sending 3 saved actions…"
  - "1 saved action needs review"
  - "Connected · All actions saved"
- If the page reloads while the hub is unreachable, the same person stays signed
  in and the app opens on Tables.

## Reviewing saved actions

Choose **Review saved actions** in the status bar. The list has two parts.

### Waiting to send

Each action shows its order, how long ago it was saved, and how many times it
was tried, with the last problem.

- **Try now** sends at once instead of waiting for the next retry.
- Retries back off from 1 second to 30 seconds.

### Needs review

The hub refused these actions. For example, the order was billed on another
counter before these items arrived. Each one gives the reason in plain words.

- **Retry** sends it again, after you fix the cause.
- **Open order** goes to the order to check it.
- **Discard** drops the action. It is never sent. If it was already tried, it
  may have reached the hub with only the reply lost, so check the order after
  discarding.

Actions for one order always go in the order they were made. One stuck order
never holds up the others.

## Several windows and devices

- **One device:** only one window or tab sends saved actions at a time. The
  window that saved an action still learns the result, even after a reload.
- **Separate devices:** each device sends its own saved actions. The hub ignores
  repeats, so a lost reply never creates a second order, a second KOT, a second
  bill or a second payment.

## After a restore from backup

If the hub was restored from a backup, saved actions from before the restore are
not sent. They are archived on the device for review, and staff are asked to sign
in again.

## For support

- **Where actions are kept:** in the browser's local storage on each device.
  - `forkflow.queue.v2.*` holds saved actions.
  - `forkflow.queue-result.v2.*` holds outcomes, kept for 24 hours.
  - `forkflow.cache.v1.*` holds offline copies.
- **How repeats are recognised:** the hub matches each action's reference, so
  sending the same action twice changes nothing. For a new order, the device
  chooses its id. For items sent to the kitchen, the device names them by the
  references it gave them.
- **Connection check:** the hub sends a heartbeat every 20 seconds. A device
  that hears nothing for 45 seconds reconnects, so "Connected" is accurate.
