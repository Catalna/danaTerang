"use client";

import Link from "next/link";
import { BadgeCheck, ClipboardCheck, House } from "lucide-react";

import AuthenticatedLayout from "../../components/AuthenticatedLayout";
import { useCurrentUser } from "../../lib/useCurrentUser";

/** Beneficiary is post-MVP in the product spec; give the role an honest, usable landing. */
export default function BeneficiaryPage() {
  const { user, loading } = useCurrentUser();

  return (
    <AuthenticatedLayout
      title="Portal Penerima Manfaat"
      subtitle="Ruangan untuk konfirmasi penerimaan dan informasi program yang menyangkut Anda."
    >
      {loading && <div className="workspace-loading" aria-busy="true">Memeriksa akun…</div>}
      {!loading && (
        <div className="dt-dashboard-grid">
          <section className="dt-card" aria-labelledby="beneficiary-status-heading">
            <div className="dt-card-header">
              <div>
                <span className="dt-card-eyebrow">PERAN PENERIMA</span>
                <h2 id="beneficiary-status-heading" className="dt-card-title">Status fitur penerima manfaat</h2>
              </div>
              <BadgeCheck size={18} aria-hidden="true" />
            </div>
            <p className="dt-card-desc">
              Halo {user?.name ?? "Penerima manfaat"}. Peran Penerima Manfaat dikenali oleh sistem, tetapi alur
              konfirmasi penerimaan, unggah dukung, dan testimony masih direncanakan untuk fase setelah MVP.
              Saat ini belum ada aksi yang dapat dilakukan dari akun ini.
            </p>
            <p className="dt-budget-footnote">
              Verifikasi bukti dilakukan oleh tiga Verifier independen, dan pendanaan dicatat oleh Funder.
              Anda tidak perlu wallet atau kata sandi tambahan.
            </p>
          </section>

          <div className="dt-two-col-grid">
            <section className="dt-card" aria-labelledby="beneficiary-next-heading">
              <div className="dt-card-header"><div><span className="dt-card-eyebrow">YANG AKAN DATANG</span><h2 id="beneficiary-next-heading" className="dt-card-title">Fitur yang direncanakan</h2></div><ClipboardCheck size={18} aria-hidden="true" /></div>
              <ul className="audit-activity-list">
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--lime" /><div className="audit-item-main"><strong>Konfirmasi penerimaan manfaat</strong><span>Terencana · post-MVP</span></div></li>
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--teal" /><div className="audit-item-main"><strong>Unggah bukti pendukung</strong><span>Terencana · post-MVP</span></div></li>
                <li className="audit-activity-item"><div className="audit-bullet audit-bullet--navy" /><div className="audit-item-main"><strong>Testimony penerima</strong><span>Terencana · post-MVP</span></div></li>
              </ul>
            </section>

            <section className="dt-card" aria-labelledby="beneficiary-public-heading">
              <div className="dt-card-header"><div><span className="dt-card-eyebrow">INFORMASI PUBLIK</span><h2 id="beneficiary-public-heading" className="dt-card-title">Lihat program publik</h2></div><House size={18} aria-hidden="true" /></div>
              <p className="dt-card-desc">Campaign yang sudah dipublikasikan Admin dapat dilihat tanpa login di halaman audit publik.</p>
              <Link className="action-button action-button--secondary" href="/">Buka audit publik</Link>
            </section>
          </div>
        </div>
      )}
    </AuthenticatedLayout>
  );
}
