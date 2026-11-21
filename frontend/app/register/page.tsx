"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";

import { ApiError, requestJson } from "../../lib/api";
import horizontalLogo from "../../public/asset/lockup_horizontal.png";
import iconLogo from "../../public/asset/logo_icon_lime.png";
import whiteLogo from "../../public/asset/lockup_full_white.png";

const ORGANIZATION_TYPES = ["NGO", "COMPANY", "GOVERNMENT", "COMMUNITY", "OTHER"] as const;
// Keep in sync with TERMS_VERSION in backend/src/auth/validation.js.
const TERMS_VERSION = "2026-10-07-funder-terms-v1";

const ORG_TYPE_LABELS: Record<(typeof ORGANIZATION_TYPES)[number], string> = {
  NGO: "LSM / NGO",
  COMPANY: "Perusahaan / Korporasi",
  GOVERNMENT: "Instansi Pemerintah",
  COMMUNITY: "Komunitas",
  OTHER: "Lainnya",
};

function registrationMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "account_unavailable") {
    return "Akun tidak dapat dibuat dengan email ini. Periksa alamat atau hubungi Admin.";
  }
  if (error instanceof ApiError && error.code === "invalid_request") {
    return "Periksa kembali data yang diisi dan persyaratan kata sandi.";
  }
  return "Akun belum dapat dibuat. Periksa koneksi lalu coba lagi; data yang diisi tetap tersimpan.";
}

