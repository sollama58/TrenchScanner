import { useEffect, useId, useRef, useState, type Ref } from "react";
import { tokenImageSources, usd } from "../format";
import { asylApi, avatarUrl, type SearchRead } from "./asylApi";
import { addressIn, shortAddr } from "./graph";

/**
 * The top bar's search (user ask 2026-10-25): a pasted address or link still maps at once, and as
 * the reader types a name, ticker, handle or the start of an address, coins TrenchScanner tracks,
 * roster KOLs and their own labels drop down under it, best match first. Arrow keys and Enter pick.
 */

type Pick = { kind: "wallet" | "token"; address: string };
type Row = Pick & { key: string };

/** Asked a little after the last key, so a fast typist sends one search, not one per letter. */
const DEBOUNCE_MS = 180;

function Picture({ src, label, round }: { src: string[]; label: string; round: boolean }) {
  const [n, setN] = useState(0);
  const url = src[n];
  return url ? (
    <img
      className={`asyl-sr-pic${round ? " round" : ""}`}
      src={url}
      alt=""
      loading="lazy"
      onError={() => setN((i) => i + 1)}
    />
  ) : (
    <span className={`asyl-sr-pic none${round ? " round" : ""}`}>{label.slice(0, 2).toUpperCase()}</span>
  );
}

