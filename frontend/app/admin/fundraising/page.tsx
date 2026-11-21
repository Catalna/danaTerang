"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import AuthenticatedLayout from "../../../components/AuthenticatedLayout";
import { ApiError, requestJson } from "../../../lib/api";

type SurplusTransfer = {
  id: string;
  sourceCampaignId: string;
  destinationCampaignId: string;
  sourceCampaignTitle: string;
  destinationCampaignTitle: string;
  causeCategory: string;
  amount: string;
  currency: string;
  reason: string;
  status: string;
  createdAt: string;
};

type Reconciliation = {
  donations: string;
  providerFees: string;
  milestonePayouts: string;
  refunds: string;
  transfersIn: string;
  transfersOut: string;
  platformSupport: string;
  escrow: string;
};
type Organization = { id: string; name: string; type: string; verified: boolean };

function idr(amount: string) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

export default function AdminFundraisingPage() {
  const [transfers, setTransfers] = useState<SurplusTransfer[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [provider, setProvider] = useState("");
  const [providerRecipientId, setProviderRecipientId] = useState("");
  const [reconciliations, setReconciliations] = useState<Record<string, Reconciliation>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [response, organizationsResponse] = await Promise.all([
        requestJson<{ transfers: SurplusTransfer[] }>("/api/admin/fundraising/surplus-transfers?status=REQUESTED"),
        requestJson<{ organizations: Organization[] }>("/api/admin/organizations"),
      ]);
      setTransfers(response.transfers);
      setOrganizations(organizationsResponse.organizations);
      setSelectedOrganizationId((current) => current || organizationsResponse.organizations[0]?.id || "");
      const ids = [...new Set(response.transfers.flatMap((item) => [item.sourceCampaignId, item.destinationCampaignId]))];
      const balances = await Promise.all(ids.map(async (id) => {
        try {
          const result = await requestJson<{ reconciliation: Reconciliation }>(`/api/campaigns/${id}/reconciliation`);
          return [id, result.reconciliation] as const;
        } catch {
          return [id, null] as const;
        }
      }));
      setReconciliations(Object.fromEntries(balances.filter((item): item is readonly [string, Reconciliation] => item[1] !== null)));
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? "Halaman ini hanya tersedia untuk Admin." : "Permintaan transfer belum dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function approve(transferId: string) {
    setBusyId(transferId);
    setError("");
    setMessage("");
    try {
      await requestJson(`/api/admin/fundraising/surplus-transfers/${transferId}/approve`, { method: "PATCH" });
      setMessage("Transfer surplus disetujui dan dicatat pada ledger kedua campaign.");
      await load();
    } catch {
      setError("Transfer tidak dapat disetujui. Periksa kembali saldo, persetujuan donatur, dan kategori campaign.");
    } finally {
      setBusyId("");
    }
  }

  async function verifyPayoutRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOrganizationId) return;
    setBusyId(`recipient:${selectedOrganizationId}`);
    setError("");
    setMessage("");
    try {
      await requestJson(`/api/admin/organizations/${selectedOrganizationId}/payout-recipient`, {
        method: "PATCH",
        body: JSON.stringify({ provider, providerRecipientId }),
      });
      setMessage("Recipient payout tersimpan dan ditandai diverifikasi Admin.");
      setProviderRecipientId("");
    } catch {
      setError("Recipient payout belum dapat disimpan. Verifikasi lebih dulu identitas dan rekening pada provider.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <AuthenticatedLayout title="Escrow dan transfer surplus" subtitle="Tinjau saldo ledger dan permintaan pengalihan dana ke campaign sejenis.">
      <p className={message ? "workspace-success" : "visually-hidden"} role="status" aria-live="polite">{message}</p>
      {loading ? <div className="workspace-loading" aria-busy="true">Memuat permintaan transfer…</div> : error ? (
        <div className="workspace-error" role="alert"><p>{error}</p><button className="action-button action-button--secondary" onClick={() => void load()}>Coba lagi</button></div>
      ) : (
        <>
          <section className="workspace-panel" aria-labelledby="payout-recipient-title">
            <p className="eyebrow">PENERIMA PENCAIRAN</p>
            <h2 id="payout-recipient-title">Verifikasi recipient organisasi</h2>
            <p className="field-hint">Masukkan recipient ID dari provider setelah organisasi dan rekening penerima diverifikasi. Hanya recipient aktif yang bisa menerima payout milestone.</p>
            <form className="form-grid" onSubmit={(event) => void verifyPayoutRecipient(event)}>
              <div className="form-field form-field--full"><label htmlFor="payout-organization">Organisasi</label><select id="payout-organization" value={selectedOrganizationId} onChange={(event) => setSelectedOrganizationId(event.target.value)} required>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {organization.type}{organization.verified ? " · terverifikasi" : " · belum verifikasi organisasi"}</option>)}</select></div>
              <div className="form-field"><label htmlFor="payout-provider">Kode provider</label><input id="payout-provider" value={provider} onChange={(event) => setProvider(event.target.value)} minLength={2} maxLength={40} required /></div>
              <div className="form-field"><label htmlFor="payout-recipient">Recipient ID</label><input id="payout-recipient" value={providerRecipientId} onChange={(event) => setProviderRecipientId(event.target.value)} maxLength={200} required /></div>
              <button className="action-button action-button--secondary" type="submit" disabled={busyId.startsWith("recipient:")}>{busyId.startsWith("recipient:") ? "Menyimpan…" : "Simpan recipient terverifikasi"}</button>
            </form>
          </section>
          {transfers.length === 0 ? <section className="workspace-empty"><h2>Tidak ada permintaan transfer</h2><p>Permintaan pengalihan sisa dana yang perlu ditinjau Admin akan muncul di sini.</p></section> : null}
          <div className="workspace-list">
            {transfers.map((transfer) => (
            <section className="workspace-panel" key={transfer.id} aria-labelledby={`transfer-${transfer.id}`}>
              <p className="eyebrow">{transfer.causeCategory} · {transfer.status}</p>
              <h2 id={`transfer-${transfer.id}`}>{transfer.sourceCampaignTitle} → {transfer.destinationCampaignTitle}</h2>
              <p>{transfer.reason}</p>
              <p><strong>{idr(transfer.amount)}</strong></p>
              <dl className="org-details-dl">
                <div className="org-dl-row"><dt>Saldo escrow sumber saat ini</dt><dd>{idr(reconciliations[transfer.sourceCampaignId]?.escrow ?? "0.00")}</dd></div>
                <div className="org-dl-row"><dt>Saldo escrow tujuan saat ini</dt><dd>{idr(reconciliations[transfer.destinationCampaignId]?.escrow ?? "0.00")}</dd></div>
              </dl>
              <p className="field-hint">Pastikan kebijakan seluruh donasi sumber mengizinkan pengalihan. Backend akan memeriksa ulang consent, kategori, saldo tersedia, dan refund tertunda sebelum posting ledger.</p>
              <button className="action-button action-button--primary" type="button" disabled={busyId === transfer.id} aria-busy={busyId === transfer.id} onClick={() => void approve(transfer.id)}>
                {busyId === transfer.id ? "Menyetujui…" : "Setujui transfer surplus"}
              </button>
            </section>
            ))}
          </div>
        </>
      )}
    </AuthenticatedLayout>
  );
}