export default function RegisterPage() {
  const router = useRouter();
  const [role, setRole] = useState<"ORGANIZER" | "FUNDER">("ORGANIZER");
  const [funderAccountType, setFunderAccountType] = useState<"INDIVIDUAL" | "ORGANIZATION">("INDIVIDUAL");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationType, setOrganizationType] = useState<(typeof ORGANIZATION_TYPES)[number]>("COMMUNITY");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isOrganizationAccount = role === "ORGANIZER" || funderAccountType === "ORGANIZATION";

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("role") === "FUNDER") setRole("FUNDER");
    setReady(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const accountType = role === "ORGANIZER" ? "ORGANIZATION" : funderAccountType;
      await requestJson("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password,
          role,
          accountType,
          ...(accountType === "ORGANIZATION" ? { organizationName, organizationType } : {}),
          acceptedTermsVersion: TERMS_VERSION,
        }),
      });
      const requestedPath = new URLSearchParams(window.location.search).get("next");
      const defaultPath = role === "FUNDER" ? "/dashboard" : "/campaigns";
      router.replace(requestedPath?.startsWith("/") && !requestedPath.startsWith("//") ? requestedPath : defaultPath);
    } catch (cause) {
      setError(registrationMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main id="main" className="auth-page">
      <section className="auth-panel" aria-labelledby="register-title">
        <Link className="auth-brand-logo" href="/" aria-label="DanaTerang, halaman utama">
          <Image
            src={horizontalLogo}
            alt="DanaTerang"
            style={{ width: 160, height: "auto" }}
            priority
          />
        </Link>

        <div className="auth-panel-intro">
          <p className="eyebrow">DAFTAR DI DANATERANG</p>
          <h1 id="register-title" className="auth-title">Buat akun {role === "ORGANIZER" ? "Organizer" : "Funder"}</h1>
          <p className="auth-intro">
            {role === "ORGANIZER"
              ? "Daftarkan organisasi untuk mengelola campaign dan bukti program."
              : funderAccountType === "INDIVIDUAL"
                ? "Buat akun perorangan untuk mendukung program dan memantau bukti penyaluran."
                : "Daftarkan komunitas atau instansi untuk mendukung program dan memantau bukti penyaluran."}
          </p>
        </div>

        <form className="auth-form" onSubmit={submit} aria-busy={submitting}>
          <div className="form-field">
            <label htmlFor="register-role">Daftar sebagai</label>
            <select id="register-role" name="role" value={role} onChange={(event) => setRole(event.target.value as "ORGANIZER" | "FUNDER")}>
              <option value="ORGANIZER">Organizer / Pelaksana Program</option>
              <option value="FUNDER">Funder / Donatur</option>
            </select>
          </div>

          {role === "FUNDER" && (
            <div className="form-field">
              <label htmlFor="register-account-type">Jenis akun Funder</label>
              <select
                id="register-account-type"
                name="accountType"
                value={funderAccountType}
                onChange={(event) => setFunderAccountType(event.target.value as "INDIVIDUAL" | "ORGANIZATION")}
              >
                <option value="INDIVIDUAL">Perorangan</option>
                <option value="ORGANIZATION">Komunitas / instansi</option>
              </select>
              <p className="field-hint">Pilih perorangan untuk mendaftar tanpa profil organisasi.</p>
            </div>
          )}

          <div className="form-field">
            <label htmlFor="register-name">{role === "FUNDER" && funderAccountType === "INDIVIDUAL" ? "Nama lengkap" : "Nama lengkap PIC"}</label>
            <input
              id="register-name"
              name="name"
              autoComplete="name"
              placeholder="Nama Anda"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={1}
              maxLength={160}
              required
            />
          </div>
          {isOrganizationAccount && (
            <>
              <div className="form-field">
                <label htmlFor="register-organization">{role === "FUNDER" ? "Nama komunitas / instansi" : "Nama organisasi"}</label>
                <input
                  id="register-organization"
                  name="organizationName"
                  autoComplete="organization"
                  placeholder="Komunitas / instansi / perusahaan..."
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                  minLength={2}
                  maxLength={180}
                  required
                />
              </div>
              <div className="form-field">
                <label htmlFor="register-organization-type">Jenis organisasi</label>
                <select
                  id="register-organization-type"
                  name="organizationType"
                  value={organizationType}
                  onChange={(event) => setOrganizationType(event.target.value as (typeof ORGANIZATION_TYPES)[number])}
                >
                  {ORGANIZATION_TYPES.map((type) => (
                    <option key={type} value={type}>{ORG_TYPE_LABELS[type]}</option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="form-field">
            <label htmlFor="register-email">Email</label>
            <input
              id="register-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="pic@organisasi.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="register-password">Kata sandi</label>
            <div className="password-field-wrap">
              <input
                id="register-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="Min. 12 karakter"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={12}
                maxLength={128}
                aria-describedby="register-password-hint"
                required
              />
              <button
                type="button"
                className="password-eye-btn"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
              >
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
            <p id="register-password-hint" className="field-hint">Gunakan 12–128 karakter. Kata sandi tidak akan ditampilkan.</p>
          </div>

          {error && (
            <div className="auth-error-box" role="alert" aria-live="assertive">
              <p>{error}</p>
            </div>
          )}

          <div className="form-field form-field--checkbox">
            <input
              id="register-terms"
              name="acceptedTerms"
              type="checkbox"
              checked={acceptedTerms}
              onChange={(event) => setAcceptedTerms(event.target.checked)}
              required
            />
            <label htmlFor="register-terms">
              Saya menyetujui Syarat &amp; Ketentuan DanaTerang, termasuk bahwa bukti program diverifikasi panel 3 Verifier dan hasilnya tercatat permanen.
            </label>
          </div>

          <button
            className="action-button action-button--primary auth-cta-btn"
            type="submit"
            disabled={!ready || submitting}
            aria-busy={submitting}
          >
            {submitting ? "Membuat akun…" : ready ? "Buat akun" : "Menyiapkan formulir…"}
          </button>
        </form>

        <p className="auth-switch">Sudah punya akun? <Link href="/login">Masuk</Link></p>
      </section>

      <aside className="auth-aside" aria-labelledby="register-aside-title">
        <div className="auth-aside-logo-row">
          <Image
            src={iconLogo}
            alt=""
            style={{ width: 40, height: "auto" }}
            aria-hidden="true"
          />
          <Image
            src={whiteLogo}
            alt="DanaTerang"
            style={{ width: 120, height: "auto" }}
          />
        </div>
        <p className="eyebrow">PRIVASI SEJAK AWAL</p>
        <h2 id="register-aside-title">Bukti asli tidak ditampilkan untuk publik secara default.</h2>
        <ol className="auth-steps">
          <li>
            <span>01</span>
            <div>
              <strong>Pilih peran akun</strong>
              <p>Daftar sebagai Organizer, atau Funder perorangan maupun komunitas/instansi.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Akun Funder</strong>
              <p>Akun Funder dapat langsung dibuat. Profil komunitas/instansi dapat diverifikasi Admin.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Verifier Independen</strong>
              <p>Akses Admin dan Verifier tetap dikelola terpisah untuk menjaga independensi dan keamanan.</p>
            </div>
          </li>
        </ol>
        <div className="auth-aside-security">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>Dokumen asli tetap privat. Status review dan proof memiliki arti yang berbeda.</span>
        </div>
      </aside>
    </main>
  );
}
