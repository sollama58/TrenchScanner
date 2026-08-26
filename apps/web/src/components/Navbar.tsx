import { useAuth } from "../context/AuthContext";
import { HealthBadge } from "./HealthBadge";

export type Tab = "dashboard" | "filters" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Live Feed" },
  { id: "filters", label: "Filters" },
  { id: "settings", label: "Settings" },
];

export function Navbar({ tab, onTabChange }: { tab: Tab; onTabChange: (tab: Tab) => void }) {
  const { user, signOut } = useAuth();

  return (
    <header className="navbar">
      <div className="navbar__brand">
        <span className="navbar__logo">🎯</span> TrenchScanner
      </div>
      <nav className="navbar__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`navbar__tab ${tab === t.id ? "navbar__tab--active" : ""}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="navbar__account">
        <HealthBadge />
        <span className="navbar__wallet">{user ? shortWallet(user.walletAddress) : ""}</span>
        <button className="btn btn--ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function shortWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
