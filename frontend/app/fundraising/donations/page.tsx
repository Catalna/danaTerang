"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import AuthenticatedLayout from "../../../components/AuthenticatedLayout";
import { requestJson } from "../../../lib/api";

type Donation = {
  id: string;
  campaignId: string;
  campaignTitle: string;
  amount: string;
  providerFee: string;
  netAmount: string;
  currency: string;
  reallocationPolicy: "REDIRECT_RELATED" | "REFUND";
  status: string;
  createdAt: string;
  settledAt: string | null;
};

function idr(amount: string) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(amount));
}

export default function DonationHistoryPage() {
  const [donations, setDonations] = useState<Donation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await requestJson<{ donations: Donation[] }>("/api/fundraising/donations");
      setDonations(response.donations);
    } catch {
      setError("Riwayat donasi belum dapat dimuat.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <AuthenticatedLayout title="Riwayat donasi" subtitle="Lihat status pembayaran dan kebijakan penggunaan kembali donasi Anda.">
      {loading ? <div className="workspace-loading" aria-busy="true">Memuat donasi…</div> : error ? (
        <div className="workspace-error" role="alert"><p>{error}</p><button className="action-button action-button--secondary" onClick={() => void load()}>Coba lagi</button></div>
      ) : donations.length === 0 ? (
        <section className="workspace-empty"><h2>Belum ada donasi</h2><p>Campaign terbuka dapat dilihat di direktori penggalangan dana.</p><Link className="action-button action-button--primary" href="/fundraising">Jelajahi campaign</Link></section>
      ) : (
        <div className="table-scroll workspace-panel">
          <table className="workspace-table">
            <caption>Donasi yang tercatat untuk akun Anda</caption>
            <thead><tr><th scope="col">Campaign</th><th scope="col">Jumlah</th><th scope="col">Status</th><th scope="col">Sisa dana</th><th scope="col">Tanggal</th></tr></thead>
            <tbody>{donations.map((donation) => (
              <tr key={donation.id}>
                <th scope="row"><Link href={`/fundraising/${donation.campaignId}`}>{donation.campaignTitle}</Link></th>
                <td>{idr(donation.amount)}</td>
                <td><span className="status-pill status-pill--pending">{donation.status}</span></td>
                <td>{donation.reallocationPolicy === "REDIRECT_RELATED" ? "Boleh dialihkan ke campaign sejenis" : "Refund jika tersisa"}</td>
                <td>{new Date(donation.settledAt ?? donation.createdAt).toLocaleDateString("id-ID")}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </AuthenticatedLayout>
  );
}