export function SearchBox({
  query,
  onQuery,
  busy,
  adding,
  inputRef,
  onSubmit,
  onPick,
}: {
  query: string;
  onQuery: (q: string) => void;
  busy: boolean;
  /** A map is open: what is picked joins it. */
  adding: boolean;
  inputRef: Ref<HTMLInputElement>;
  /** Text that isn't a picked row: an address, a link, or a name to look up. */
  onSubmit: (text: string) => void;
  onPick: (p: Pick) => void;
}) {
  const [read, setRead] = useState<SearchRead | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLFormElement>(null);
  const listId = useId();
  const pasted = addressIn(query);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2 || pasted) {
      setRead(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      asylApi
        .search(q)
        .then((r) => live && (setRead(r), setHi(0)))
        .catch(() => live && setRead({ q, tokens: [], wallets: [] }))
        .finally(() => live && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, pasted]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  const rows: Row[] = [
    ...(pasted ? [{ kind: "wallet" as const, address: pasted, key: "paste" }] : []),
    ...(read?.tokens ?? []).map((t) => ({ kind: "token" as const, address: t.mint, key: `t${t.mint}` })),
    ...(read?.wallets ?? []).map((w) => ({
      kind: "wallet" as const,
      address: w.wallet,
      key: `w${w.wallet}`,
    })),
  ];
  const shown = open && q.length >= 2 && (rows.length > 0 || loading || !!read);

  const pick = (r: Row) => {
    setOpen(false);
    if (r.key === "paste") onSubmit(r.address);
    else onPick({ kind: r.kind, address: r.address });
  };

  const verb = adding ? "Add" : "Map";
  let i = -1;
  const rowProps = (r: Row) => {
    i += 1;
    const me = i;
    return {
      id: `${listId}-${me}`,
      role: "option",
      "aria-selected": hi === me,
      className: `asyl-sr-row${hi === me ? " hi" : ""}`,
      onPointerEnter: () => setHi(me),
      onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
      onClick: () => pick(r),
    } as const;
  };

  return (
    <form
      ref={box}
      className={`asyl-search${shown ? " open" : ""}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const r = rows[hi];
        if (shown && r) return pick(r);
        // A name typed and sent before its results came back: ask now, and map the best match.
        if (!pasted && q.length >= 2) {
          setLoading(true);
          setOpen(false);
          asylApi
            .search(q)
            .then((got) => {
              const t = got.tokens[0];
              const w = got.wallets[0];
              if (t) onPick({ kind: "token", address: t.mint });
              else if (w) onPick({ kind: "wallet", address: w.wallet });
              else onSubmit(query);
            })
            .catch(() => onSubmit(query))
            .finally(() => setLoading(false));
          return;
        }
        onSubmit(query);
      }}
    >
      <div className="asyl-search-field">
        <span className="asyl-search-icon" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className="asyl-input"
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (addressIn(text)) {
              e.preventDefault();
              setOpen(false);
              onSubmit(text);
            }
          }}
          onKeyDown={(e) => {
            if (!shown) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => Math.min(rows.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={
            adding
              ? "Add to this map: name, ticker, KOL or address"
              : "Search a coin, KOL or wallet, or paste an address"
          }
          aria-label="Search coins, KOLs and wallets, or paste an address"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown && rows[hi] ? `${listId}-${hi}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            className="asyl-search-clear"
            aria-label="Clear"
            onClick={() => {
              onQuery("");
              setRead(null);
            }}
          >
            ×
          </button>
        )}
      </div>
      <button
        className="asyl-btn primary"
        disabled={busy}
        title={adding ? "Adds it to the map you have open; New starts another" : undefined}
      >
        {adding ? "＋ Add to map" : "Map it"}
      </button>

      {shown && (
        <div className="asyl-sr" id={listId} role="listbox" aria-label="Search results">
          {pasted && (
            <div {...rowProps(rows[0]!)}>
              <span className="asyl-sr-pic none round">⌖</span>
              <span className="asyl-sr-main">
                <b>{verb} this address</b>
                <small>{shortAddr(pasted)}</small>
              </span>
              <span className="asyl-sr-go">↵</span>
            </div>
          )}
          {read && read.tokens.length > 0 && (
            <>
              <p className="asyl-sr-head">Coins</p>
              {read.tokens.map((t) => (
                <div key={t.mint} {...rowProps({ kind: "token", address: t.mint, key: `t${t.mint}` })}>
                  <Picture
                    src={tokenImageSources(t.image, 64, t.mint)}
                    label={t.symbol ?? t.name ?? "?"}
                    round={false}
                  />
                  <span className="asyl-sr-main">
                    <b>{t.symbol ? `$${t.symbol}` : (t.name ?? shortAddr(t.mint))}</b>
                    <small>
                      {t.name && t.symbol ? `${t.name} · ` : ""}
                      {shortAddr(t.mint)}
                    </small>
                  </span>
                  {t.mcapUsd !== null && <span className="asyl-sr-meta">{usd(t.mcapUsd)}</span>}
                  <span className="asyl-sr-go">{verb}</span>
                </div>
              ))}
            </>
          )}
          {read && read.wallets.length > 0 && (
            <>
              <p className="asyl-sr-head">Wallets</p>
              {read.wallets.map((w) => (
                <div key={w.wallet} {...rowProps({ kind: "wallet", address: w.wallet, key: `w${w.wallet}` })}>
                  <Picture src={w.avatar ? [avatarUrl(w.avatar)] : []} label={w.name} round />
                  <span className="asyl-sr-main">
                    <b>
                      {w.name}
                      <span className={`asyl-sr-tag ${w.kind}`}>
                        {w.kind === "kol" ? "KOL" : "Your label"}
                      </span>
                    </b>
                    <small>
                      {w.twitter ? `@${w.twitter} · ` : ""}
                      {shortAddr(w.wallet)}
                    </small>
                  </span>
                  {(w.winRate !== null || w.pnlUsd !== null) && (
                    <span className="asyl-sr-meta">
                      {w.pnlUsd !== null && (
                        <span className={w.pnlUsd >= 0 ? "up" : "down"}>{usd(w.pnlUsd)}</span>
                      )}
                      {w.winRate !== null && (
                        <small>{Math.round(w.winRate <= 1 ? w.winRate * 100 : w.winRate)}% win</small>
                      )}
                    </span>
                  )}
                  <span className="asyl-sr-go">{verb}</span>
                </div>
              ))}
            </>
          )}
          {loading && !read && <p className="asyl-sr-empty">Searching…</p>}
          {read && !loading && rows.length === 0 && (
            <p className="asyl-sr-empty">
              Nothing TrenchScanner tracks matches “{read.q}”. Paste a wallet or coin address to map any.
            </p>
          )}
        </div>
      )}
    </form>
  );
}
