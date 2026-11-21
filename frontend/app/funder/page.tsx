"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Banknote, CheckCircle2, FolderKanban, ListChecks, ScrollText, ShieldCheck } from "lucide-react";

import AuthenticatedLayout from "../../components/AuthenticatedLayout";
import { CampaignTreeError, loadCampaignTree } from "../../lib/campaignTree";
import { formatMinorUnits, sumAmounts } from "../../lib/money";
import { useCurrentUser } from "../../lib/useCurrentUser";

type View = Awaited<ReturnType<typeof loadCampaignTree>>;

function statusLabel(status: string) {
  if (status === "ACTIVE") return "Didanai";
  if (status === "DRAFT") return "Draf";
  if (status === "COMPLETED") return "Selesai";
  if (status === "CANCELLED") return "Dibatalkan";
  return status;
}

/** Funder workspace: programs they funded, progress, status-only evidence, payment reports. */
export default function FunderDashboardPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [tree, setTree] = useState<View>({ campaigns: [], milestones: [], evidence: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [partialError, setPartialError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setPartialError("");
    try {
      setTree(await loadCampaignTree());
    } catch (cause) {
      if (cause instanceof CampaignTreeError) {
        setTree(cause.partialTree);
        setPartialError("Sebagian data belum dapat dimuat. Angka di bawah mungkin belum lengkap.");
      } else {
        setError("Portofolio pendanaan belum dapat dimuat. Periksa koneksi lalu coba lagi.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const evidence = useMemo(() => tree.evidence.filter((item) => item.evidenceStatus !== "SUPERSEDED"), [tree.evidence]);
  const funded = tree.campaigns.filter((campaign) => campaign.status === "ACTIVE");
  const milestonesInProgress = tree.milestones.filter((milestone) => milestone.status === "IN_PROGRESS");
  const verifiedCount = evidence.filter((item) => item.verificationStatus === "VERIFIED").length;
  const waitingCount = evidence.filter((item) => item.verificationStatus !== "VERIFIED").length;
  const currencies = [...new Set(funded.map((campaign) => campaign.currency))].sort();
  const perCurrency = currencies.map((currency) => ({
    currency,
    units: sumAmounts(funded.filter((campaign) => campaign.currency === currency).map((campaign) => campaign.totalBudget)),
  }));

  if (!userLoading && user && user.role !== "FUNDER") {
    return (
      <AuthenticatedLayout title="Akses terbatas" subtitle="Halaman ini hanya untuk akun Funder.">
        <section className="workspace-empty">
          <h2>Portal ini tidak tersedia untuk peran Anda</h2>
          <p>Masuk dengan akun Funder untuk melihat portofolio pendanaan.</p>
          <Link href="/dashboard">Kembali ke ruang kerja</Link>
        </section>
      </AuthenticatedLayout>
    );
  }

  return (
    <AuthenticatedLayout
      title="Portofolio Pendanaan"
      subtitle="Pantau komitmen pendanaan, progres milestone, dan status verifikasi program yang Anda danai."
      actions={
        <Link className="action-button action-button--primary" href="/payment-reports">
          <Banknote size={16} aria-hidden="true" />
          <span>Lapor pembayaran</span>
        </Link>
      }
    >
      {loading && <div className="workspace-loading" aria-busy="true">Memuat portofolio pendanaan…</div>}
      {error && <div className="workspace-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Coba lagi</button></div>}
      {!error && partialError && <p className="workspace-error" role="alert">{partialError}</p>}

      {!loading && !error && (
        <div className="dt-dashboard-grid">
          <section className="dt-kpi-grid" aria-label="Ringkasan pendanaan">
            <div className="dt-kpi-card dt-kpi-card--hero">
              <div className="dt-kpi-header-row">
                <div className="dt-kpi-icon-box dt-kpi-icon-box--dark"><FolderKanban size={18} aria-hidden="true" /></div>
                <span className="dt-kpi-pill-badge dt-kpi-pill-badge--dark">Didanai</span>
              </div>
              <span className="dt-kpi-label">Program didanai</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{funded.length}</strong></div>
              <span className="dt-kpi-sub">Dari {tree.campaigns.length} program yang tertaut ke akun Anda</span>
            </div>

            <div className="dt-kpi-card">
              <div className="dt-kpi-header-row">
                <div className="dt-kpi-icon-box"><ListChecks size={18} aria-hidden="true" /></div>
                <span className="dt-kpi-pill-badge dt-kpi-pill-badge--teal">Berjalan</span>
              </div>
              <span className="dt-kpi-label">Milestone berjalan</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{milestonesInProgress.length}</strong></div>
              <span className="dt-kpi-sub">Dari {tree.milestones.length} tahap yang dipantau</span>
            </div>

            <div className="dt-kpi-card">
              <div className="dt-kpi-header-row">
                <div className="dt-kpi-icon-box"><ShieldCheck size={18} aria-hidden="true" /></div>
                <span className="dt-kpi-pill-badge dt-kpi-pill-badge--teal">2-of-3</span>
              </div>
              <span className="dt-kpi-label">Bukti terverifikasi</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{verifiedCount}</strong></div>
              <span className="dt-kpi-sub">Dari {evidence.length} versi bukti terkini</span>
            </div>

            <div className="dt-kpi-card">
              <div className="dt-kpi-header-row">
                <div className="dt-kpi-icon-box"><CheckCircle2 size={18} aria-hidden="true" /></div>
                <span className="dt-kpi-pill-badge dt-kpi-pill-badge--amber">Menunggu</span>
              </div>
              <span className="dt-kpi-label">Belum terverifikasi</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{waitingCount}</strong></div>
              <span className="dt-kpi-sub">Menunggu keputusan quorum peer verifier</span>
            </div>
          </section>

          <div className="dt-two-col-grid">
            <section className="dt-card" aria-labelledby="funder-programs-heading">
              <div className="dt-card-header">
                <div>
                  <span className="dt-card-eyebrow">KOMITMEN PENDANAAN</span>
                  <h2 id="funder-programs-heading" className="dt-card-title">Program yang saya danai</h2>
                </div>
                <Link href="/campaigns" className="dt-card-link"><span>Semua campaign</span><ArrowRight size={14} aria-hidden="true" /></Link>
              </div>
              {perCurrency.length === 0 ? (
                <p className="dt-empty-text">Belum ada campaign yang ditautkan ke akun Funder ini.</p>
              ) : (
                <>
                  <div className="dt-budget-highlight">
                    {perCurrency.map(({ currency, units }) => (
                      <p key={currency} className="dt-big-budget-num">{formatMinorUnits(units, currency)}</p>
                    ))}
                    <p className="dt-budget-footnote">Total komitmen per mata uang, tanpa konversi.</p>
                  </div>
                  <ul className="audit-activity-list">
                    {tree.campaigns.slice(0, 6).map((campaign) => (
                      <li className="audit-activity-item" key={campaign.id}>
                        <div className="audit-bullet audit-bullet--lime" aria-hidden="true" />
                        <div className="audit-item-main">
                          <strong>{campaign.title}</strong>
                          <span>{formatMinorUnits(sumAmounts([campaign.totalBudget]), campaign.currency)}</span>
                        </div>
                        <span className={`status-pill status-pill--${campaign.status === "ACTIVE" ? "success" : "pending"}`}>
                          {statusLabel(campaign.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="dt-card dt-health-card" aria-labelledby="funder-verification-heading">
              <div className="dt-card-header">
                <div>
                  <span className="dt-card-eyebrow">STATUS VERIFIKASI</span>
                  <h2 id="funder-verification-heading" className="dt-card-title">Kesehatan bukti</h2>
                </div>
                <span className="dt-health-pct">{evidence.length > 0 ? `${Math.round(verifiedCount / evidence.length * 100)}%` : "—"}</span>
              </div>
              <p className="dt-card-desc">
                Funder melihat status keputusan quorum saja. Nama file, hasil OCR, flag, dan catatan verifier tidak ditampilkan.
              </p>
              <div className="dt-verification-breakdown">
                <div className="dt-verdict-row"><span className="legend-dot legend-dot--teal" /><span className="dt-verdict-label">Disetujui quorum</span><strong>{verifiedCount}</strong></div>
                <div className="dt-verdict-row"><span className="legend-dot legend-dot--amber" /><span className="dt-verdict-label">Menunggu / revisi</span><strong>{waitingCount}</strong></div>
              </div>
              <Link href="/reports" className="dt-card-link"><span>Lihat jejak audit</span><ArrowRight size={14} aria-hidden="true" /></Link>
            </section>
          </div>

          <section className="dt-card" aria-labelledby="funder-milestone-heading">
            <div className="dt-card-header">
              <div>
                <span className="dt-card-eyebrow">PROGRES PROGRAM</span>
                <h2 id="funder-milestone-heading" className="dt-card-title">Tahapan milestone</h2>
              </div>
              <span className="dt-card-meta-tag">{tree.milestones.length} tahap dipantau</span>
            </div>
            {tree.milestones.length === 0 ? (
              <p className="dt-empty-text">Belum ada milestone pada program yang Anda danai.</p>
            ) : (
              <div className="dt-milestone-progress-list">
                {tree.milestones.slice(0, 10).map((milestone) => (
                  <div key={milestone.id} className="dt-progress-row">
                    <div className="dt-progress-label-row">
                      <span className="dt-milestone-title">{milestone.title}</span>
                      <div className="dt-progress-stats">
                        <span className="dt-milestone-budget">{formatMinorUnits(sumAmounts([milestone.budgetAmount]), milestone.currency)}</span>
                        <strong className="dt-milestone-pct">
                          {milestone.status === "COMPLETED" ? "Selesai" : milestone.status === "IN_PROGRESS" ? "Sedang berjalan" : milestone.status === "CANCELLED" ? "Dibatalkan" : "Direncanakan"}
                        </strong>
                      </div>
                    </div>
                    <div className="dt-progress-track">
                      <div className={`dt-progress-fill ${milestone.status === "COMPLETED" ? "fill--teal" : milestone.status === "IN_PROGRESS" ? "fill--lime" : "fill--gray"}`} style={{ width: milestone.status === "COMPLETED" ? "100%" : "0%" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="dt-two-col-grid">
            <Link className="dt-card" href="/payment-reports">
              <div className="dt-card-header"><div><span className="dt-card-eyebrow">PEMBAYARAN EKSTERNAL</span><h2 className="dt-card-title">Laporan pembayaran</h2></div><Banknote size={18} aria-hidden="true" /></div>
              <p className="dt-card-desc">Catat pembayaran yang dilakukan di luar DanaTerang. Laporan bersifat privat dan tidak diverifikasi oleh aplikasi.</p>
            </Link>
            <Link className="dt-card" href="/reports">
              <div className="dt-card-header"><div><span className="dt-card-eyebrow">AUDIT</span><h2 className="dt-card-title">Jejak audit</h2></div><ScrollText size={18} aria-hidden="true" /></div>
              <p className="dt-card-desc">Tinjau status campaign, milestone, bukti, dan proof on-chain untuk program yang Anda danai.</p>
            </Link>
          </div>
        </div>
      )}
    </AuthenticatedLayout>
  );
}
