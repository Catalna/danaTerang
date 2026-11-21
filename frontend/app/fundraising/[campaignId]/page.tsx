"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { ApiError, requestJson } from "../../../lib/api";

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
  milestones: { id: string; title: string; description: string; budgetAmount: string; orderIndex: number }[];
};

type CurrentUser = { id: string; role: string };

function idr(amount: string) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

function donationError(error: unknown) {
  if (error instanceof ApiError && error.code === "payment_provider_unavailable") return "Pembayaran Rupiah belum dikonfigurasi. Donasi belum dapat diproses.";
  if (error instanceof ApiError && error.code === "fundraising_closed") return "Campaign sudah ditutup untuk donasi.";
  if (error instanceof ApiError && error.status === 401) return "Masuk dengan akun Funder/Donatur untuk melanjutkan donasi.";
  return "Checkout donasi belum dapat dibuat. Coba lagi.";
}

export default function FundraisingCampaignPage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId;
  const router = useRouter();
  const [campaign, setCampaign] = useState<FundraisingCampaign | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [amount, setAmount] = useState("");
  const [reallocationPolicy, setReallocationPolicy] = useState<"REDIRECT_RELATED" | "REFUND">("REFUND");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [donationErrorMessage, setDonationErrorMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await requestJson<{ campaign: FundraisingCampaign }>(`/api/public/fundraising-campaigns/${campaignId}`);
      setCampaign(response.campaign);
    } catch {
      setError("Campaign tidak ditemukan atau penggalangan dananya sudah ditutup.");
    }
    try {
      const response = await requestJson<{ user: CurrentUser }>("/api/auth/me");
      setUser(response.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { void load(); }, [load]);

  async function donate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDonationErrorMessage("");
    if (!user || user.role !== "FUNDER") {
      router.push(user ? "/register?role=FUNDER" : `/login?next=${encodeURIComponent(`/fundraising/${campaignId}`)}`);
      return;
    }
    if (!campaign?.donationCheckoutAvailable) {
      setDonationErrorMessage("Pembayaran Rupiah belum dikonfigurasi. Donasi belum dapat diproses.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await requestJson<{ donation: { checkoutUrl: string } }>(`/api/campaigns/${campaignId}/donations`, {
        method: "POST",
        body: JSON.stringify({
          amount,
          idempotencyKey: crypto.randomUUID(),
          reallocationPolicy,
          returnUrl: `${window.location.origin}/fundraising/${campaignId}?donation=return`,
        }),
      });
      window.location.assign(result.donation.checkoutUrl);
    } catch (cause) {
      setDonationErrorMessage(donationError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main id="main" className="landing-main">
      {loading ? <p className="workspace-loading" aria-busy="true">Memuat campaign…</p> : error || !campaign ? (
        <section className="workspace-empty" role="alert"><h1>Campaign tidak tersedia</h1><p>{error || "Campaign tidak ditemukan."}</p><Link href="/fundraising">Lihat campaign lain</Link></section>
      ) : (
        <div className="workspace-main">
          <Link href="/fundraising">← Semua campaign</Link>
          <p className="eyebrow">CAMPAIGN PENGGALANGAN DANA</p>
          <h1 className="workspace-title">{campaign.title}</h1>
          <p>{campaign.description}</p>
          <p className="section-note">Diselenggarakan oleh {campaign.organizationName || "Organisasi mitra"} · {campaign.causeCategory}</p>
          <section className="workspace-panel" aria-label="Progress donasi">
            <p className="eyebrow">DONASI BRUTO TERVERIFIKASI PROVIDER</p>
            <h2>{idr(campaign.grossRaised)}</h2>
            <p>Target {idr(campaign.fundraisingTarget)} · {campaign.goalPercent}% · {campaign.donorCount} donatur</p>
            <p>Biaya payment provider: {idr(campaign.providerFees)}</p>
            <p>Saldo bersih yang masih di escrow: {idr(campaign.escrowBalance)}</p>
            <div className="dt-progress-track" role="progressbar" aria-label="Progress target donasi" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, campaign.goalPercent)}>
              <div className="dt-progress-fill" style={{ width: `${Math.min(100, campaign.goalPercent)}%` }} />
            </div>
            <p className="field-hint">Donasi tetap diterima hingga {new Date(campaign.closeAt).toLocaleString("id-ID")}, termasuk jika target sudah terlampaui.</p>
          </section>

          <section className="workspace-panel" aria-labelledby="milestones-title">
            <h2 id="milestones-title">Rencana penggunaan dana</h2>
            {campaign.milestones.length ? (
              <ol className="workspace-list">{campaign.milestones.map((milestone) => <li className="workspace-list-item" key={milestone.id}><strong>{milestone.title}</strong><p>{milestone.description}</p><span>{idr(milestone.budgetAmount)}</span></li>)}</ol>
            ) : <p>Rincian milestone sedang disiapkan.</p>}
          </section>

          <section className="workspace-panel" aria-labelledby="donate-title">
            <h2 id="donate-title">Donasi untuk campaign ini</h2>
            {!campaign.acceptingDonations ? (
              <p role="status">Donasi sementara dihentikan sambil menunggu tanda tangan final Organizer.</p>
            ) : !user || user.role !== "FUNDER" ? (
              <div><p>Untuk berdonasi, masuk atau buat akun Funder/Donatur terlebih dahulu.</p><Link className="action-button action-button--primary" href={user ? `/register?role=FUNDER&next=${encodeURIComponent(`/fundraising/${campaignId}`)}` : `/login?next=${encodeURIComponent(`/fundraising/${campaignId}`)}`}>{user ? "Buat akun Donatur" : "Masuk untuk berdonasi"}</Link></div>
            ) : !campaign.donationCheckoutAvailable ? (
              <p role="status">Checkout Rupiah belum tersedia karena payment provider belum dikonfigurasi.</p>
            ) : (
              <form className="form-grid" onSubmit={(event) => void donate(event)} aria-busy={submitting}>
                <div className="form-field form-field--full"><label htmlFor="donation-amount">Jumlah donasi (Rupiah)</label><input id="donation-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="100000" required /></div>
                <fieldset className="form-field form-field--full"><legend>Jika campaign memiliki sisa dana</legend>
                  <label><input type="radio" name="reallocation" value="REDIRECT_RELATED" checked={reallocationPolicy === "REDIRECT_RELATED"} onChange={() => setReallocationPolicy("REDIRECT_RELATED")} /> Setuju dialihkan ke campaign sejenis yang disetujui.</label>
                  <label><input type="radio" name="reallocation" value="REFUND" checked={reallocationPolicy === "REFUND"} onChange={() => setReallocationPolicy("REFUND")} /> Kembalikan sisa dana kepada saya.</label>
                </fieldset>
                {donationErrorMessage ? <p className="workspace-error form-field--full" role="alert">{donationErrorMessage}</p> : null}
                <button className="action-button action-button--primary" type="submit" disabled={submitting}>{submitting ? "Menyiapkan pembayaran…" : "Lanjut ke pembayaran"}</button>
              </form>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
