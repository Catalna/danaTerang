"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import AuthenticatedLayout from "../../../components/AuthenticatedLayout";
import { ApiError, requestJson } from "../../../lib/api";
import { useCurrentUser } from "../../../lib/useCurrentUser";

function messageFor(error: unknown) {
  if (error instanceof ApiError && error.code === "invalid_request") return "Periksa kembali target, tanggal tutup, dan data campaign.";
  if (error instanceof ApiError && error.code === "invalid_fundraising_close") return "Waktu tutup campaign harus minimal 48 jam dari sekarang.";
  return "Campaign belum dapat disimpan. Data yang diisi tetap tersedia; coba lagi.";
}

function defaultCloseTime() {
  const value = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  value.setMinutes(0, 0, 0);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function minimumCloseTime() {
  const value = new Date(Date.now() + 48 * 60 * 60 * 1000 + 60_000);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function NewCampaignPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [causeCategory, setCauseCategory] = useState("OTHER");
  const [totalBudget, setTotalBudget] = useState("");
  const [fundraisingCloseAt, setFundraisingCloseAt] = useState(defaultCloseTime);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await requestJson<{ campaign: { id: string } }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          causeCategory,
          totalBudget,
          currency: "IDR",
          fundingMode: "EXTERNAL_TRACKING",
          fundraisingCloseAt: new Date(fundraisingCloseAt).toISOString(),
        }),
      });
      router.push(`/campaigns/${response.campaign.id}`);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthenticatedLayout title="Buat campaign">
      {userLoading ? <div className="workspace-loading" aria-busy="true">Memeriksa sesi…</div> : user?.role !== "ORGANIZER" ? (
        <section className="workspace-error" role="alert">Campaign draft dibuat oleh akun Organizer.</section>
      ) : (
        <form className="workspace-panel form-grid" onSubmit={submit} aria-busy={submitting}>
          <div className="form-field form-field--full">
            <label htmlFor="campaign-title">Judul campaign</label>
            <input id="campaign-title" value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={160} required />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="campaign-description">Deskripsi</label>
            <textarea id="campaign-description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="campaign-cause">Kategori tujuan</label>
            <select id="campaign-cause" value={causeCategory} onChange={(event) => setCauseCategory(event.target.value)}>
              <option value="DISASTER_RELIEF">Bantuan bencana</option>
              <option value="EDUCATION">Pendidikan</option>
              <option value="HEALTH">Kesehatan</option>
              <option value="COMMUNITY">Pemberdayaan komunitas</option>
              <option value="OTHER">Lainnya</option>
            </select>
            <p className="field-hint">Kategori ini digunakan untuk menjaga agar pengalihan sisa dana hanya menuju campaign sejenis.</p>
          </div>
          <div className="form-field">
            <label htmlFor="campaign-budget">Target penggalangan dana</label>
            <input id="campaign-budget" inputMode="decimal" value={totalBudget} onChange={(event) => setTotalBudget(event.target.value)} aria-describedby="campaign-budget-hint" required />
            <p className="field-hint" id="campaign-budget-hint">Target bukan batas donasi. Donasi dapat melampaui target sampai campaign ditutup.</p>
          </div>
          <div className="form-field">
            <label htmlFor="campaign-currency">Mata uang</label>
            <input id="campaign-currency" value="IDR — Rupiah" readOnly aria-readonly="true" />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="fundraising-close-at">Tanggal dan waktu campaign ditutup</label>
            <input
              id="fundraising-close-at"
              type="datetime-local"
              min={minimumCloseTime()}
              value={fundraisingCloseAt}
              onChange={(event) => setFundraisingCloseAt(event.target.value)}
              required
            />
            <p className="field-hint">Ketentuan campaign akan dikunci pada H-48. Donasi tetap diterima sampai waktu tutup ini.</p>
          </div>
          <p className="form-message form-field--full" role="alert" aria-live="assertive">{error}</p>
          <div className="workspace-actions form-field--full">
            <button className="action-button action-button--primary" type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? "Menyimpan draft…" : "Simpan draft campaign"}
            </button>
            <Link className="action-button action-button--secondary" href="/campaigns">Batal</Link>
          </div>
        </form>
      )}
    </AuthenticatedLayout>
  );
}
