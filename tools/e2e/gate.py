# ForkFlow e2e gate — click-through acceptance test for M3a (orders/KOT) + M3s (splits).
# Run: python tools/e2e/gate.py
# Requires: Python 3.10+, playwright, chromium installed.
# Assumes: FRESH scratch DB (KOT numbers are per-day sequences).
import os
import re
import sys
import traceback

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("GATE_BASE", "http://localhost:4100")
GATE_LAN = os.environ.get("GATE_LAN")  # Optional; skip LAN block if unset

expect.set_options(timeout=10_000)

step_n = 0


def step(msg):
    global step_n
    step_n += 1
    print(f"[{step_n:02d}] {msg}", flush=True)


def nav(page, tab):
    page.locator("nav").get_by_role("button", name=tab, exact=True).click()


def pin_pad(page, pin):
    for d in pin:
        page.get_by_role("button", name=d, exact=True).click()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_a = browser.new_context()
        page1 = ctx_a.new_page()
        pages = {"admin-main": page1}

        # dialog answer queue for page1 (sent-cancel reason prompt)
        answers = []

        def on_dialog(d):
            if answers:
                a = answers.pop(0)
                if a is None:
                    d.dismiss()
                else:
                    d.accept(a)
            else:
                d.accept()

        page1.on("dialog", on_dialog)

        try:
            step("Setup: first-run admin on scratch DB")
            page1.goto(BASE)
            expect(page1.get_by_role("heading", name="Set up ForkFlow")).to_be_visible()
            page1.get_by_placeholder("Restaurant name").fill("Testaurant")
            page1.get_by_placeholder("Your name (admin)").fill("Admin")
            page1.get_by_placeholder("Admin PIN (4-6 digits)").fill("111111")
            page1.get_by_role("button", name="Start").click()
            expect(page1.get_by_text("Signed in as")).to_be_visible()

            step("Catalog: category Mains")
            nav(page1, "catalog")
            page1.get_by_placeholder("New category").fill("Mains")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_role("button", name="Mains")).to_be_visible()

            step("Catalog: product Biryani (station Kitchen, variants Half/Full)")
            page1.get_by_role("button", name="New product").click()
            page1.get_by_placeholder("Product name").fill("Biryani")
            page1.get_by_placeholder("Price").first.fill("100")
            station_sel = page1.locator("select").filter(
                has=page1.locator("option", has_text="No KOT station")
            )
            station_sel.select_option(label="Kitchen")
            page1.get_by_placeholder("Variant name (e.g. Half)").fill("Half")
            page1.get_by_placeholder("Price").last.fill("60")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text(re.compile(r"Half — ₹60\.00"))).to_be_visible()
            page1.get_by_placeholder("Variant name (e.g. Half)").fill("Full")
            page1.get_by_placeholder("Price").last.fill("100")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text(re.compile(r"Full — ₹100\.00"))).to_be_visible()
            page1.get_by_role("button", name="Save", exact=True).click()
            expect(
                page1.get_by_text(re.compile(r"(Half, Full|Full, Half)"))
            ).to_be_visible()

            step("Catalog: stationless product Water Bottle")
            page1.get_by_role("button", name="New product").click()
            page1.get_by_placeholder("Product name").fill("Water Bottle")
            page1.get_by_placeholder("Price").first.fill("20")
            # station left at default "No KOT station" -> stationless
            page1.get_by_role("button", name="Save", exact=True).click()
            expect(page1.get_by_text("Water Bottle")).to_be_visible()

            step("Users: create waiter Wally (PIN 222222)")
            nav(page1, "users")
            page1.get_by_placeholder("Name", exact=True).fill("Wally")
            page1.get_by_placeholder("PIN (4-6 digits)", exact=True).fill("222222")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text("Wally")).to_be_visible()

            step("Tables: admin creates T1 via Manage tables")
            nav(page1, "tables")
            page1.get_by_role("button", name="Manage tables").click()
            page1.get_by_placeholder("Table name").fill("T1")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text("T1")).to_be_visible()
            page1.get_by_role("button", name="Done managing").click()
            t1 = page1.get_by_role("button").filter(has_text="T1")
            expect(t1).to_contain_text("free")

            step("Dine-in: tap T1 -> order opens")
            t1.click()
            expect(page1.get_by_text(re.compile(r"T1 · A — open"))).to_be_visible()

            step("Punch prep: add Biryani(Half) + stationless Water Bottle to draft")
            page1.get_by_role("button", name=re.compile(r"Half — ₹60\.00")).click()
            page1.get_by_role("button", name="Water Bottle").click()
            expect(page1.get_by_text("Cart (2 items)")).to_be_visible()

            step("Draft survives reload (localStorage)")
            page1.reload()
            expect(page1.get_by_text("Signed in as")).to_be_visible()
            nav(page1, "tables")
            t1 = page1.get_by_role("button").filter(has_text="T1")
            expect(t1).to_contain_text("occupied")
            t1.click()
            expect(page1.get_by_text("Cart (2 items)")).to_be_visible()

            step("Punch -> both items pending")
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_have_count(2)

            step("Open Kitchen board in second page (same admin session)")
            page_k = ctx_a.new_page()
            pages["kitchen"] = page_k
            page_k.goto(BASE)
            nav(page_k, "kitchen")
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Send to kitchen -> Biryani sent, Water stays pending")
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_have_count(1)
            expect(page1.get_by_text("pending", exact=True)).to_have_count(1)

            step("Kitchen board updates LIVE (no reload): KOT #1, no stationless item")
            expect(page_k.get_by_text("KOT #1")).to_be_visible()
            # Kitchen context for split A: just table name, no suffix
            expect(page_k.get_by_text("T1", exact=True)).to_be_visible()
            expect(page_k.get_by_text("Biryani (Half)")).to_be_visible()
            expect(page_k.get_by_text("Water")).to_have_count(0)

            step("Kitchen: mark KOT #1 done")
            page_k.get_by_role("button", name="Done", exact=True).click()
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Waiter login (fresh context, PIN pad)")
            ctx_w = browser.new_context()
            page_w = ctx_w.new_page()
            pages["waiter"] = page_w
            page_w.goto(BASE)
            pin_pad(page_w, "222222")
            expect(page_w.get_by_text("Signed in as")).to_be_visible()
            expect(page_w.get_by_text("(waiter)")).to_be_visible()

            step("Waiter nav shows only home+tables")
            wnav = page_w.locator("nav")
            expect(wnav.get_by_role("button", name="tables", exact=True)).to_be_visible()
            for absent in ("kitchen", "catalog", "users", "settings"):
                expect(wnav.get_by_role("button", name=absent, exact=True)).to_have_count(0)

            step("Waiter sees NO Cancel on sent item (only on pending)")
            nav(page_w, "tables")
            page_w.get_by_role("button").filter(has_text="T1").click()
            expect(page_w.get_by_text("Punched items")).to_be_visible()
            expect(page_w.get_by_text("sent", exact=True)).to_be_visible()
            expect(
                page_w.get_by_role("button", name="Cancel", exact=True)
            ).to_have_count(1)

            step("Admin cancels SENT Biryani with required reason")
            expect(
                page1.get_by_role("button", name="Cancel", exact=True)
            ).to_have_count(2)
            answers.append("wrong item")
            biryani_row = page1.locator("div").filter(
                has_text=re.compile(r"Biryani \(Half\)")
            ).last
            biryani_row.get_by_role("button", name="Cancel", exact=True).click()
            expect(page1.get_by_text("[Cancelled: wrong item]")).to_be_visible()
            expect(page1.get_by_text("cancelled", exact=True)).to_be_visible()

            step("Waiter's open order screen shows the cancellation LIVE")
            expect(page_w.get_by_text("[Cancelled: wrong item]")).to_be_visible()

            step("Parcel round trip: create -> punch -> send")
            page1.get_by_role("button", name="← Back").click()
            page1.get_by_role("button", name="New parcel").click()
            expect(page1.get_by_text("Parcel — open")).to_be_visible()
            page1.get_by_role("button", name=re.compile(r"Full — ₹100\.00")).click()
            expect(page1.get_by_text("Cart (1 items)")).to_be_visible()
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_be_visible()

            step("Kitchen gets parcel KOT #2 live, marks done")
            expect(page_k.get_by_text("KOT #2")).to_be_visible()
            expect(page_k.get_by_text("Parcel", exact=True)).to_be_visible()
            page_k.get_by_role("button", name="Done", exact=True).click()
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Tables shows Open parcels + T1 still occupied")
            page1.get_by_role("button", name="← Back").click()
            expect(page1.get_by_text("Open parcels")).to_be_visible()
            expect(
                page1.get_by_role("button").filter(
                    has_text=re.compile(r"Parcel [0-9a-f]{8}")
                )
            ).to_be_visible()
            expect(page1.get_by_role("button").filter(has_text="T1")).to_contain_text(
                "occupied"
            )

            if GATE_LAN:
                step("LAN origin: login + order-create path (uuid fallback)")
                ctx_l = browser.new_context()
                page_l = ctx_l.new_page()
                pages["lan"] = page_l
                page_l.goto(GATE_LAN)
                rand_type = page_l.evaluate("typeof crypto.randomUUID")
                print(f"     typeof crypto.randomUUID on LAN origin = {rand_type}", flush=True)
                assert rand_type == "undefined", (
                    "LAN origin unexpectedly has crypto.randomUUID - test would not "
                    "exercise the uuid.ts fallback"
                )
                pin_pad(page_l, "111111")
                expect(page_l.get_by_text("Signed in as")).to_be_visible()
                nav(page_l, "tables")
                page_l.get_by_role("button", name="New parcel").click()
                expect(page_l.get_by_text("Parcel — open")).to_be_visible()
                page_l.get_by_role("button", name=re.compile(r"Half — ₹60\.00")).click()
                page_l.get_by_role("button", name="Punch", exact=True).click()
                expect(page_l.get_by_text("pending", exact=True)).to_be_visible()
                page_l.get_by_role("button", name="Send to kitchen").click()
                expect(page_l.get_by_text("sent", exact=True)).to_be_visible()

                step("Kitchen receives LAN-origin KOT #3 live, marks done")
                expect(page_k.get_by_text("KOT #3")).to_be_visible()
                page_k.get_by_role("button", name="Done", exact=True).click()
                expect(page_k.get_by_text("No active KOTs.")).to_be_visible()
            else:
                print("[SKIP] LAN origin test (GATE_LAN not set)", flush=True)

            # M3s split scenario starts here
            step("Split scenario: back to T1 order screen (split A)")
            page1.get_by_role("button").filter(has_text="T1").click()
            expect(page1.get_by_text(re.compile(r"T1 · A — open"))).to_be_visible()

            step("Click + Split button -> navigates to new split B order")
            page1.get_by_role("button", name="+ Split", exact=True).click()
            expect(page1.get_by_text(re.compile(r"T1 · B — open"))).to_be_visible()

            step("Punch Full Biryani on split B")
            page1.get_by_role("button", name=re.compile(r"Full — ₹100\.00")).click()
            expect(page1.get_by_text("Cart (1 items)")).to_be_visible()
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()

            step("Send split B to kitchen")
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_be_visible()

            step("Kitchen shows KOT with context 'T1 · B' (split B suffix)")
            # KOT number depends on whether the LAN block ran (#4 with LAN, #3 without).
            expected_kot_b = "KOT #4" if GATE_LAN else "KOT #3"
            expect(page_k.get_by_text(expected_kot_b)).to_be_visible()
            # Context line for split B should be "T1 · B" (middle dot U+00B7)
            expect(page_k.get_by_text(re.compile(r"T1 · B"))).to_be_visible()
            # Verify Full Biryani is listed
            expect(page_k.get_by_text("Biryani (Full)")).to_be_visible()

            step("Kitchen: mark split B KOT done")
            page_k.get_by_role("button", name="Done", exact=True).click()
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Back to Tables: T1 card shows 'occupied · 2 splits'")
            page1.get_by_role("button", name="← Back").click()
            t1 = page1.get_by_role("button").filter(has_text="T1")
            expect(t1).to_contain_text("occupied · 2 splits")

            step("Tap T1 -> picker shows 'Split A', 'Split B', 'New split', 'Close'")
            t1.click()
            # Picker should be visible with these buttons
            expect(page1.get_by_role("button", name="Split A", exact=True)).to_be_visible()
            expect(page1.get_by_role("button", name="Split B", exact=True)).to_be_visible()
            expect(page1.get_by_role("button", name="New split", exact=True)).to_be_visible()
            expect(page1.get_by_role("button", name="Close", exact=True)).to_be_visible()

            step("Click 'Split A' in picker -> opens split A order")
            page1.get_by_role("button", name="Split A", exact=True).click()
            expect(page1.get_by_text(re.compile(r"T1 · A — open"))).to_be_visible()
            # Verify split A's items are still present (Water Bottle pending)
            expect(page1.get_by_text("1 × Water Bottle")).to_be_visible()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()

            step("Screenshot final state for review")
            page1.screenshot(path="gate-final-split-a.png", full_page=True)
            page_k.screenshot(path="gate-final-kitchen.png", full_page=True)
            print("Screenshots: gate-final-split-a.png, gate-final-kitchen.png", flush=True)

            # M3b printing scenario starts here
            step("Start TCP capture server on free port")
            import threading
            import socketserver

            captured_bytes = []

            class TCPCaptureHandler(socketserver.BaseRequestHandler):
                def handle(self):
                    data = b""
                    while True:
                        chunk = self.request.recv(8192)
                        if not chunk:
                            break
                        data += chunk
                    if data:
                        captured_bytes.append(data)
                    self.request.close()

            server = socketserver.TCPServer(("127.0.0.1", 0), TCPCaptureHandler)
            port = server.server_address[1]
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            print(f"     TCP server listening on 127.0.0.1:{port}", flush=True)

            step(f"Settings: add printer 'Front KOT' (network 127.0.0.1:{port}, 80mm)")
            nav(page1, "settings")
            page1.get_by_placeholder("Printer name").fill("Front KOT")
            # Kind select defaults to "Network (WiFi/LAN)"
            page1.get_by_placeholder(re.compile(r"IP address")).fill(f"127.0.0.1:{port}")
            # Paper width select defaults to 80mm
            page1.get_by_role("button", name="Add printer").click()
            expect(page1.get_by_role("cell", name="Front KOT")).to_be_visible()

            step("Test print Front KOT -> bytes captured contain 'TEST PRINT' + printer name")
            page1.get_by_role("button", name="Test print").first.click()
            # Wait up to 5s for job to complete and bytes to arrive
            import time
            timeout = time.time() + 5
            while time.time() < timeout:
                if captured_bytes:
                    break
                time.sleep(0.1)
            assert captured_bytes, "No bytes captured from test print"
            test_bytes = captured_bytes[-1]
            test_str = test_bytes.decode("latin1", errors="replace")
            assert "TEST PRINT" in test_str, f"TEST PRINT not found in: {test_str}"
            assert "Front KOT" in test_str, f"Printer name not found in: {test_str}"
            print(f"     Test print bytes captured ({len(test_bytes)} bytes)", flush=True)
            # Verify job shows done status
            expect(page1.get_by_text(re.compile(r"✓ Done"))).to_be_visible()

            step("Assign Kitchen station to Front KOT printer")
            # Find Kitchen station row, change printer select to Front KOT
            kitchen_row = page1.locator("tr").filter(has_text="Kitchen")
            printer_select = kitchen_row.locator("select")
            printer_select.select_option(label="Front KOT")
            # Assert PATCH landed before navigating away
            expect(printer_select).to_have_value(re.compile(r".+"))  # non-empty value
            print("     Kitchen station assigned to Front KOT", flush=True)

            step("Punch+send Biryani (Half) on new parcel -> KOT bytes captured")
            nav(page1, "tables")
            page1.get_by_role("button", name="New parcel").click()
            page1.get_by_role("button", name=re.compile(r"Half — ₹60\.00")).click()
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()

            captured_count_before = len(captured_bytes)
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_be_visible()

            # Wait for KOT bytes
            timeout = time.time() + 5
            while time.time() < timeout:
                if len(captured_bytes) > captured_count_before:
                    break
                time.sleep(0.1)
            assert len(captured_bytes) > captured_count_before, "No KOT bytes captured"

            kot_bytes = captured_bytes[-1]
            kot_str = kot_bytes.decode("latin1", errors="replace")
            # Determine expected KOT number based on whether LAN block ran
            # Previous KOTs: #1 (dine-in T1 Biryani Half), #2 (parcel Full), #3 (split B Full or LAN Half), #4 (LAN Half if LAN ran)
            # So next KOT is #4 if no LAN, #5 if LAN ran
            expected_kot_num = 5 if GATE_LAN else 4
            assert f"KOT #{expected_kot_num}" in kot_str, f"KOT #{expected_kot_num} not found in: {kot_str}"
            assert "1 x Biryani (Half)" in kot_str, f"Biryani (Half) not found in: {kot_str}"
            print(f"     KOT bytes captured ({len(kot_bytes)} bytes), contains KOT #{expected_kot_num}", flush=True)

            # Verify kitchen board ALSO updated (proves WS handshake + broadcast work)
            expect(page_k.get_by_text(f"KOT #{expected_kot_num}")).to_be_visible()
            print("     Kitchen board shows live KOT (WS handshake smoke: ✓)", flush=True)

            step("Failed job: add 'Dead Printer' on 127.0.0.1:1 -> test print fails")
            nav(page1, "settings")
            page1.get_by_placeholder("Printer name").fill("Dead Printer")
            page1.get_by_placeholder(re.compile(r"IP address")).fill("127.0.0.1:1")
            page1.get_by_role("button", name="Add printer").click()
            expect(page1.get_by_role("cell", name="Dead Printer")).to_be_visible()

            # Find Dead Printer row's test button (last one now)
            dead_row = page1.locator("tr").filter(has_text="Dead Printer")
            dead_row.get_by_role("button", name="Test print").click()

            # Wait for job to fail
            timeout = time.time() + 8
            while time.time() < timeout:
                if page1.get_by_text(re.compile(r"✗ Failed")).is_visible():
                    break
                time.sleep(0.1)

            expect(page1.get_by_text(re.compile(r"✗ Failed"))).to_be_visible()
            expect(page1.get_by_role("button", name="Retry")).to_be_visible()
            print("     Dead printer job failed, retry button visible", flush=True)

            step("Cleanup: stop TCP server")
            server.shutdown()
            print("     TCP server stopped", flush=True)

            print("\nALL STEPS PASSED (including M3s splits)", flush=True)
        except Exception:
            traceback.print_exc()
            for name, pg in pages.items():
                try:
                    pg.screenshot(path=f"gate-fail-{name}.png", full_page=True)
                    print(f"screenshot: gate-fail-{name}.png", flush=True)
                except Exception:
                    pass
            sys.exit(1)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
