import { useEffect, useRef, useState } from "react";
import type { Card, CardField, FeedAppearance } from "../api";
import { shortAddress } from "../format";
import { parseSearch, searchParam } from "../caSearch";
import { useLiveMarketCaps, usePolling } from "../hooks";
import { feedGridProps } from "../appearance";
import { AlertCard } from "./AlertCard";
import { SkeletonCards } from "./Skeleton";
import { CloseIcon, SearchIcon } from "./Icons";

/** How long typing rests before a ticker or name is searched: one request per word, not per letter. */
const SEARCH_TYPING_MS = 250;

/** Whether a key press landed somewhere that types text, so "/" there is a character, not a shortcut. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/**
 * The feed's search, by contract address, ticker or name: a small pill with the feed's other controls that widens
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
  const parsed = parseSearch(value);
  const shown = focused || parsed.kind !== "mint" ? value : shortAddress(parsed.mint);
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
      className={`ca-search${value ? " filled" : ""}${focused ? " focused" : ""}${parsed.kind === "mint" ? " address" : ""}`}
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
        placeholder="Ticker, name or CA"
        aria-label="Search by contract address, ticker or name"
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

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The line over the cards while a search is on: what it found, and the way out. */
function SearchNote({
  found,
  more,
  page,
  subject,
  noun,
  where,
  onClear,
}: {
  found: number | null;
  more: boolean;
  page: number;
  subject: React.ReactNode;
  /** What the feed holds: "alert", "token". */
  noun: string;
  /** Where the search looked, after "in": "your feed", "the Stream". */
  where: string;
  onClear: () => void;
}) {
  return (
    <p className="ca-search-note muted small" aria-live="polite">
      <SearchIcon size={13} />
      <span>
        {found === null ? (
          <>Searching {where}&hellip;</>
        ) : found === 0 ? (
          <>
            Nothing {page > 1 ? "older " : ""}for {subject} in {where}.
          </>
        ) : (
          <>
            {more || page > 1
              ? `Page ${page} of the ${noun}s`
              : found === 1
                ? `1 ${noun}`
                : `${found} ${noun}s`}{" "}
            for {subject} in {where}.
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
 * The cards a search finds, read from the API across the whole feed (`pathFor` adds the search
 * to a page of the feed's own path), a page at a time, polled like the feed and with "Now" kept
 * seconds old by the live tick. Typed text is searched once typing rests.
 */
export function SearchResults<T>({
  input,
  pathFor,
  pollMs,
  pollKey,
  cardsOf,
  hasMoreOf,
  noun,
  where,
  onClear,
  now,
  hide,
  look,
  labelSource,
}: {
  /** The search box's text. */
  input: string;
  /** The API path for page `page` of the feed, with `search` ("mint=…" or "q=…") added. */
  pathFor: (search: string, page: number) => string;
  pollMs: number;
  pollKey?: string;
  cardsOf: (data: T) => Card[];
  hasMoreOf: (data: T) => boolean;
  /** What the feed holds: "alert", "token". */
  noun: string;
  where: string;
  onClear: () => void;
  now: number;
  hide: ReadonlySet<CardField>;
  look: FeedAppearance;
  labelSource?: boolean;
}) {
  const typed = parseSearch(input);
  // A pasted address goes at once; typed text waits for a pause.
  const settled = parseSearch(useSettled(input, SEARCH_TYPING_MS));
  const query = typed.kind === "mint" ? typed : settled;
  const search = searchParam(query);
  const [page, setPage] = useState(1);
  // A new search starts on its first page.
  useEffect(() => setPage(1), [search]);
  const result = usePolling<T>(pathFor(search, page), pollMs, pollKey);
  // Only a current answer counts: the last search's cards don't stand in for this one's.
  const current = result.data && !result.stale && search !== "" ? result.data : null;
  const data = current ? cardsOf(current) : undefined;
  const more = current ? hasMoreOf(current) : false;
  const cards = useLiveMarketCaps(data);
  const subject =
    query.kind === "mint" ? (
      <span className="num">{shortAddress(query.mint)}</span>
    ) : (
      <>&ldquo;{query.kind === "text" ? query.text : ""}&rdquo;</>
    );
  return (
    <>
      <SearchNote
        found={cards?.length ?? null}
        more={more}
        page={page}
        subject={subject}
        noun={noun}
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
      {(page > 1 || more) && (
        <nav className="pager">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Newer
          </button>
          <span className="muted small num">Page {page}</span>
          <button disabled={!more || !current} onClick={() => setPage((p) => p + 1)}>
            Older →
          </button>
        </nav>
      )}
    </>
  );
}
