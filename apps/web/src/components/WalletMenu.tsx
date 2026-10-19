import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { User } from "../api";
import { shortAddress } from "../format";
import { useInstallApp } from "../installApp";
import { SETTINGS_INSTALL_ID } from "./InstallApp";
import { ChartIcon, ChevronDownIcon, DownloadIcon, LogoutIcon, ShieldIcon, WalletIcon } from "./Icons";

/** Where the menu's first item lands in Settings: the ids SettingsTab puts on those panels. */
export const SETTINGS_WALLET_ID = "settings-wallet";
export const SETTINGS_ACCOUNT_ID = "settings-account";

/**
 * The header's wallet pill (user ask 2026-10-18): a small menu instead of signing out on click.
 * Its first item opens Settings at the Privy wallet card for a Privy account, or at Account and
 * access for a wallet sign-in; the last signs out (Privy) or disconnects (a wallet). Pro Mode
 * wallets also get Portfolio at the top, which left the tab bar for this menu (user ask 2026-10-18).
 * On a phone or tablet without the app installed, "Install the app" sits above sign out: it opens
 * the browser's install dialog, or Settings at the steps where there is none (iPhone, iPad).
 */
export function WalletMenu({
  user,
  onSettings,
  onPortfolio,
  portfolioOpen,
  onSignOut,
}: {
  user: User;
  onSettings: (sectionId: string) => void;
  /** Pro Mode only: opens the Portfolio page. */
  onPortfolio?: () => void;
  /** The Portfolio page is the one open. */
  portfolioOpen?: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const privy = user.signInMethod === "privy";
  const app = useInstallApp();

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        pill.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Up and down move between the items, as in any menu.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="wallet-menu" ref={root}>
      <button
        ref={pill}
        className={open ? "wallet-pill open" : "wallet-pill"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="wallet-dot" />
        {user.isAdmin && <span className="admin-tag">admin</span>}
        <span className="num">{shortAddress(user.walletAddress)}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="wallet-menu-list" role="menu" id={menuId} onKeyDown={onMenuKey}>
          {onPortfolio && (
            <button
              ref={first}
              role="menuitem"
              className={portfolioOpen ? "current" : undefined}
              aria-current={portfolioOpen ? "page" : undefined}
              onClick={() => {
                setOpen(false);
                onPortfolio();
              }}
            >
              <ChartIcon size={15} />
              <span>
                <strong>Portfolio</strong>
                <small>Positions, trades and alerts</small>
              </span>
            </button>
          )}
          <button
            ref={onPortfolio ? undefined : first}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSettings(privy ? SETTINGS_WALLET_ID : SETTINGS_ACCOUNT_ID);
            }}
          >
            {privy ? <WalletIcon size={15} /> : <ShieldIcon size={15} />}
            <span>
              <strong>{privy ? "Wallet" : "Account and access"}</strong>
              <small>{privy ? "Address, funding and key export" : "Access level and time left"}</small>
            </span>
          </button>
          {app.show && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void (async () => {
                  if (!app.canPrompt || !(await app.install())) onSettings(SETTINGS_INSTALL_ID);
                })();
              }}
            >
              <DownloadIcon size={15} />
              <span>
                <strong>Install the app</strong>
                <small>Add TrenchScanner to your home screen</small>
              </span>
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <LogoutIcon size={15} />
            <span>
              <strong>{privy ? "Log out" : "Disconnect"}</strong>
              <small>{privy ? "Sign out of this browser" : "Disconnect this wallet"}</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
