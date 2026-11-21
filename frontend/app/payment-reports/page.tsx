"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Banknote, ShieldAlert } from "lucide-react";
import AuthenticatedLayout from "../../components/AuthenticatedLayout";
import { ApiError, requestJson } from "../../lib/api";
import { formatMoney } from "../../lib/formatMoney";
import { formatCurrencyTotals } from "../../lib/money";
import { useCurrentUser } from "../../lib/useCurrentUser";

type Report = {
  id: string; campaignId: string; campaignTitle: string; milestoneTitle: string;
  reportedAmount: string; currency: string; status: "PAYMENT_REPORTED"; paidAt: string;
  transactionReference?: string; notes?: string; createdAt: string;
};
type EligibleMilestone = {
  milestoneId: string; title: string; campaignTitle: string; currency: string; remainingAmount: string;
};

export default function PaymentReportsPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [reports, setReports] = useState<Report[]>([]);
  const [eligible, setEligible] = useState<EligibleMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [milestoneId, setMilestoneId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const selected = eligible.find((milestone) => milestone.milestoneId === milestoneId);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await requestJson<{ reports: Report[]; eligibleMilestones: EligibleMilestone[] }>("/api/payment-reports");
      setReports(data.reports);
      setEligible(data.eligibleMilestones);
      setMilestoneId((current) => data.eligibleMilestones.some((item) => item.milestoneId === current) ? current : data.eligibleMilestones[0]?.milestoneId ?? "");
    } catch { setError("Laporan pembayaran belum dapat dimuat. Periksa koneksi lalu coba lagi."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (user) void load(); }, [user?.id, load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || saving) return;
    setSaveError("");
    setMessage("");
    const payload = { reportedAmount: amount, currency: selected.currency, paidAt, transactionReference: reference.trim(), notes: notes.trim() };
    const fingerprint = JSON.stringify({ milestoneId, ...payload });
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setSaving(true);
    try {
      await requestJson(`/api/milestones/${milestoneId}/payment-reports`, { method: "POST", body: JSON.stringify({ ...payload, requestId: request.current.id }) });
      request.current = null;
      setAmount(""); setReference(""); setNotes("");
      setMessage("Laporan pembayaran tersimpan sebagai dilaporkan oleh Funder.");
      await load();
    } catch (cause) {
      const messages: Record<string, string> = {
        payment_not_ready: "Milestone harus memiliki bukti terkini yang disetujui quorum sebelum pembayaran dilaporkan.",
        payment_budget_exceeded: "Jumlah laporan melebihi sisa anggaran milestone. Perbarui daftar lalu periksa nominal.",
        payment_request_conflict: "Permintaan ini sudah digunakan untuk laporan berbeda. Perbarui halaman lalu periksa laporan yang tercatat.",
        invalid_request: "Periksa nominal positif (maksimal dua desimal), tanggal yang tidak di masa depan, dan referensi pembayaran.",
      };
      setSaveError(cause instanceof ApiError && messages[cause.code] ? messages[cause.code] : "Laporan belum dapat disimpan. Data tetap terisi dan dapat dikirim ulang dengan aman.");
    } finally { setSaving(false); }
  }

  return (
    <AuthenticatedLayout title="Payment Reports" subtitle="Laporan pembayaran eksternal yang dicatat oleh Funder untuk milestone program.">
      <div className="dt-notice-card" role="note">
        <div className="notice-icon" aria-hidden="true"><ShieldAlert size={20} /></div>
        <div className="notice-content"><strong>Dilaporkan oleh Funder</strong><p>Transfer aktual berlangsung di luar DanaTerang. Laporan ini bukan konfirmasi independen bahwa transfer telah diterima. Referensi dan catatan pembayaran bersifat privat dan tidak dimasukkan ke proof blockchain atau audit publik.</p></div>
      </div>
      {(loading || userLoading) && <div className="workspace-loading" aria-busy="true">Memuat laporan pembayaran…</div>}
      {error && <div className="workspace-error" role="alert"><p>{error}</p><button className="action-button action-button--secondary" onClick={() => void load()}>Coba lagi</button></div>}
      {message && <p role="status">{message}</p>}
      {!loading && !userLoading && !error && <>
        {user?.role === "FUNDER" && <section className="workspace-panel" aria-labelledby="payment-form-heading">
          <h2 id="payment-form-heading">Catat laporan pembayaran</h2>
          {eligible.length === 0 ? <p>Belum ada milestone yang siap dilaporkan. Diperlukan bukti terkini yang disetujui quorum, campaign aktif atau selesai, dan sisa anggaran.</p> : <form className="form-grid" onSubmit={save} aria-busy={saving}>
            <div className="form-field form-field--full"><label htmlFor="payment-milestone">Milestone pembayaran</label><select id="payment-milestone" value={milestoneId} onChange={(event) => setMilestoneId(event.target.value)} required>{eligible.map((item) => <option key={item.milestoneId} value={item.milestoneId}>{item.campaignTitle} — {item.title}</option>)}</select></div>
            <div className="form-field"><label htmlFor="payment-amount">Jumlah yang dilaporkan ({selected?.currency})</label><input id="payment-amount" inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,2})?" value={amount} onChange={(event) => setAmount(event.target.value)} required /><p className="field-hint">Sisa anggaran: {selected ? formatMoney(selected.remainingAmount, selected.currency) : "—"}</p></div>
            <div className="form-field"><label htmlFor="payment-date">Tanggal pembayaran menurut Funder</label><input id="payment-date" type="date" max={new Date().toISOString().slice(0, 10)} value={paidAt} onChange={(event) => setPaidAt(event.target.value)} required /></div>
            <div className="form-field form-field--full"><label htmlFor="payment-reference">Referensi transfer privat</label><input id="payment-reference" maxLength={200} value={reference} onChange={(event) => setReference(event.target.value)} required /></div>
            <div className="form-field form-field--full"><label htmlFor="payment-notes">Catatan pembayaran privat (opsional)</label><textarea id="payment-notes" rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
            {saveError && <p className="workspace-error form-field--full" role="alert">{saveError}</p>}
            <div className="workspace-actions form-field--full"><button className="action-button action-button--primary" disabled={saving}>{saving ? "Menyimpan…" : "Simpan laporan pembayaran"}</button></div>
          </form>}
        </section>}
        <section className="workspace-panel" aria-labelledby="payment-history-heading">
          <h2 id="payment-history-heading">Riwayat laporan pembayaran</h2>
          {reports.length === 0 ? <div className="workspace-empty"><Banknote size={32} aria-hidden="true" /><h3>Belum ada laporan pembayaran</h3><p>Laporan Funder untuk campaign yang dapat Anda akses akan muncul di sini.</p><Link href="/campaigns" className="action-button action-button--secondary">Buka campaign</Link></div> : <>
            <p>Total dilaporkan per mata uang: <strong>{formatCurrencyTotals(reports.map((report) => ({ amount: report.reportedAmount, currency: report.currency })))}</strong></p>
            <ul className="workspace-list">{reports.map((report) => <li key={report.id} className="workspace-list-item">
              <div><h3><Link href={`/campaigns/${report.campaignId}`}>{report.campaignTitle}</Link></h3><p>{report.milestoneTitle} · {formatMoney(report.reportedAmount, report.currency)}</p><p>Tanggal menurut Funder: {report.paidAt}</p>{report.transactionReference && <p>Referensi privat: {report.transactionReference}</p>}{report.notes && <p>{report.notes}</p>}</div>
              <span className="status-pill status-pill--pending">Dilaporkan oleh Funder</span>
            </li>)}</ul>
          </>}
        </section>
      </>}
    </AuthenticatedLayout>
  );
}
