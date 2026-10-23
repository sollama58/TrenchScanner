import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Filter, Leaderboard } from "../api";
import {
  cardHideSet,
  defaultLook,
  feedGridProps,
  sameAppearance,
  setAppearance,
  useAppearance,
  useAppearanceSave,
  type SaveState,
} from "../appearance";
import { closeCustomize, useCustomize, type CustomizeSection } from "../customize";
import { usePolling } from "../hooks";
import { useHiddenTokens } from "../hiddenTokens";
import {
  DEFAULT_LAYOUT_PREFS,
  setLayoutPrefs,
  setMarketBarOpen,
  TOKEN_SIDE_LABELS,
  TOKEN_SIDE_VIEWS,
  useLayoutPrefs,
  useMarketBarOpen,
} from "../layoutPrefs";
import { useProState } from "../proTrade";
import { columnLabel } from "../scope";
import { useScopeSettings } from "../scopeSettings";
import { scopeSampleCard } from "../scopeSample";
import { tileMode } from "../tileTone";
import { AlertCard } from "./AlertCard";
import {
  BubbleMapControls,
  CardFieldControls,
  CardLayoutControls,
  ChartControls,
  Choice,
  HideAlertsControls,
  PresetPicker,
  QuickLinkChecks,
  ThemeAndColors,
} from "./AppearancePanel";
import { ChartEventsPicker } from "./ChartEventsPicker";
import { HiddenTokensDialog } from "./HiddenTokensDialog";
import {
  BellIcon,
  BoltIcon,
  BubblesIcon,
  ChartIcon,
  ChevronLeftIcon,
  CloseIcon,
  EyeOffIcon,
  FunnelIcon,
  GearIcon,
  PaletteIcon,
  RadarIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  StarIcon,
} from "./Icons";
import { ScopeColumnsPanel } from "./ScopeColumnsPanel";
import { ColumnFilters, DisplaySettings, Switch } from "./ScopeSettingsPanels";
import { setTermLayout, useTermLayout } from "./TermSplit";
import { TradingSettingsPanel } from "./TradingSettingsPanel";
import { WalletMarksPicker } from "./WalletMarksPicker";
import { WatchlistManager } from "./WatchlistManager";

/**
 * Customize (user ask 2026-10-23): every option that shapes the dashboard in one window, in
 * sections down the side, in place of the Live feed's drawer, Scope's settings window, the Pro
 * token window's own Customize and Settings' tab and token-view panels. Each Customize button on
 * the page opens it at its own section (customize.ts).
 *
 * Almost everything is saved to the signed-in account and follows it to every device: the look
 * (appearance.ts), Scope (scopeSettings.ts), and the trade defaults and layout (syncedPrefs.ts).
 * Pixel sizes and whether the market bar starts open are this device's, and say so. A guest gets
 * the sections that shape what a guest sees, kept on this device.
 */

