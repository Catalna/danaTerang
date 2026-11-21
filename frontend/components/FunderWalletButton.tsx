"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [error, setError] = useState("");

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

  const connect = useCallback(async () => {
    if (!user) return;
    setConnecting(true);
    setError("");
    try {
      const address = await requestVerifierAddress();
      const typedData = buildBindingTypedData(address, user.id);
      const signature = await signTypedData(address, typedData);
      await requestJson("/api/auth/wallet", {
        method: "POST",
        body: JSON.stringify({ signature, walletAddress: address }),
      });
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "wallet_already_bound") {
        setError("Wallet ini sudah terikat ke akun lain.");
      } else if (cause instanceof Error && cause.message === "wallet_not_available") {
        setError("MetaMask tidak ditemukan. Pasang MetaMask lalu coba lagi.");
      } else if (cause instanceof Error && cause.message === "4001") {
        setError("Tanda tangan dibatalkan di wallet.");
      } else {
        setError("Wallet belum dapat dihubungkan. Coba lagi.");
      }
    } finally {
      setConnecting(false);
    }
  }, [load, user]);

  if (loading || !user) return null;

  return (
    <div className="funder-wallet-box">
      {walletAddress ? (
        <span className="funder-wallet-connected" title={walletAddress}>
          <span className="pill-dot pill-dot--lime" aria-hidden="true" />
          {shortWallet(walletAddress)}
        </span>
      ) : (
        <>
          <button className="action-button action-button--secondary funder-wallet-connect" type="button" disabled={connecting} aria-busy={connecting} onClick={() => void connect()}>
            {connecting ? "Menghubungkan…" : "Hubungkan Wallet"}
          </button>
          {error ? <span className="funder-wallet-error" role="alert">{error}</span> : null}
        </>
      )}
    </div>
  );
}
