# Order analytics

Open **Reports & Analytics**, then choose **Analytics** from the switch at the top. Choose **Reports** to return to Bills, Sales, Collections, Day-end / GST or detailed reports; the selected report is remembered. Bills includes the existing Unpaid, Paid and All bills filters and opens individual bills. Use Today, 7 days, 30 days or a custom date range, then Refresh to read the current saved data.

- **Quick takeaway vs table orders:** compares billed order counts, shares, issued sales and average order values. Quick takeaway covers all parcel orders, including held takeaways; each dine-in split counts as its own order.
- **All orders / Quick takeaway / Table orders:** filters the metrics, items, categories, daily trend and busy hours. The comparison remains across both order types for the selected dates.
- **Highest moving items:** ranks items and variants by quantity or issued sales. Shows takeaway/table quantities, distinct billed orders and sales. Initially displays the top 10; Show all reveals the rest.
- **Daily order trend:** use the pointer or focus the chart and press Left, Right, Home or End to inspect exact dates and totals.
- **Category performance:** quantities, distinct orders and issued sales, using categories saved at billing.
- **Busy hours:** all 24 local bill hours. Select a bar to inspect its order count and sales; the peak is the hour with the most billed orders.
- **Export analytics CSV:** downloads all sections and all items in the selected ranking from the displayed snapshot. The file includes the date range, timezone, filter, methodology and decimal rupee amounts.

Analytics use bill issue dates in the server timezone, including unpaid and complimentary bills. Open orders, void bills and cancelled items are excluded. Item sales use immutable reporting lines with allocated discounts, GST and rounding, so totals reconcile with the stored bills. Catalog edits do not reprice or rename history. Categories for bills predating tracking can be unavailable.

Admin and cashier users have access through the existing reports permission. The read-only `/api/reports/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&type=all` endpoint also accepts `parcel` or `dine_in`. Date validation and the 366-day range limit match Sales reports. Order counts across item/category rows overlap and should not be added together.
