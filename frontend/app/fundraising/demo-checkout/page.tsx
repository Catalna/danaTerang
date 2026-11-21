"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiError, requestJson } from "../../../lib/api";

export default function DemoCheckoutPage() {
  const router = useRouter();
  const [donationId, setDonationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("donationId") ?? "";
    setDonationId(id);
    setLoading(false);
  }, []);

  async function settle() {
    setSettling(true);
    setError("");
    try {
      await requestJson(`/api/test/fundraising/donations/${donationId}/settle`, { method: "POST", body: JSON.stringify({}) });
      router.replace("/fundraising/donations?simulated=1");
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 404
        ? "Pembayaran simulasi hanya aktif di environment development/test."
        : "Simulasi pembayaran belum dapat diselesaikan. Pastikan Anda masuk dengan akun Donatur yang sama.");
    } finally {
      setSettling(false);
    }
  }

  return (
    <main id="main" className="landing-main">
      <section className="workspace-main workspace-panel" aria-labelledby="demo-checkout-title">
        <p className="eyebrow">MODE SIMULASI LOKAL</p>
        <h1 id="demo-checkout-title" className="workspace-title">Pembayaran donasi demo</h1>
        <p>Langkah ini hanya mensimulasikan konfirmasi payment provider untuk pengembangan dan pengujian. Tidak ada uang yang ditagih atau dipindahkan.</p>
        {loading ? <p className="workspace-loading" aria-busy="true">Memeriksa pembayaran…</p> : null}
        {!loading && !donationId ? <p className="workspace-error" role="alert">Referensi donasi tidak ditemukan.</p> : null}
        {error ? <p className="workspace-error" role="alert">{error}</p> : null}
        <div className="workspace-actions">
          <button className="action-button action-button--primary" type="button" disabled={loading || settling || !donationId} aria-busy={settling} onClick={() => void settle()}>
            {settling ? "Mencatat simulasi…" : "Simulasikan pembayaran berhasil"}
          </button>
          <Link className="action-button action-button--secondary" href="/fundraising">Kembali ke campaign</Link>
        </div>
      </section>
    </main>
  );
}
