"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Copy, Loader2, LogOut, ShieldCheck, Wallet } from "lucide-react";

import { ApiError, requestJson } from "../lib/api";
import { requestVerifierAddress, signTypedData } from "../lib/verifierWallet";
import { useCurrentUser } from "../lib/useCurrentUser";

const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function shortWallet(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Binding message the Funder signs to prove control of the wallet.
 *  Must stay identical to the backend's verification message. */
function buildBindingTypedData(address: string, accountId: string) {
  return {
    domain: { name: "DanaTerang Wallet Binding", version: "1" },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
      ],
      WalletBinding: [
        { name: "wallet", type: "address" },
        { name: "account", type: "string" },
        { name: "action", type: "string" },
      ],
    },
    primaryType: "WalletBinding",
    message: { wallet: address, account: accountId, action: "bind" },
  };
}

export default function FunderWalletButton() {
  const { user } = useCurrentUser();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const walletOwnerLabel = user?.role === "ORGANIZER" ? "Organizer" : "Donatur";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await requestJson<{ walletAddress: string | null }>("/api/auth/wallet");
      setWalletAddress(response.walletAddress);
    } catch {
      setWalletAddress(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const connect = useCallback(async () => {
    if (!user) return;
    setConnecting(true);
    setError("");
    setNotice("");
    try {
      const address = await requestVerifierAddress();
      const typedData = buildBindingTypedData(address, user.id);
      const signature = await signTypedData(address, typedData);
      await requestJson("/api/auth/wallet", {
        method: "POST",
        body: JSON.stringify({ signature, walletAddress: address }),
      });
      await load();
      setNotice("Wallet berhasil dihubungkan.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "wallet_already_bound") {
        setError("Wallet ini sudah terikat ke akun lain.");
      } else if (cause instanceof ApiError && cause.code === "invalid_wallet_signature") {
        setError("Tanda tangan wallet tidak cocok. Pastikan akun MetaMask yang dipilih benar.");
      } else if (cause instanceof Error && cause.message === "wallet_not_available") {
        setError("MetaMask tidak ditemukan. Pasang MetaMask lalu coba lagi.");
      } else if (cause instanceof Error && cause.message === "4001") {
        setError("Tanda tangan dibatalkan di wallet.");
      } else {
        setError(`Wallet ${walletOwnerLabel} belum dapat dihubungkan. Coba lagi.`);
      }
    } finally {
      setConnecting(false);
    }
  }, [load, user, walletOwnerLabel]);

  const copyAddress = useCallback(async () => {
    if (!walletAddress) return;
    setError("");
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setNotice("Alamat wallet disalin.");
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Alamat gagal disalin. Salin manual dari kotak alamat.");
    }
  }, [walletAddress]);

  const disconnect = useCallback(async () => {
    setReleasing(true);
    setError("");
    setNotice("");
    try {
      await requestJson("/api/auth/wallet", { method: "DELETE" });
      setWalletAddress(null);
      setMenuOpen(false);
      setNotice("Wallet berhasil dilepaskan.");
    } catch {
      setError("Wallet gagal dilepaskan. Coba lagi.");
    } finally {
      setReleasing(false);
    }
  }, []);

  if (loading || !user) return null;

  return (
    <div className="funder-wallet" ref={boxRef}>
      {walletAddress && WALLET_ADDRESS.test(walletAddress) ? (
        <div className="funder-wallet-wrap">
          <button
            className="funder-wallet-chip"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Wallet ${walletOwnerLabel.toLowerCase()} ${shortWallet(walletAddress)} terhubung. Buka menu`}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="funder-wallet-avatar" aria-hidden="true"><Wallet size={18} /></span>
            <span className="funder-wallet-chip-text">
              <span className="funder-wallet-chip-eyebrow"><span className="funder-wallet-dot" />Dompet {walletOwnerLabel.toLowerCase()}</span>
              <span className="funder-wallet-chip-address">{shortWallet(walletAddress)}</span>
            </span>
            <span className={`funder-wallet-chevron${menuOpen ? " funder-wallet-chevron--open" : ""}`} aria-hidden="true">
              <ChevronDown size={16} />
            </span>
          </button>

          {menuOpen && (
            <div className="funder-wallet-popover" role="menu" aria-label="Menu dompet funder">
              <div className="funder-wallet-popover-head">
                <div>
                  <span className="funder-wallet-popover-eyebrow">Dompet terhubung</span>
                  <strong className="funder-wallet-popover-title">Sepolia · {walletOwnerLabel}</strong>
                </div>
                <span className="status-pill status-pill--success">Aktif</span>
              </div>

              <div className="funder-wallet-address-box">
                <code title={walletAddress}>{walletAddress}</code>
                <button type="button" className="funder-wallet-copy-icon" onClick={() => void copyAddress()} aria-label="Salin alamat wallet" title="Salin alamat">
                  <Copy size={15} aria-hidden="true" />
                </button>
              </div>

              <div className="funder-wallet-actions">
                <button className="funder-wallet-action" role="menuitem" type="button" onClick={() => void copyAddress()}>
                  <Copy size={16} aria-hidden="true" />
                  <span>{copied ? "Alamat tersalin" : "Salin alamat"}</span>
                  {copied ? <span className="funder-wallet-check" aria-hidden="true">✓</span> : null}
                </button>
                <button className="funder-wallet-action funder-wallet-action--danger" role="menuitem" type="button" disabled={releasing} aria-busy={releasing} onClick={() => void disconnect()}>
                  {releasing ? <Loader2 size={16} className="funder-wallet-spin" aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}
                  <span>{releasing ? "Melepaskan…" : "Lepaskan wallet"}</span>
                </button>
              </div>

              <p className="funder-wallet-footnote"><ShieldCheck size={13} aria-hidden="true" /> Kunci privat tetap berada di wallet Anda.</p>
            </div>
          )}
        </div>
      ) : (
        <button
          className="funder-wallet-connect"
          type="button"
          disabled={connecting}
          aria-busy={connecting}
          onClick={() => void connect()}
        >
          {connecting ? <Loader2 size={16} className="funder-wallet-spin" aria-hidden="true" /> : <Wallet size={16} aria-hidden="true" />}
          <span>{connecting ? "Menghubungkan…" : `Hubungkan wallet ${walletOwnerLabel}`}</span>
        </button>
      )}

      {error && <p className="funder-wallet-alert" role="alert"><AlertTriangle size={14} aria-hidden="true" />{error}</p>}
      {notice && <span className="visually-hidden" role="status" aria-live="polite">{notice}</span>}
    </div>
  );
}
