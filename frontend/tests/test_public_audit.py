import re
import os
from pathlib import Path
from tempfile import gettempdir

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("DANATERANG_WEB_URL", "http://127.0.0.1:3000")
SCREENSHOT_DIR = Path(gettempdir()) / "dana-terang-playwright"


def record_request_failure(request, errors):
    failure = request.failure or "request_failed"
    # Next.js cancels speculative RSC prefetches when a user navigates away.
    if "ERR_ABORTED" in failure:
        return
    errors.append(f"{request.method} {request.url} — {failure}")


def main():
    errors = []
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.on("requestfailed", lambda request: record_request_failure(request, errors))
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.get_by_role("heading", name="Renovasi SD Harapan", level=1).wait_for(state="visible")

        assert page.get_by_role("heading", name="Renovasi SD Harapan", level=1).is_visible()
        assert page.get_by_role("link", name="Masuk").is_visible()
        assert page.get_by_role("link", name="Buat akun", exact=True).is_visible()
        assert page.get_by_text("Belum ada program yang dipublikasikan", exact=False).count() == 0
        assert page.get_by_text("Disetujui oleh quorum 2-dari-3", exact=False).is_visible()
        assert page.get_by_text("Tahap direncanakan", exact=False).is_visible()
        assert page.get_by_text("Menunggu dicatat ke jaringan", exact=False).is_visible()
        assert page.get_by_text("Belum ada evidence", exact=False).count() == 0
        # Private data must never reach the public surface.
        for private_marker in ["receipt.pdf", "rawHash", "storageKey", "revisionInstructions", "internalNotes", "organizer@example.test", "funder@example.test"]:
            assert private_marker not in page.locator("body").inner_text(), private_marker
        assert page.get_by_role("main").count() == 1
        assert page.get_by_role("navigation", name="Navigasi utama").count() == 1
        assert page.get_by_role("link", name="Lewati ke konten").count() == 1
        assert not re.search(r"\b[0-9a-f]{64}\b", page.locator("body").inner_text(), re.I)
        assert not errors, errors

        axe_path = Path(__file__).resolve().parents[2] / "node_modules" / "axe-core" / "axe.min.js"
        page.add_script_tag(path=str(axe_path))
        violations = page.evaluate("async () => (await axe.run()).violations")
        assert not violations, [
            {
                "id": item["id"],
                "impact": item["impact"],
                "nodes": [
                    {"target": node["target"], "failure": node["failureSummary"]}
                    for node in item["nodes"]
                ],
            }
            for item in violations
        ]

        page.screenshot(
            path=str(SCREENSHOT_DIR / "danaterang-desktop.png"),
            full_page=True,
        )
        page.set_viewport_size({"width": 390, "height": 844})
        overflow = page.evaluate(
            """() => [...document.querySelectorAll('*')]
                .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
                .slice(0, 5).map((element) => element.tagName + '.' + element.className)"""
        )
        assert not overflow, overflow
        page.screenshot(
            path=str(SCREENSHOT_DIR / "danaterang-mobile.png"),
            full_page=True,
        )
        page.keyboard.press("Tab")
        focused = page.evaluate(
            """() => ({
              href: document.activeElement.getAttribute('href'),
              outline: getComputedStyle(document.activeElement).outlineStyle,
              top: document.activeElement.getBoundingClientRect().top
            })"""
        )
        assert focused["href"] == "#main", focused
        assert focused["outline"] != "none" and focused["top"] >= 0, focused

        page.get_by_role("link", name="Masuk").click()
        page.get_by_role("heading", name="Masuk ke akun Anda").wait_for(state="visible")
        assert page.get_by_label("Email").is_visible()
        assert page.get_by_role("textbox", name="Kata sandi").is_visible()
        expect(page.get_by_role("button", name="Masuk")).to_be_enabled(timeout=15_000)
        mocked_login = []

        def fulfill_login(route):
            mocked_login.append(route.request.url)
            route.fulfill(status=401, json={"error": "invalid_credentials"})

        page.route("**/api/auth/login", fulfill_login)
        page.get_by_label("Email").fill("ana@example.com")
        page.get_by_role("textbox", name="Kata sandi").fill("correct horse battery staple")
        page.get_by_role("button", name="Masuk").click()
        assert mocked_login, "Login fixture was not intercepted"
        login_error = page.get_by_role("alert").get_by_text("Email atau kata sandi tidak cocok", exact=False)
        login_error.wait_for(state="visible")
        assert "tidak cocok" in login_error.inner_text()
        assert page.get_by_label("Email").input_value() == "ana@example.com"

        page.goto(f"{BASE_URL}/register?role=FUNDER", wait_until="networkidle")
        page.get_by_role("heading", name="Buat akun Funder").wait_for(state="visible")
        assert page.get_by_label("Jenis akun Funder").is_visible()
        page.goto(f"{BASE_URL}/register", wait_until="networkidle")
        page.get_by_role("heading", name="Buat akun Organizer").wait_for(state="visible")
        assert page.get_by_label("Nama lengkap").is_visible()
        assert page.get_by_label("Nama organisasi").is_visible()
        assert page.get_by_label("Jenis organisasi").is_visible()
        assert page.get_by_label("Email").is_visible()
        assert page.get_by_role("textbox", name="Kata sandi").is_visible()
        expect(page.get_by_role("button", name="Buat akun")).to_be_enabled(timeout=15_000)
        page.get_by_label("Daftar sebagai").select_option("FUNDER")
        page.get_by_role("heading", name="Buat akun Funder").wait_for(state="visible")
        page.get_by_label("Jenis akun Funder").select_option("INDIVIDUAL")
        assert not page.get_by_label("Nama komunitas / instansi").is_visible()
        page.get_by_label("Jenis akun Funder").select_option("ORGANIZATION")
        assert page.get_by_label("Nama komunitas / instansi").is_visible()
        page.get_by_label("Daftar sebagai").select_option("ORGANIZER")
        page.route("**/api/auth/register", lambda route: route.fulfill(status=409, json={"error": "account_unavailable"}))
        page.get_by_label("Nama lengkap").fill("Ana Winata")
        page.get_by_label("Nama organisasi").fill("Komunitas Terang")
        page.get_by_label("Jenis organisasi").select_option("COMMUNITY")
        page.get_by_label("Email").fill("ana@example.com")
        page.get_by_role("textbox", name="Kata sandi").fill("correct horse battery staple")
        page.get_by_label("Saya menyetujui").check()
        page.get_by_role("button", name="Buat akun").click()
        register_error = page.get_by_role("alert").get_by_text("Akun tidak dapat dibuat", exact=False)
        register_error.wait_for(state="visible")
        assert page.get_by_label("Nama lengkap").input_value() == "Ana Winata"
        assert page.get_by_label("Email").input_value() == "ana@example.com"

        fundraising_id = "c0a80101-0000-4000-8000-000000000001"
        fundraising_campaign = {
            "id": fundraising_id,
            "organizationName": "Komunitas Tanggap Bencana",
            "causeCategory": "DISASTER_RELIEF",
            "title": "Bantuan Banjir",
            "description": "Bantuan logistik dan pemulihan warga terdampak.",
            "fundraisingTarget": "50000000.00",
            "grossRaised": "60000000.00",
            "providerFees": "300000.00",
            "escrowBalance": "59700000.00",
            "donorCount": 25,
            "goalPercent": 120,
            "currency": "IDR",
            "closeAt": "2026-12-31T12:00:00.000Z",
            "acceptingDonations": True,
            "termsLockedAt": None,
            "amendmentsUsed": 0,
            "donationCheckoutAvailable": False,
            "milestones": [],
        }
        page.route("**/api/public/fundraising-campaigns", lambda route: route.fulfill(status=200, json={"campaigns": [fundraising_campaign]}))
        page.goto(f"{BASE_URL}/fundraising", wait_until="networkidle")
        page.get_by_role("heading", name="Pilih campaign untuk didukung").wait_for(state="visible")
        assert page.get_by_text("120%", exact=False).is_visible()
        assert page.get_by_text("Pembayaran Rupiah belum dikonfigurasi", exact=False).is_visible()
        page.route(f"**/api/public/fundraising-campaigns/{fundraising_id}", lambda route: route.fulfill(status=200, json={"campaign": fundraising_campaign}))
        page.route("**/api/auth/me", lambda route: route.fulfill(status=401, json={"error": "authentication_required"}))
        page.goto(f"{BASE_URL}/fundraising/{fundraising_id}", wait_until="networkidle")
        page.get_by_role("heading", name="Bantuan Banjir").wait_for(state="visible")
        assert page.get_by_role("link", name="Masuk untuk berdonasi").is_visible()

        page.unroute("**/api/auth/me")
        fundraising_campaign["donationCheckoutAvailable"] = True
        page.route("**/api/auth/me", lambda route: route.fulfill(status=200, json={"user": {"id": "e7a84903-0e85-4416-b42a-72d76f97d290", "role": "FUNDER"}}))
        donation_id = "d0a80101-0000-4000-8000-000000000002"
        page.route(
            f"**/api/campaigns/{fundraising_id}/donations",
            lambda route: route.fulfill(status=201, json={"donation": {"id": donation_id, "checkoutUrl": f"{BASE_URL}/fundraising/demo-checkout?donationId={donation_id}"}}),
        )
        page.goto(f"{BASE_URL}/fundraising/{fundraising_id}", wait_until="networkidle")
        page.get_by_label("Jumlah donasi (Rupiah)").fill("25000")
        page.get_by_role("button", name="Lanjut ke pembayaran").click()
        page.get_by_role("heading", name="Pembayaran donasi demo").wait_for(state="visible")
        page.route(
            f"**/api/test/fundraising/donations/{donation_id}/settle",
            lambda route: route.fulfill(status=200, json={"donation": {"id": donation_id, "status": "PAID", "amount": "25000.00"}}),
        )
        page.get_by_role("button", name="Simulasikan pembayaran berhasil").click()
        page.wait_for_url(f"{BASE_URL}/fundraising/donations?simulated=1")
        browser.close()


if __name__ == "__main__":
    main()