interface SectionDef {
  id: CustomizeSection;
  group: string;
  title: string;
  icon: ReactNode;
  /** One line under the title, and what the search matches besides the title. */
  blurb: string;
  keywords: string;
  /** Shown to a guest (whose choices stay on this device). */
  guest?: boolean;
  /** The example card stays in view above it. */
  preview?: boolean;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: "look",
    group: "Look",
    title: "Theme and colors",
    icon: <PaletteIcon size={15} />,
    blurb:
      "Dark or light, and the colors of wins, losses, model alerts and your filter. Cards and Scope share them.",
    keywords: "theme dark light colour color accent outline tiles presets win loss",
    guest: true,
    preview: true,
  },
  {
    id: "cards",
    group: "Live feed",
    title: "Cards",
    icon: <SlidersIcon size={15} />,
    blurb: "Presets, spacing, columns, text size and the market cap line that hides fallen alerts.",
    keywords: "layout spacing density columns width text size corners image avatar hide market cap preset",
    guest: true,
    preview: true,
  },
  {
    id: "card-fields",
    group: "Live feed",
    title: "Card pills and tiles",
    icon: <StarIcon size={15} />,
    blurb: "What every alert card shows: its pills, stat tiles, links and extras.",
    keywords:
      "fields pills tiles holders top10 snipers block zero fees socials volume score narrative search",
    guest: true,
    preview: true,
  },
  {
    id: "scope",
    group: "Live feed",
    title: "Scope rows",
    icon: <RadarIcon size={15} />,
    blurb: "How Scope's dense board looks: row layout, what each row shows and its data chips.",
    keywords: "scope rows chips list cards density hold still",
  },
  {
    id: "scope-columns",
    group: "Live feed",
    title: "Scope columns",
    icon: <FunnelIcon size={15} />,
    blurb: "Up to six columns, left to right, and the filters on each one.",
    keywords: "scope columns filters graduated new models board",
  },
  {
    id: "token",
    group: "Token window",
    title: "Token window",
    icon: <ShieldIcon size={15} />,
    blurb: "Pro or Classic, what sits beside the chart, its sizes and the header's safety pill.",
    keywords: "pro classic terminal beside chart side column sizes safety pill coin window",
    guest: true,
  },
  {
    id: "chart",
    group: "Token window",
    title: "Chart",
    icon: <ChartIcon size={15} />,
    blurb: "Line or candles, indicators, drawings, labeled wallets' trades and event flags.",
    keywords:
      "chart candles line indicators rsi ema bollinger log fibonacci drawings wallet trades marks events flags",
    guest: true,
  },
  {
    id: "bubbles",
    group: "Token window",
    title: "Bubble map",
    icon: <BubblesIcon size={15} />,
    blurb: "Which ties the bubble maps draw, the names on wallets and how often an open map redraws.",
    keywords: "bubble map links exchange cex funders side wallets transfers names refresh",
    guest: true,
  },
  {
    id: "trading",
    group: "Trading",
    title: "Trading",
    icon: <BoltIcon size={15} />,
    blurb: "Quick-link sites, and with Pro Mode the Trade panel's buttons, fees and quick buy.",
    keywords: "quick links terminal axiom gmgn buy sell presets slippage priority fee tip mev quick buy",
  },
  {
    id: "app",
    group: "App",
    title: "Tabs, top bar and lists",
    icon: <GearIcon size={15} />,
    blurb: "Extra tabs, how the Live feed opens, the market bar, your watchlist and hidden tokens.",
    keywords: "tabs lighthouse top bar market bar watchlist hidden tokens live view alerts sounds",
  },
];

