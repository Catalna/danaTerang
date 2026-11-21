"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Anchor, BadgeCheck, Building2, Globe2, ShieldCheck, Users } from "lucide-react";

import AuthenticatedLayout from "../../components/AuthenticatedLayout";
import { requestJson } from "../../lib/api";
import { useCurrentUser } from "../../lib/useCurrentUser";

type UserRow = { id: string; role: string };
type OrganizationRow = { id: string; verified?: boolean; verified_at?: string | null };
type CampaignRow = { id: string; published?: boolean };
type ReviewRow = { id?: string; status?: string };
type ProofRow = { proofId: string; status: string };

/** Admin workspace for user/organization management, operations, and audit. */
export default function AdminDashboardPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [proofs, setProofs] = useState<ProofRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      const requests = [
        requestJson<{ users: UserRow[] }>("/api/admin/users").then((r) => r.users).catch(() => null),
        requestJson<{ organizations: OrganizationRow[] }>("/api/admin/organizations").then((r) => r.organizations).catch(() => null),
        requestJson<{ campaigns: CampaignRow[] }>("/api/admin/campaigns").then((r) => r.campaigns).catch(() => null),
        requestJson<{ reviews: ReviewRow[] }>("/api/admin/reviews").then((r) => r.reviews).catch(() => null),
        requestJson<{ proofs: ProofRow[] }>("/api/admin/proofs").then((r) => r.proofs).catch(() => null),
      ] as const;
      const [nextUsers, nextOrganizations, nextCampaigns, nextReviews, nextProofs] = await Promise.all(requests);
      if (!active) return;
      if (nextUsers === null && nextOrganizations === null && nextCampaigns === null) {
        setError("Ringkasan sistem belum dapat dimuat. Periksa koneksi lalu muat ulang.");
      } else {
        setUsers(nextUsers ?? []);
        setOrganizations(nextOrganizations ?? []);
        setCampaigns(nextCampaigns ?? []);
        setReviews(nextReviews ?? []);
        setProofs(nextProofs ?? []);
      }
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, []);

  if (!userLoading && user && user.role !== "ADMIN") {
    return (
      <AuthenticatedLayout title="Akses terbatas" subtitle="Halaman ini hanya untuk akun Admin.">
        <section className="workspace-empty"><h2>Ringkasan sistem tidak tersedia</h2><Link href="/dashboard">Kembali ke ruang kerja</Link></section>
      </AuthenticatedLayout>
    );
  }

  const verifiedOrgs = organizations.filter((org) => org.verified || org.verified_at).length;
  const publishedCampaigns = campaigns.filter((campaign) => campaign.published).length;
  const anchoredProofs = proofs.filter((proof) => proof.status === "ANCHORED").length;

  return (
    <AuthenticatedLayout
      title="Ringkasan Sistem"
      subtitle="Pantau pengguna, organisasi, publikasi, operasi review, dan proof on-chain."
      actions={<Link className="action-button action-button--primary" href="/admin/reviews"><BadgeCheck size={16} aria-hidden="true" />Buka antrean review</Link>}
    >
      {loading && <div className="workspace-loading" aria-busy="true">Memuat ringkasan sistem…</div>}
      {error && <div className="workspace-error" role="alert"><p>{error}</p></div>}
      {!loading && !error && (
        <div className="dt-dashboard-grid">
          <section className="dt-kpi-grid" aria-label="Ringkasan sistem">
            <div className="dt-kpi-card dt-kpi-card--hero">
              <div className="dt-kpi-header-row"><div className="dt-kpi-icon-box dt-kpi-icon-box--dark"><Users size={18} aria-hidden="true" /></div><span className="dt-kpi-pill-badge dt-kpi-pill-badge--dark">RBAC</span></div>
              <span className="dt-kpi-label">Pengguna terdaftar</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{users.length}</strong></div>
              <span className="dt-kpi-sub">Verifier: {users.filter((u) => u.role === "VERIFIER").length} · Funder: {users.filter((u) => u.role === "FUNDER").length}</span>
            </div>
            <div className="dt-kpi-card">
              <div className="dt-kpi-header-row"><div className="dt-kpi-icon-box"><Building2 size={18} aria-hidden="true" /></div><span className="dt-kpi-pill-badge dt-kpi-pill-badge--teal">Terverifikasi</span></div>
              <span className="dt-kpi-label">Organisasi</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{organizations.length}</strong></div>
              <span className="dt-kpi-sub">{verifiedOrgs} sudah diverifikasi Admin</span>
            </div>
            <div className="dt-kpi-card">
              <div className="dt-kpi-header-row"><div className="dt-kpi-icon-box"><Globe2 size={18} aria-hidden="true" /></div><span className="dt-kpi-pill-badge dt-kpi-pill-badge--dark">Publik</span></div>
              <span className="dt-kpi-label">Campaign dipublikasikan</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{publishedCampaigns}</strong></div>
              <span className="dt-kpi-sub">Dari {campaigns.length} campaign dalam daftar publikasi</span>
            </div>
            <div className="dt-kpi-card">
              <div className="dt-kpi-header-row"><div className="dt-kpi-icon-box"><Anchor size={18} aria-hidden="true" /></div><span className="dt-kpi-pill-badge dt-kpi-pill-badge--teal">Sepolia</span></div>
              <span className="dt-kpi-label">Proof tercatat</span>
              <div className="dt-kpi-value-row"><strong className="dt-kpi-value">{anchoredProofs}</strong></div>
              <span className="dt-kpi-sub">Dari {proofs.length} proof yang dibuat</span>
            </div>
          </section>

          <div className="dt-two-col-grid">
            <section className="dt-card" aria-labelledby="admin-ops-heading">
              <div className="dt-card-header"><div><span className="dt-card-eyebrow">OPERASI</span><h2 id="admin-ops-heading" className="dt-card-title">Manajemen sistem</h2></div><ShieldCheck size={18} aria-hidden="true" /></div>
              <p className="dt-card-desc">Admin mengelola akun, verifikasi organisasi, publikasi audit, dan memantau antrean review. Admin tidak dapat memberi vote atau mengubah keputusan quorum.</p>
              <ul className="audit-activity-list">
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--lime" /><div className="audit-item-main"><Link href="/admin/users">Manajemen akun &amp; organisasi</Link><span>{users.length} pengguna, {organizations.length} organisasi</span></div></li>
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--teal" /><div className="audit-item-main"><Link href="/admin/reviews">Pantau antrean review</Link><span>{reviews.length} round dalam pantauan</span></div></li>
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--navy" /><div className="audit-item-main"><Link href="/admin/campaigns">Atur audit publik</Link><span>{publishedCampaigns} campaign tampil publik</span></div></li>
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--lime" /><div className="audit-item-main"><Link href="/admin/proofs">Proof on-chain</Link><span>{anchoredProofs} proof ANCHORED</span></div></li>
              </ul>
            </section>

            <section className="dt-card" aria-labelledby="admin-audit-heading">
              <div className="dt-card-header"><div><span className="dt-card-eyebrow">AUDIT &amp; KONSOLIDASI</span><h2 id="admin-audit-heading" className="dt-card-title">Jejak aktivitas</h2></div><Anchor size={18} aria-hidden="true" /></div>
              <p className="dt-card-desc">Gunakan jejak audit untuk meninjau status campaign dan milestone lintas peran. Catatan privat verifier dan file bukti tidak tersedia di konsol Admin.</p>
              <Link className="action-button action-button--secondary" href="/reports">Buka audit trail</Link>
            </section>
          </div>
        </div>
      )}
    </AuthenticatedLayout>
  );
}
