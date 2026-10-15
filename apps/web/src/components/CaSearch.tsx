import { useEffect, useRef, useState } from "react";
import type { Card, CardField, FeedAppearance } from "../api";
import { shortAddress } from "../format";
import { parseCaQuery } from "../caSearch";
import { useLiveMarketCaps, usePolling } from "../hooks";
import { feedGridProps } from "../appearance";
import { AlertCard } from "./AlertCard";
import { SkeletonCards } from "./Charts";
import { CloseIcon, SearchIcon } from "./Icons";

/** Whether a key press landed somewhere that types text, so "/" there is a character, not a shortcut. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * The feed's contract-address search: a small pill with the feed's other controls that widens
 * while in use. "/" anywhere on the page jumps into it, Escape clears it.
 */
export function CaSearchBox({
  value,
  onChange,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  /** What the search covers, for the tooltip. */
  title: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // Away from the box an address reads short, so the pill keeps its size among the controls.
  const parsed = parseCaQuery(value);
  const shown = focused || parsed.kind !== "full" ? value : shortAddress(parsed.mint);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      // A dialog over the feed keeps its own keys.
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className={`ca-search${value ? " filled" : ""}${focused ? " focused" : ""}`}
      role="search"
      title={title}
    >
      <SearchIcon size={14} className="ca-search-icon" />
      <input
        ref={input}
        type="text"
        value={shown}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          if (value) onChange("");
          else e.currentTarget.blur();
        }}
        placeholder="Search CA"
        aria-label="Search by contract address"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {value ? (
        <button
          type="button"
          className="ca-search-clear"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          aria-label="Clear the search"
          title="Clear (Esc)"
        >
          <CloseIcon size={12} />
        </button>
      ) : (
        <kbd className="ca-search-key" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  );
}

/** The line over the cards while a search is on: what it found, and the way out. */
export function CaSearchNote({
  found,
  mint,
  partial,
  where,
  onClear,
}: {
  found: number | null;
  /** The whole address searched, or null for part of one. */
  mint: string | null;
  partial: string | null;
  /** Where the search looked, after "in": "your feed", "the Stream". */
  where: string;
  onClear: () => void;
}) {
  const subject = mint ? (
    <span className="num">{shortAddress(mint)}</span>
  ) : (
    <>
      addresses with <span className="num">&ldquo;{partial}&rdquo;</span>
    </>
  );
  return (
    <p className="ca-search-note muted small" aria-live="polite">
      <SearchIcon size={13} />
      <span>
        {found === null ? (
          <>Searching {where}&hellip;</>
        ) : found === 0 ? (
          <>
            Nothing for {subject} in {where}
            {mint ? "." : " so far. Paste the whole address to search further back."}
          </>
        ) : (
          <>
            {found === 1 ? "1 alert" : `${found} alerts`} for {subject}
            {mint ? "" : ` in the ${where === "the Stream" ? "page" : "alerts"} loaded so far`}.
          </>
        )}{" "}
        <button type="button" className="link" onClick={onClear}>
          Clear
        </button>
      </span>
    </p>
  );
}

/**
 * A whole address searched in the API: `path` answers that token's cards alone, polled like the
 * feed and with "Now" kept seconds old by the live tick.
 */
export function CaSearchResults<T>({
  path,
  pollMs,
  pollKey,
  cardsOf,
  mint,
  where,
  onClear,
  now,
  hide,
  look,
  labelSource,
}: {
  path: string;
  pollMs: number;
  pollKey?: string;
  cardsOf: (data: T) => Card[];
  mint: string;
  where: string;
  onClear: () => void;
  now: number;
  hide: ReadonlySet<CardField>;
  look: FeedAppearance;
  labelSource?: boolean;
}) {
  const result = usePolling<T>(path, pollMs, pollKey);
  // Only a current answer counts: the last search's cards don't stand in for this one's.
  const data = result.data && !result.stale ? cardsOf(result.data) : undefined;
  const cards = useLiveMarketCaps(data);
  return (
    <>
      <CaSearchNote
        found={cards?.length ?? null}
        mint={mint}
        partial={null}
        where={where}
        onClear={onClear}
      />
      {result.error && !data && <p className="error">Couldn&apos;t search: {result.error.message}</p>}
      {!data && !result.error && <SkeletonCards count={1} />}
      <div className="cards" {...feedGridProps(look)}>
        {cards?.map((card) => (
          <AlertCard key={card.id} card={card} now={now} labelSource={labelSource} hide={hide} />
        ))}
      </div>
    </>
  );
}