export function CustomizeModal({ guest = false, onAlerts }: { guest?: boolean; onAlerts?: () => void }) {
  const state = useCustomize();
  const ref = useRef<HTMLDialogElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<CustomizeSection>(state.section);
  const [column, setColumn] = useState<string | null>(state.column);
  const shown = useMemo(() => SECTIONS.filter((s) => !guest || s.guest), [guest]);

  // Each opening lands on the section it was opened at (or the first a guest has).
  useEffect(() => {
    if (!state.open) return;
    const wanted = shown.find((s) => s.id === state.section) ?? shown[0]!;
    setSection(wanted.id);
    setColumn(state.column);
    setQuery("");
  }, [state.open, state.seq, state.section, state.column, shown]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (state.open && !dialog.open) {
      dialog.showModal();
      // The open section's tab takes focus, not the search box (which would raise a phone's keyboard).
      dialog.querySelector<HTMLElement>(".cz-nav-item.on")?.focus();
    }
    if (!state.open && dialog.open) dialog.close();
  }, [state.open]);

  // A new section starts at its top, or at the part it was opened for, lit for a moment.
  useEffect(() => {
    if (!state.open) return;
    const pane = paneRef.current;
    if (!pane) return;
    pane.scrollTop = 0;
    if (!state.anchor) return;
    const target = document.getElementById(state.anchor);
    if (!target || !pane.contains(target)) return;
    target.scrollIntoView({ block: "start" });
    target.classList.remove("lit");
    void target.offsetWidth;
    target.classList.add("lit");
    target.focus({ preventScroll: true });
  }, [state.open, state.seq, section, column, state.anchor]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? shown.filter((s) => `${s.title} ${s.group} ${s.blurb} ${s.keywords}`.toLowerCase().includes(q))
    : shown;
  const def = shown.find((s) => s.id === section) ?? shown[0]!;
  const groups = [...new Set(matches.map((s) => s.group))];
  const pick = (id: CustomizeSection) => {
    setSection(id);
    setColumn(null);
  };

  return (
    <dialog
      ref={ref}
      className="about-modal sheet-modal cz-modal"
      aria-labelledby="cz-title"
      onClose={(e) => {
        if (e.target === e.currentTarget) closeCustomize();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCustomize();
      }}
    >
      {state.open && (
        <div className="cz-shell">
          <header className="cz-head">
            <div className="cz-title">
              <h2 id="cz-title">
                <PaletteIcon size={17} /> Customize
              </h2>
              <SyncBadge guest={guest} />
            </div>
            <label className="cz-search">
              <SearchIcon size={14} />
              <span className="sr-only">Find a setting</span>
              <input
                type="search"
                placeholder="Find a setting"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matches[0]) {
                    pick(matches[0].id);
                    setQuery("");
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="ghost icon-btn cz-close"
              onClick={closeCustomize}
              aria-label="Close"
            >
              <CloseIcon size={16} />
            </button>
          </header>
          <div className="cz-main">
            <nav className="cz-nav" aria-label="Customize sections">
              {groups.map((g) => (
                <div key={g} className="cz-nav-group">
                  <span className="cz-nav-label">{g}</span>
                  {matches
                    .filter((s) => s.group === g)
                    .map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`cz-nav-item${s.id === def.id ? " on" : ""}`}
                        aria-current={s.id === def.id ? "page" : undefined}
                        onClick={() => pick(s.id)}
                      >
                        {s.icon}
                        <span>{s.title}</span>
                      </button>
                    ))}
                </div>
              ))}
              {matches.length === 0 && (
                <p className="muted small cz-nav-none">Nothing matches &ldquo;{query}&rdquo;.</p>
              )}
            </nav>
            <div className="cz-pane" ref={paneRef} key={def.id}>
              {def.preview && <CardPreview />}
              <div className="cz-section-head">
                <h3>
                  {def.icon} {def.title}
                </h3>
                <p className="muted small">{def.blurb}</p>
              </div>
              {guest && (
                <p className="notice small cz-guest">
                  You&apos;re looking around as a guest: these stay on this device. Connect a wallet to save
                  them to your account and get every other section.
                </p>
              )}
              <SectionBody
                id={def.id}
                column={column}
                onColumn={setColumn}
                onAlerts={
                  onAlerts
                    ? () => {
                        closeCustomize();
                        onAlerts();
                      }
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Where the changes go: the account (with the save's state), or this device only for a guest. */
function SyncBadge({ guest }: { guest: boolean }) {
  const save = useAppearanceSave();
  if (guest) return <span className="cz-sync local">On this device only</span>;
  const text: Record<SaveState["state"], string> = {
    idle: "Synced to your account",
    saved: "Saved to your account",
    saving: "Saving…",
    local: "Saving once your account loads",
    error: "Couldn't save; kept on this device",
  };
  return (
    <span
      className={`cz-sync ${save.state}`}
      role="status"
      title={
        save.state === "error" ? save.message : "Changes follow your wallet to every device you sign in on"
      }
    >
      {text[save.state]}
    </span>
  );
}

/** A made-up alert card with every reading, drawn as the feed would draw it now. */
function CardPreview() {
  const look = useAppearance();
  const card = useMemo(() => scopeSampleCard(Date.now()), []);
  const hide = useMemo(() => cardHideSet(look), [look]);
  return (
    <div className="cz-preview" aria-label="Preview">
      <span className="scope-preview-label">Preview</span>
      <div className="cards cz-preview-cards" {...feedGridProps(look)} data-cols="1">
        <AlertCard card={card} now={Date.now()} labelSource hide={hide} detail={false} links={false} />
      </div>
    </div>
  );
}

/** One card of settings in a section. */
function Group({
  title,
  hint,
  id,
  aside,
  children,
}: {
  title: string;
  hint?: ReactNode;
  id?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="scope-section cz-group appearance-controls" id={id} tabIndex={id ? -1 : undefined}>
      <div className="cz-group-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </section>
  );
}

function SectionBody({
  id,
  column,
  onColumn,
  onAlerts,
}: {
  id: CustomizeSection;
  column: string | null;
  onColumn: (id: string | null) => void;
  onAlerts?: () => void;
}) {
  switch (id) {
    case "look":
      return <LookSection />;
    case "cards":
      return <CardsSection />;
    case "card-fields":
      return (
        <Group title="On each card" hint="Tap a pill to show or hide it. The preview above changes with it.">
          <CardFieldControls />
        </Group>
      );
    case "scope":
      return <ScopeRowsSection />;
    case "scope-columns":
      return <ScopeColumnsSection column={column} onColumn={onColumn} />;
    case "token":
      return <TokenSection />;
    case "chart":
      return (
        <>
          <Group title="Chart">
            <ChartControls />
            <p className="faint small check-hint">
              Candle size, indicators, log scale and drawings are here and on the chart&apos;s toolbar. A
              drawing&apos;s points stay on this device, for that coin.
            </p>
          </Group>
          <Group title="Labeled wallets' trades">
            <WalletMarksPicker />
          </Group>
          <Group title="Event flags">
            <ChartEventsPicker />
          </Group>
        </>
      );
    case "bubbles":
      return (
        <Group title="Bubble maps">
          <BubbleMapControls />
        </Group>
      );
    case "trading":
      return <TradingSection />;
    case "app":
      return <AppSection onAlerts={onAlerts} />;
  }
}

function ResetButton({
  disabled,
  onClick,
  label = "Reset",
}: {
  disabled?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button type="button" className="ghost small-btn" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

function LookSection() {
  return (
    <Group title="Theme and colors" hint="A is the theme's own color. Scope's rows use these too.">
      <ThemeAndColors />
    </Group>
  );
}

function CardsSection() {
  const look = useAppearance();
  return (
    <>
      <Group
        title="Presets"
        aside={
          <ResetButton
            label="Reset the whole look"
            disabled={sameAppearance(look, defaultLook(look))}
            onClick={() => setAppearance(defaultLook(look))}
          />
        }
      >
        <PresetPicker />
      </Group>
      <Group title="Layout and spacing">
        <CardLayoutControls />
      </Group>
      <Group title="Hide alerts">
        <HideAlertsControls />
      </Group>
    </>
  );
}

function ScopeRowsSection() {
  const settings = useScopeSettings();
  const look = useAppearance();
  return (
    <>
      <DisplaySettings display={settings.display} tiles={tileMode(look)} />
    </>
  );
}

function ScopeColumnsSection({
  column,
  onColumn,
}: {
  column: string | null;
  onColumn: (id: string | null) => void;
}) {
  const settings = useScopeSettings();
  const filters = usePolling<Filter[]>("/filters", 120_000);
  const lb = usePolling<Leaderboard>("/curated/models?days=30", 120_000);
  const names = useMemo(() => {
    const out = new Map<string, string>();
    for (const f of filters.data ?? []) out.set(f.id, f.name);
    for (const e of lb.data?.entries ?? []) out.set(e.id, e.name);
    return out;
  }, [filters.data, lb.data]);
  const col = column ? settings.board.find((c) => c.id === column) : undefined;
  if (col) {
    const label = columnLabel(col, names);
    return (
      <>
        <button type="button" className="link small cz-back" onClick={() => onColumn(null)}>
          <ChevronLeftIcon size={13} /> All columns
        </button>
        <h4 className="cz-sub">{label}: what shows in it</h4>
        <ColumnFilters col={col} label={label} />
      </>
    );
  }
  return (
    <>
      <ScopeColumnsPanel board={settings.board} onFilters={(id) => onColumn(id)} />
    </>
  );
}

function TokenSection() {
  const look = useAppearance();
  const layout = useLayoutPrefs();
  const [sizes] = useTermLayout();
  const sized = sizes.sideW !== null || sizes.chartH !== null;
  return (
    <>
      <Group
        title="Coin window"
        hint="Pro lays the chart, a view beside it and the Trade panel side by side, with the rest in tabs below. Classic is one page you scroll through. Phones and narrow windows always get Classic."
      >
        <Choice
          label="Opens in"
          value={look.tokenView}
          options={[
            ["pro", "Pro"],
            ["classic", "Classic"],
          ]}
          onChange={(tokenView) => setAppearance({ tokenView })}
        />
        <label className="choice-row cz-select">
          <span className="small muted">Beside the chart (Pro)</span>
          <select
            value={layout.tokenSide}
            onChange={(e) =>
              setLayoutPrefs({ tokenSide: e.target.value as (typeof TOKEN_SIDE_VIEWS)[number] })
            }
          >
            {TOKEN_SIDE_VIEWS.map((v) => (
              <option key={v} value={v}>
                {TOKEN_SIDE_LABELS[v]}
              </option>
            ))}
          </select>
        </label>
        <Switch
          label="Safety pill in the header"
          hint="The safety screen's Passed or Failed pill beside Sage. Its Safety section always shows."
          on={!look.hideSafetyPill}
          onChange={() => setAppearance({ hideSafetyPill: !look.hideSafetyPill })}
        />
      </Group>
      <Group
        title="Sizes on this device"
        hint="Drag the column's edge or the chart's foot to resize them. Screens differ, so sizes stay with this device."
      >
        <div className="choice-row">
          <span className="small muted">Column width and chart height</span>
          <ResetButton
            label={sized ? "Reset sizes" : "Default sizes"}
            disabled={!sized}
            onClick={() => setTermLayout({ sideW: null, chartH: null })}
          />
        </div>
      </Group>
      <p className="muted small">The chart and bubble map have their own sections.</p>
    </>
  );
}

function TradingSection() {
  const pro = useProState();
  return (
    <>
      <Group
        title="Quick links"
        hint="Trading sites on each card and Scope row, and where Chaos Mode opens alerts."
      >
        <QuickLinkChecks />
      </Group>
      {pro?.pro ? (
        <section className="scope-section cz-group">
          <TradingSettingsPanel embedded />
        </section>
      ) : (
        <p className="muted small">
          The Trade panel&apos;s buttons, fees and quick buy show here for wallets with Pro Mode.
        </p>
      )}
    </>
  );
}

function AppSection({ onAlerts }: { onAlerts?: () => void }) {
  const look = useAppearance();
  const layout = useLayoutPrefs();
  const barOpen = useMarketBarOpen();
  const hidden = useHiddenTokens();
  const [hiddenOpen, setHiddenOpen] = useState(false);
  return (
    <>
      <Group title="Tabs and the top bar">
        <Switch
          label="Lighthouse tab"
          hint="The Market Lighthouse in full: how screened tokens are doing, and its trends."
          on={!look.hideLighthouseTab}
          onChange={() => setAppearance({ hideLighthouseTab: !look.hideLighthouseTab })}
        />
        <Choice
          label="The Live feed opens on"
          value={layout.liveView}
          options={[
            ["cards", "Cards"],
            ["scope", "Scope"],
          ]}
          onChange={(liveView) => setLayoutPrefs({ liveView })}
        />
        <Switch
          label="Market bar starts open"
          hint="Prices, the trench's mood, your watchlist and positions above the feed. This device only."
          on={barOpen}
          onChange={() => setMarketBarOpen(!barOpen)}
        />
        {layout.liveView !== DEFAULT_LAYOUT_PREFS.liveView && (
          <p className="faint small">Cards or Scope can also be switched above the feed at any time.</p>
        )}
      </Group>
      <Group title="Watchlist" hint="Coins you keep an eye on, in the market bar. Saved to your account.">
        <WatchlistManager compact onOpened={closeCustomize} />
      </Group>
      <Group
        title="Hidden tokens"
        hint="Tokens you hid from Cards and Scope, and whether they come back by themselves."
        aside={
          <button type="button" className="ghost small-btn" onClick={() => setHiddenOpen(true)}>
            <EyeOffIcon size={13} /> Manage <span className="num">{hidden.tokens.length}</span>
          </button>
        }
      >
        <span className="sr-only">{hidden.tokens.length} hidden</span>
      </Group>
      {onAlerts && (
        <Group
          title="Alerts and sounds"
          hint="Sounds, browser notifications and Telegram live beside your filters."
        >
          <div>
            <button type="button" className="ghost small-btn" onClick={onAlerts}>
              <BellIcon size={13} /> Open alert settings
            </button>
          </div>
        </Group>
      )}
      <HiddenTokensDialog open={hiddenOpen} onClose={() => setHiddenOpen(false)} now={Date.now()} />
    </>
  );
}
