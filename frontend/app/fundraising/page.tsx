"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ApiError, requestJson } from "../../lib/api";

type FundraisingCampaign = {
  id: string;
  organizationName: string | null;
  title: string;
  description: string;
  causeCategory: string;
  fundraisingTarget: string;
  grossRaised: string;
  providerFees: string;
  escrowBalance: string;
  donorCount: number;
  goalPercent: number;
  currency: string;
  closeAt: string;
  acceptingDonations: boolean;
  donationCheckoutAvailable: boolean;
};

function idr(amount: string) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

export default function FundraisingPage() {
  const [campaigns, setCampaigns] = useState<FundraisingCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await requestJson<{ campaigns: FundraisingCampaign[] }>("/api/public/fundraising-campaigns");
      setCampaigns(response.campaigns);
    } catch {
      setError("Campaign penggalangan dana belum dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main id="main" className="landing-main">
      <section className="workspace-main" aria-labelledby="fundraising-title">
        <p className="eyebrow">DANATERANG · PENGGALANGAN DANA</p>
        <h1 id="fundraising-title" className="workspace-title">Pilih campaign untuk didukung</h1>
        <p className="section-note">Target adalah sasaran, bukan batas donasi. Setiap campaign menerima donasi sampai waktu tutupnya.</p>
        {loading ? <p className="workspace-loading" aria-busy="true">Memuat campaign…</p> : null}
        {error ? <div className="workspace-error" role="alert"><p>{error}</p><button className="action-button action-button--secondary" onClick={() => void load()}>Coba lagi</button></div> : null}
        {!loading && !error && campaigns.length === 0 ? (
          <section className="workspace-empty"><h2>Belum ada campaign yang sedang menggalang dana</h2><p>Campaign akan muncul di sini setelah disiapkan dan diterbitkan.</p></section>
        ) : null}
        {!loading && !error && campaigns.length > 0 ? (
          <ul className="workspace-list dt-program-cards-grid">
            {campaigns.map((campaign) => (
              <li className="workspace-panel workspace-list-item dt-program-card" key={campaign.id}>
                <div className="dt-program-card-header"><div><h2>{campaign.title}</h2><span className="dt-program-category">{campaign.organizationName || "Organisasi mitra"} · {campaign.causeCategory}</span></div></div>
                <p className="dt-program-desc">{campaign.description || "Campaign sosial yang sedang menggalang dana."}</p>
                <div className="campaign-summary">
                  <span>Donasi bruto</span><strong>{idr(campaign.grossRaised)}</strong>
                  <span>Biaya payment provider</span><span>{idr(campaign.providerFees)}</span>
                  <span>Saldo bersih di escrow</span><strong>{idr(campaign.escrowBalance)}</strong>
                  <span>Target {idr(campaign.fundraisingTarget)} · {campaign.goalPercent}%</span>
                </div>
                <div className="dt-progress-track" role="progressbar" aria-label={`Progress target ${campaign.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, campaign.goalPercent)}>
                  <div className="dt-progress-fill" style={{ width: `${Math.min(100, campaign.goalPercent)}%` }} />
                </div>
                <p className="field-hint">{campaign.donorCount} donatur · ditutup {new Date(campaign.closeAt).toLocaleString("id-ID")}</p>
                {!campaign.acceptingDonations ? <p className="field-hint">Donasi sementara dihentikan sambil menunggu tanda tangan final Organizer.</p> : null}
                {campaign.acceptingDonations && !campaign.donationCheckoutAvailable ? <p className="field-hint">Pembayaran Rupiah belum dikonfigurasi.</p> : null}
                <Link className="action-button action-button--primary" href={`/fundraising/${campaign.id}`}>Lihat campaign</Link>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="auth-switch"><Link href="/">Kembali ke beranda DanaTerang</Link></p>
      </section>
    </main>
  );
}
