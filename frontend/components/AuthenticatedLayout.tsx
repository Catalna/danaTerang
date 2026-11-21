"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  LayoutDashboard,
  FolderKanban,
  ListChecks,
  FileCheck,
  Banknote,
  ArrowLeftRight,
  ScrollText,
  Building2,
  Users,
  UserRound,
  BadgeCheck,
  Globe2,
  Anchor,
  LogOut,
  Menu,
  X,
} from "lucide-react";

import { requestJson } from "../lib/api";
import { useCurrentUser, type UserSummary } from "../lib/useCurrentUser";
import WorkspaceSearch from "./WorkspaceSearch";
import WorkspaceAlerts from "./WorkspaceAlerts";
import FunderWalletButton from "./FunderWalletButton";
import horizontalLogo from "../public/asset/lockup_horizontal.png";

const WorkspaceUserContext = createContext<UserSummary | null>(null);

function navItem(pathname: string, href: string) {
  if (href === "/campaigns") {
    return pathname === "/campaigns" || pathname.startsWith("/campaigns/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Each role lands in its own workspace; public audit stays at the root. */
function workspaceHome(role: string) {
  if (role === "ADMIN") return "/admin";
  if (role === "FUNDER") return "/funder";
  if (role === "VERIFIER") return "/verifier/reviews";
  if (role === "BENEFICIARY") return "/beneficiary";
  return "/dashboard";
}

export default function AuthenticatedLayout({
  title,
  children,
  subtitle,
  actions,
  badgeCount,
}: {
  title: string;
  children: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  badgeCount?: Record<string, number>;
}) {
  const { user, loading, error, reload } = useCurrentUser();
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    document.getElementById("main")?.focus();
    setMobileMenuOpen(false);
  }, [pathname]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await requestJson<void>("/api/auth/logout", { method: "POST" });
      router.replace("/login");
    } catch {
      setLogoutError("Tidak dapat keluar sekarang. Coba lagi.");
    } finally {
      setLoggingOut(false);
    }
  }

  if (loading) {
    return (
      <main id="main" className="app-loading" aria-busy="true">
        <p>Memeriksa sesi…</p>
      </main>
    );
  }
  if (!user) {
    return (
      <main id="main" className="app-loading">
        <p role="alert">{error || "Mengalihkan ke halaman masuk…"}</p>
        {error && (
          <button
            className="action-button action-button--secondary"
            onClick={() => void reload()}
          >
            Coba lagi
          </button>
        )}
      </main>
    );
  }

  const isOrganizer = user.role === "ORGANIZER";
  const isAdminUser = user.role === "ADMIN";
  const isVerifier = user.role === "VERIFIER";
  const isFunder = user.role === "FUNDER";
  const isBeneficiary = user.role === "BENEFICIARY";
  const orgName = user.organization?.name || (isOrganizer ? "Yayasan Mitra" : user.name);
  const homeHref = workspaceHome(user.role);
  const labels = {
    dashboard: isAdminUser ? "Ringkasan Sistem" : isFunder ? "Portofolio Pendanaan" : "Dashboard",
    campaigns: isFunder ? "Program Saya" : "Campaign",
    milestones: isFunder ? "Progres Milestone" : "Milestones",
    paymentReports: isFunder ? "Laporan Pembayaran" : "Payment Reports",
    auditTrail: isFunder ? "Jejak Audit" : "Audit Trail",
    organizations: isFunder ? "Organisasi Mitra" : "Organizations",
  };

  return (
    <WorkspaceUserContext.Provider value={user}>
      <div className="workspace-shell">
        {/* Mobile Header Bar */}
        <nav className="workspace-mobile-bar" aria-label="Navigasi seluler">
          <div className="workspace-mobile-left">
            <button
              type="button"
              className="workspace-menu-toggle"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? "Tutup menu navigasi" : "Buka menu navigasi"}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            </button>
            <Link
              className="mobile-brand-link"
              href={homeHref}
              aria-label="DanaTerang, halaman utama"
            >
              <Image
                src={horizontalLogo}
                alt="DanaTerang"
                style={{ width: 120, height: "auto" }}
                priority
              />
            </Link>
          </div>
          <div className="workspace-mobile-right">
            <span className="dt-badge-role">{user.role}</span>
          </div>
        </nav>

        {/* Mobile Backdrop */}
        {mobileMenuOpen && (
          <div
            className="workspace-backdrop"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar (DesignUI.md - Section 4, 5, 6: width 240px, dark navy #101A2B) */}
        <aside
          className={`workspace-sidebar ${mobileMenuOpen ? "workspace-sidebar--open" : ""}`}
          aria-label="Navigasi Ruang Kerja"
        >
          {/* Logo Brand Header matching reference style */}
          <div className="workspace-sidebar-header">
            <Link
              className="workspace-sidebar-brand"
              href={homeHref}
              aria-label="DanaTerang, halaman utama"
            >
              <div className="dt-logo-badge">
                <Image
                  src={horizontalLogo}
                  alt="DanaTerang"
                  style={{ width: 140, height: "auto" }}
                  priority
                  className="workspace-brand-img"
                />
              </div>
            </Link>
          </div>

          {/* Navigation Items (DesignUI.md - Section 5 & 6) */}
          <nav className="workspace-nav" aria-label="Navigasi utama">
            {/* Admin Role Nav — di atas supaya selalu terlihat tanpa scroll (peran ADMIN) */}
            {isAdminUser && (
              <>
                <div className="nav-section-label nav-section-label--admin">Manajemen Admin</div>
                <Link
                  href="/admin/reviews"
                  className={`workspace-nav-item ${navItem(pathname, "/admin/reviews") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/admin/reviews") ? "page" : undefined}
                >
                  <BadgeCheck size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Operasi review</span>
                </Link>
                <Link
                  href="/admin/users"
                  className={`workspace-nav-item ${navItem(pathname, "/admin/users") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/admin/users") ? "page" : undefined}
                >
                  <Users size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Pengguna</span>
                </Link>
                <Link
                  href="/admin/fundraising"
                  className={`workspace-nav-item ${navItem(pathname, "/admin/fundraising") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/admin/fundraising") ? "page" : undefined}
                >
                  <ArrowLeftRight size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Escrow &amp; transfer</span>
                </Link>
                <Link
                  href="/admin/campaigns"
                  className={`workspace-nav-item ${navItem(pathname, "/admin/campaigns") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/admin/campaigns") ? "page" : undefined}
                >
                  <Globe2 size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Publikasi audit</span>
                </Link>
                <Link
                  href="/admin/proofs"
                  className={`workspace-nav-item ${navItem(pathname, "/admin/proofs") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/admin/proofs") ? "page" : undefined}
                >
                  <Anchor size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Proof on-chain</span>
                </Link>
                <div className="nav-divider" />
              </>
            )}

            {/* Non-Verifier Main Nav (BENEFICIARY has no campaign-read access yet) */}
            {!isVerifier && !isBeneficiary && (
              <>
                <div className="nav-section-label">Program Utama</div>
                <Link
                  href={homeHref}
                  className={`workspace-nav-item ${navItem(pathname, homeHref) ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, homeHref) ? "page" : undefined}
                >
                  <LayoutDashboard size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{labels.dashboard}</span>
                </Link>

                <Link
                  href="/campaigns"
                  className={`workspace-nav-item ${navItem(pathname, "/campaigns") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/campaigns") ? "page" : undefined}
                >
                  <FolderKanban size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{labels.campaigns}</span>
                </Link>

                <Link
                  href="/milestones"
                  className={`workspace-nav-item ${navItem(pathname, "/milestones") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/milestones") ? "page" : undefined}
                >
                  <ListChecks size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{labels.milestones}</span>
                </Link>

                {/* Evidence link for Organizers and Admins */}
                {!isFunder && (
                  <Link
                    href="/evidence"
                    className={`workspace-nav-item ${navItem(pathname, "/evidence") ? "workspace-nav-item--active" : ""}`}
                    aria-current={navItem(pathname, "/evidence") ? "page" : undefined}
                  >
                    <FileCheck size={18} className="nav-icon" aria-hidden="true" />
                    <span className="nav-label">Evidence</span>
                    {badgeCount?.evidence ? (
                      <span className="nav-counter-lime">{badgeCount.evidence}</span>
                    ) : null}
                  </Link>
                )}

                <div className="nav-divider" />
                <div className="nav-section-label">{isFunder ? "Pendanaan & Audit" : "Audit & Keuangan"}</div>

                {isFunder && (
                  <Link
                    href="/fundraising/donations"
                    className={`workspace-nav-item ${navItem(pathname, "/fundraising/donations") ? "workspace-nav-item--active" : ""}`}
                    aria-current={navItem(pathname, "/fundraising/donations") ? "page" : undefined}
                  >
                    <Banknote size={18} className="nav-icon" aria-hidden="true" />
                    <span className="nav-label">Riwayat donasi</span>
                  </Link>
                )}
                <Link
                  href="/payment-reports"
                  className={`workspace-nav-item ${navItem(pathname, "/payment-reports") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/payment-reports") ? "page" : undefined}
                >
                  <Banknote size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{labels.paymentReports}</span>
                </Link>

                <Link
                  href="/reports"
                  className={`workspace-nav-item ${navItem(pathname, "/reports") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/reports") ? "page" : undefined}
                >
                  <ScrollText size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{labels.auditTrail}</span>
                </Link>

                <Link
                  href="/organization"
                  className={`workspace-nav-item ${navItem(pathname, "/organization") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/organization") ? "page" : undefined}
                >
                  <Building2 size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">{labels.organizations}</span>
                </Link>
              </>
            )}

            {/* Verifier Role Nav */}
            {isVerifier && (
              <>
                <div className="nav-section-label">Verifikasi Peer</div>
                <Link
                  href="/verifier/reviews"
                  className={`workspace-nav-item ${navItem(pathname, "/verifier/reviews") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/verifier/reviews") ? "page" : undefined}
                >
                  <BadgeCheck size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Review saya</span>
                </Link>

                <div className="nav-divider" />
                <div className="nav-section-label">Audit & Riwayat</div>
                <Link
                  href="/reports"
                  className={`workspace-nav-item ${navItem(pathname, "/reports") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/reports") ? "page" : undefined}
                >
                  <ScrollText size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Audit Trail</span>
                </Link>
              </>
            )}

            {/* Beneficiary Role Nav — confirmation features are post-MVP */}
            {isBeneficiary && (
              <>
                <div className="nav-section-label">Portal Penerima</div>
                <Link
                  href="/beneficiary"
                  className={`workspace-nav-item ${navItem(pathname, "/beneficiary") ? "workspace-nav-item--active" : ""}`}
                  aria-current={navItem(pathname, "/beneficiary") ? "page" : undefined}
                >
                  <BadgeCheck size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Status penerima</span>
                </Link>
                <Link href="/" className="workspace-nav-item">
                  <Globe2 size={18} className="nav-icon" aria-hidden="true" />
                  <span className="nav-label">Audit publik</span>
                </Link>
              </>
            )}
          </nav>

          {/* Sidebar Bottom Footer (Section 5) */}
          <div className="workspace-sidebar-footer">
            <div className="workspace-identity">
              <strong title={user.name}>{user.name}</strong>
              <span title={user.email}>{user.email}</span>
            </div>
            <button
              className="action-button action-button--secondary dt-logout-button"
              type="button"
              onClick={() => void logout()}
              disabled={loggingOut}
              aria-busy={loggingOut}
            >
              <LogOut size={16} aria-hidden="true" />
              <span>{loggingOut ? "Keluar…" : "Keluar"}</span>
            </button>
          </div>
        </aside>

        {/* Main Content Workspace Area */}
        <div className="workspace-content-shell">
          {/* Top Navigation Header (DesignUI.md - Section 7) */}
          <header className="workspace-top-header" aria-label="Identitas pengguna">
            <div className="top-header-user">
              <div className="top-user-avatar" aria-hidden="true">
                <UserRound size={20} />
              </div>
              <div className="top-user-meta">
                <span className="top-user-org">{orgName}</span>
                <span className="top-user-role">
                  {isOrganizer
                    ? "Organizer / Penyelenggara Program"
                    : isFunder
                    ? "CSR Manager / Donor Mitra"
                    : isVerifier
                    ? "Independent Peer Verifier"
                    : isBeneficiary
                    ? "Penerima Manfaat"
                    : "Administrator Sistem"}
                </span>
              </div>
            </div>

            <div className="top-header-right">
              <WorkspaceSearch user={user} />
              <WorkspaceAlerts user={user} />
              {(isFunder || isOrganizer) && <FunderWalletButton />}
            </div>
          </header>

          {/* Main Content Container */}
          <main id="main" className="workspace-main" tabIndex={-1}>
            <section className="workspace-subheader">
              <div className="subheader-title-row">
                <div className="subheader-text">
                  <div className="subheader-eyebrow-row">
                    <span className="dt-module-tag">REAL-TIME CSR ACCOUNTABILITY MODULE v2.0</span>
                    <span className="dt-role-eyebrow">
                      {isAdminUser
                        ? "OPERASI SISTEM & AUDIT"
                        : isVerifier
                        ? "PORTAL VERIFIKASI PEER"
                        : isFunder
                        ? "PORTAL CSR & DONATUR"
                        : isBeneficiary
                        ? "PORTAL PENERIMA MANFAAT"
                        : "RUANG PROGRAM ORGANIZER"}
                    </span>
                  </div>
                  <h1 className="workspace-title">{title}</h1>
                  <p className="subheader-desc">
                    {subtitle || "Pantau akuntabilitas dana dan kemajuan verifikasi program."}
                  </p>
                </div>

                <div className="subheader-actions">
                  {actions}

                  {isOrganizer && pathname !== "/campaigns/new" && !actions && (
                    <Link className="action-button action-button--primary" href="/campaigns/new">
                      + Buat campaign
                    </Link>
                  )}
                </div>
              </div>

              {/* Dashed line matching reference image under title */}
              <div className="subheader-dashed-divider" aria-hidden="true" />
            </section>

            {logoutError && (
              <p className="workspace-error" role="alert">
                {logoutError}
              </p>
            )}

            {children}
          </main>
        </div>
      </div>
    </WorkspaceUserContext.Provider>
  );
}
