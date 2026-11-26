# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Astro static site in `website/`, output deployed later to S3 + CloudFront on the owner's AWS account (deploy needs separate approval). No backend: the demo form hands off to WhatsApp or email.

## Users
Owners and managers of all kinds of Indian food businesses (restaurants, cafés, cloud kitchens, QSRs), deciding whether to buy a billing system. They are reached through a sales conversation, so the site's job is to earn a demo request or a WhatsApp message.

## Product Purpose
MasalaPOS is a Windows restaurant billing and POS system for India. One restaurant PC hosts it, and counters, waiter phones and kitchen screens connect over the restaurant LAN. Success for the site: a visitor books a demo or messages on WhatsApp.

## Positioning
Built for Indian restaurant operations: GST-ready billing (CGST/SGST, GSTR-1, GSTR-3B, CMP-08 exports), a native Android Captain app, and offline-from-internet working. Sold through demos, with no public price list. The owner states there will be no per-captain or per-device fee (unlimited captains and devices). This is a licensing change that has not shipped yet, so the claim stays switchable until it does.

## Operating Context
Counters and captains keep working if the internet drops; the hub PC must stay on. Windows installer; backups are local. Support through in-POS live chat. Printing to 58/80 mm thermal and A4 receipts.

## Capabilities and Constraints
Confirmed in `README.md` and `docs/operations/*`: GST billing, split payments, UPI QR on bills, credit notes, tables, KOT, guest QR menu, kitchen display, Captain app, inventory, recipes and dish costing, reports, Dynamic Reports dashboard, optional AI assistant (customer data never sent), CRM and loyalty, an online food aggregator desk (orders entered manually, payouts reconciled by CSV).
Not to be claimed: live Zomato or Swiggy integration, any brand names of aggregators, cloud sync, multi-outlet, remote support, installer signing, rupee prices.

## Brand Commitments
Name: MasalaPOS. English only at launch. Primary site colour: warm turmeric/saffron orange (the owner's choice, because masala goes with orange). The product's own accent is red (`#b92335`), and its logo (`apps/portal/public/favicon.svg`) stays red unless an orange site-only variant is approved. Domain masalapos.com will come later. A competitor's site (petpooja.com/poss) is a structure reference only; nothing is copied from it.

## Evidence on Hand
Real app screenshots will be captured from the running app with demo data (Phase 2). Older shots exist in `docs/screenshots/`. No customer testimonials, logos, case studies, press or benchmark numbers exist, and none may be invented. The WhatsApp number comes from the owner at build time; the email is undecided.

## Product Principles
1. Every claim on the page maps to a doc in `docs/operations/`.
2. Say what the software does for a restaurant day, not generic "powerful" language.
3. Show the real product, not mock dashboards.
4. One clear next step: book a demo or message on WhatsApp.
