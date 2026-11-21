"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import AuthenticatedLayout from "../../../components/AuthenticatedLayout";
import { ApiError, requestJson } from "../../../lib/api";
import { explorerTxUrl, proofStatusLabel, type Proof, type ProofStatus } from "../../../lib/blockchain";

type ProofWithMeta = Proof & { updatedAt?: string | null };

const STATUS_TONES: Record<ProofStatus, string> = {
  ANCHORED: "status-pill--success",
  ANCHORING: "status-pill--pending",
  PENDING: "status-pill--pending",
  FAILED: "status-pill--warning",
};

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("id-ID") : "—";
}

export default function AdminProofsPage() {
  const [proofs, setProofs] = useState<ProofWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [retryingProofId, setRetryingProofId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await requestJson<{ proofs: ProofWithMeta[] }>("/api/admin/proofs");
      setProofs(response.proofs);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403
        ? "Halaman ini hanya tersedia untuk Admin."
        : "Daftar proof belum dapat dimuat. Periksa koneksi lalu coba lagi.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function retry(proof: ProofWithMeta) {
    setRetryingProofId(proof.proofId);
    setActionError("");
    setNotice("");
    try {
      const response = await requestJson<{ status: string }>(`/api/admin/proofs/${proof.proofId}/retry`, {
        method: "POST",
      });
      setNotice(response.status === "ANCHORED"
        ? `Proof ${shortHash(proof.proofId)} berhasil dicatat di jaringan.`
        : `Pencatatan proof ${shortHash(proof.proofId)} masih berjalan; daftar akan diperbarui.`);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 503 && cause.code === "proof_anchor_disabled") {
        setActionError("Pencatatan on-chain belum dikonfigurasi di server (PROOF_ANCHOR_CONTRACT_ADDRESS kosong).");
      } else if (cause instanceof ApiError && cause.status === 409) {
        setActionError("Proof sedang diproses atau melewati batas percobaan; coba lagi nanti.");
      } else {
        setActionError("Percobaan ulang gagal. Periksa koneksi lalu coba lagi.");
      }
    } finally {
      setRetryingProofId("");
    }
  }

  const anchoredCount = proofs.filter((proof) => proof.status === "ANCHORED").length;
  const failedCount = proofs.filter((proof) => proof.status === "FAILED").length;

  return (
    <AuthenticatedLayout title="Proof on-chain">
      {loading ? (
        <div className="workspace-loading" aria-busy="true">Memuat daftar proof…</div>
      ) : error ? (
        <div className="workspace-error"><p role="alert" aria-live="assertive">{error}</p><button className="action-button action-button--secondary" onClick={() => void load()}>Coba lagi</button></div>
      ) : (
        <>
          <p className="section-note">
            Setiap keputusan quorum dikunci sebagai komitmen SHA-256 di {`Sepolia`}. {anchoredCount} tercatat,{" "}
            {failedCount} gagal dari total {proofs.length}. Kegagalan dapat diulang — idempoten untuk proof yang sama.
          </p>
          <p className={notice ? "workspace-success" : "visually-hidden"} role="status" aria-live="polite">{notice}</p>
          <p className={actionError ? "workspace-error" : "visually-hidden"} role="alert" aria-live="assertive">{actionError}</p>
          {proofs.length === 0 ? (
            <section className="workspace-empty">
              <h2>Belum ada proof</h2>
              <p>Proof dibuat otomatis setelah sebuah bukti mencapai keputusan quorum 2-dari-3.</p>
              <Link href="/admin/campaigns">Lihat campaign</Link>
            </section>
          ) : (
            <div className="table-scroll workspace-panel">
              <table className="workspace-table">
                <caption>Komitmen bukti di jaringan</caption>
                <thead>
                  <tr>
                    <th scope="col">Proof</th>
                    <th scope="col">Status</th>
                    <th scope="col">Komitmen (SHA-256)</th>
                    <th scope="col">Transaksi</th>
                    <th scope="col">Percobaan</th>
                    <th scope="col">Diperbarui</th>
                    <th scope="col">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {proofs.map((proof) => (
                    <tr key={proof.proofId}>
                      <th scope="row">
                        {shortHash(proof.proofId)}
                        <br />
                        <span className="table-meta">Bukti {proof.evidenceId.slice(0, 8)}</span>
                      </th>
                      <td>
                        <span className={`status-pill ${STATUS_TONES[proof.status]}`}>
                          {proofStatusLabel(proof.status)}
                        </span>
                        {proof.lastErrorCode && <p className="field-hint">{proof.lastErrorCode}</p>}
                      </td>
                      <td><span className="table-meta">{shortHash(proof.packageHash)}</span></td>
                      <td>
                        {proof.transactionHash
                          ? <a href={explorerTxUrl(proof.transactionHash)} target="_blank" rel="noreferrer">Lihat di explorer</a>
                          : <span className="table-meta">—</span>}
                        {proof.blockNumber != null && <p className="table-meta">Blok {proof.blockNumber}</p>}
                      </td>
                      <td>{proof.attempts}</td>
                      <td>{formatDate(proof.updatedAt ?? proof.anchoredAt)}</td>
                      <td>
                        {proof.status === "ANCHORED" ? <span className="table-meta">Selesai</span> : (
                          <button
                            className="action-button action-button--secondary"
                            type="button"
                            disabled={retryingProofId === proof.proofId}
                            aria-busy={retryingProofId === proof.proofId}
                            onClick={() => void retry(proof)}
                          >
                            {retryingProofId === proof.proofId ? "Mencatat…" : "Catat ulang"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </AuthenticatedLayout>
  );
}
