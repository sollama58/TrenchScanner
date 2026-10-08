import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  del,
  patch,
  post,
  TELEGRAM_ALERT_PARTS,
  type TelegramAlertPart,
  type TelegramChat,
  type TelegramLinkCode,
  type TelegramState,
} from "../api";
import { ago } from "../format";
import { CheckIcon, CopyIcon, ExternalIcon, SendIcon, TrashIcon, UsersIcon } from "./Icons";

/**
 * Filters tab card: get every Live Feed alert as a Telegram message, in a private chat with the
 * bot or in a group.
 *
 * Linking works like pairing a phone (ConnectPhonePanel): the dashboard mints a one-time code,
 * the t.me link carries it to Telegram, and the bot redeems it the moment it arrives in a chat.
 * The link is only ever good once and for a few minutes, so there is nothing long-lived to leak;
 * in a group the bot also insists the person sending it is a group admin. Every chat here can
 * be paused, pointed at only matches or only model calls, tested, or unlinked.
 */

/** How often the card asks whether the code on screen has been used, while one is up. */
const LINKED_POLL_MS = 3_000;

type Code =
  | { state: "idle" }
  | { state: "minting"; target: "private" | "group" }
  | { state: "showing"; target: "private" | "group"; url: string; codeId: string; deadline: number }
  | { state: "expired" }
  /** `chat` is null for a chat that was already listed: it was linked again under the same id. */
  | { state: "linked"; chat: TelegramChat | null };

export function TelegramPanel() {
  const [tg, setTg] = useState<TelegramState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState<Code>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Chat ids known before the code went up, so a new one means this code was just used.
  const before = useRef<Set<string> | null>(null);

  const load = useCallback(async (): Promise<TelegramState | null> => {
    try {
      const next = await api<TelegramState>("/telegram");
      setTg(next);
      setLoadError(null);
      return next;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = async (target: "private" | "group") => {
    setError(null);
    setNote(null);
    setCopied(false);
    setCode({ state: "minting", target });
    try {
      const known = (await load())?.chats ?? tg?.chats ?? [];
      before.current = new Set(known.map((c) => c.id));
      const issued = await post<TelegramLinkCode>("/telegram/link/code");
      // The deadline from the TTL on this clock: a skewed clock would misread the absolute expiresAt.
      const ttl = Number.isFinite(issued.ttlMs) && issued.ttlMs > 0 ? issued.ttlMs : 600_000;
      setCode({
        state: "showing",
        target,
        url: target === "group" ? issued.groupUrl : issued.privateUrl,
        codeId: issued.codeId,
        deadline: Date.now() + ttl,
      });
    } catch (e) {
      setCode({ state: "idle" });
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // While a code is up: count it down, and notice when a chat has used it.
  const showing = code.state === "showing" ? code : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!showing) return;
    const tick = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= showing.deadline) setCode({ state: "expired" });
    }, 1_000);
    const watch = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load().then(async (next) => {
        const fresh = next?.chats.find((c) => !before.current?.has(c.id));
        if (fresh) return setCode({ state: "linked", chat: fresh });
        // A chat already listed (paused, or a group linked again) keeps its id: ask about the code.
        const status = await api<{ claimed: boolean }>(
          `/telegram/link/code/${encodeURIComponent(showing.codeId)}`,
        ).catch(() => null);
        if (!status?.claimed) return;
        const after = await load();
        setCode({ state: "linked", chat: after?.chats.find((c) => !before.current?.has(c.id)) ?? null });
      });
    }, LINKED_POLL_MS);
    setNow(Date.now());
    return () => {
      window.clearInterval(tick);
      window.clearInterval(watch);
    };
  }, [showing, load]);

  const copy = async () => {
    if (!showing) return;
    try {
      await navigator.clipboard.writeText(showing.url);
      setCopied(true);
    } catch {
      setError("Couldn't copy: this browser blocked the clipboard.");
    }
  };

  const run = async (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await action();
      if (done) setNote(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const change = (
    chat: TelegramChat,
    body: Partial<Pick<TelegramChat, "filterMatches" | "modelCalls" | "enabled" | "hidden">>,
  ) => run(chat.id, () => patch(`/telegram/chats/${encodeURIComponent(chat.id)}`, body));

  const togglePart = (chat: TelegramChat, part: TelegramAlertPart) => {
    const hidden = chat.hidden.includes(part)
      ? chat.hidden.filter((p) => p !== part)
      : [...chat.hidden, part];
    return change(chat, { hidden });
  };

  const unlink = (chat: TelegramChat) => {
    if (!window.confirm(`Unlink “${chatName(chat)}”? It gets no more alerts until it's linked again.`))
      return;
    void run(chat.id, () => del(`/telegram/chats/${encodeURIComponent(chat.id)}`), "Unlinked.");
  };

  const test = (chat: TelegramChat) =>
    run(
      `${chat.id}:test`,
      () => post(`/telegram/chats/${encodeURIComponent(chat.id)}/test`),
      `Sent a test alert to “${chatName(chat)}”.`,
    );

  const secsLeft = showing ? Math.max(0, Math.ceil((showing.deadline - now) / 1000)) : 0;
  const chats = tg?.chats ?? [];
  const off = tg !== null && !tg.configured;
  const noBot = tg !== null && tg.configured && tg.botUsername === null;

  return (
    <section className="panel telegram">
      <header className="section-head">
        <div>
          <span className="eyebrow">
            <SendIcon size={13} /> Telegram
          </span>
          <h2>Telegram alerts</h2>
          <p className="muted small">
            Each new alert in your feed as a message: your filter&apos;s matches and the calls of the models
            you follow, with the market cap, the reasons and the mint. Works in a private chat and in groups.
          </p>
        </div>
      </header>

      {loadError && !tg ? (
        <p className="error small">Couldn&apos;t load your Telegram chats: {loadError}</p>
      ) : !tg ? (
        <p className="muted small">Loading…</p>
      ) : off ? (
        <p className="notice small">
          Telegram alerts aren&apos;t switched on for this server yet. The admin sets the bot token in the
          server environment and this card comes alive.
        </p>
      ) : (
        <>
          <div className="tg-link">
            {code.state === "linked" ? (
              <p className="cp-status good" role="status">
                <CheckIcon size={15} /> Linked
                {code.chat ? ` ${chatName(code.chat)}${code.chat.kind === "private" ? "" : " (group)"}` : ""}.
                Alerts start with the next one raised.
              </p>
            ) : (
              <ol className="muted small">
                <li>Press a button: it makes a one-time link{noBot ? "" : ` to @${tg.botUsername}`}.</li>
                <li>Open the link. Telegram opens the chat, or asks which group to add the bot to.</li>
                <li>Press Start (in a group, you need to be an admin). The chat shows up below.</li>
                <li>
                  Pick what each alert includes with the chips, or in the chat with <code>/show</code> and{" "}
                  <code>/hide</code>.
                </li>
              </ol>
            )}
            {showing && (
              <div className="tg-code">
                <a className="button primary" href={showing.url} target="_blank" rel="noreferrer">
                  <ExternalIcon size={14} /> Open Telegram
                </a>
                <button className="button ghost" onClick={copy} title="Copy the link">
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                  {copied ? "Copied" : "Copy link"}
                </button>
                <span
                  className={`cp-status num${secsLeft <= 30 ? " urgent" : ""}`}
                  role="timer"
                  aria-live="off"
                >
                  Expires in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")} · works once
                </span>
              </div>
            )}
            {code.state === "expired" && <p className="cp-status">That link expired. Make a new one.</p>}
            {noBot && (
              <p className="error small">Telegram isn&apos;t answering right now; try again in a moment.</p>
            )}
            <div className="cp-actions">
              <button
                className="button"
                onClick={() => void mint("private")}
                disabled={code.state === "minting" || noBot}
              >
                {code.state === "minting" && code.target === "private" ? "Making a link…" : "Link my chat"}
              </button>
              <button
                className="button"
                onClick={() => void mint("group")}
                disabled={code.state === "minting" || noBot}
              >
                <UsersIcon size={14} />
                {code.state === "minting" && code.target === "group" ? "Making a link…" : "Link a group"}
              </button>
            </div>
            <p className="faint small">
              Whoever opens a link first gets your alerts, so only share it with your own group. Real-time
              alerts need an active subscription.
            </p>
          </div>

          <div className="tg-chats">
            <h3>Linked chats{chats.length > 0 ? ` (${chats.length})` : ""}</h3>
            {chats.length === 0 ? (
              <p className="muted small">None yet.</p>
            ) : (
              <ul className="tg-chat-list">
                {chats.map((c) => (
                  <li key={c.id} className={`tg-chat${c.enabled ? "" : " paused"}`}>
                    <div className="tg-chat-head">
                      <span className="tg-chat-icon" aria-hidden>
                        {c.kind === "private" ? <SendIcon size={15} /> : <UsersIcon size={15} />}
                      </span>
                      <div className="tg-chat-body">
                        <span className="tg-chat-name">
                          {chatName(c)}
                          <span className="pill">{c.kind === "private" ? "private chat" : "group"}</span>
                          {!c.enabled && <span className="badge info">paused</span>}
                        </span>
                        <span className="faint small">
                          Linked {ago(c.createdAt)}
                          {c.linkedByName ? ` by ${c.linkedByName}` : ""}
                          {c.lastSentAt ? ` · last alert ${ago(c.lastSentAt)}` : " · nothing sent yet"}
                        </span>
                        {c.lastError && <span className="error small">Telegram said: {c.lastError}</span>}
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.enabled}
                        className={`switch${c.enabled ? " on" : ""}`}
                        disabled={busy !== null}
                        onClick={() => void change(c, { enabled: !c.enabled })}
                        title={c.enabled ? "Pause alerts to this chat" : "Resume alerts to this chat"}
                      >
                        <span className="switch-track">
                          <span className="switch-thumb" />
                        </span>
                        {c.enabled ? "On" : "Paused"}
                      </button>
                    </div>
                    <div className="tg-chat-controls">
                      <label className="check small">
                        <input
                          type="checkbox"
                          checked={c.filterMatches}
                          disabled={busy !== null}
                          onChange={() => void change(c, { filterMatches: !c.filterMatches })}
                        />
                        Tokens my filter catches
                      </label>
                      <label className="check small">
                        <input
                          type="checkbox"
                          checked={c.modelCalls}
                          disabled={busy !== null}
                          onChange={() => void change(c, { modelCalls: !c.modelCalls })}
                        />
                        Calls from the models in my feed
                      </label>
                    </div>
                    <div className="tg-chat-parts">
                      <span className="faint small">Each alert includes</span>
                      {TELEGRAM_ALERT_PARTS.map((p) => {
                        const on = !c.hidden.includes(p.key);
                        return (
                          <button
                            key={p.key}
                            type="button"
                            className={`chip${on ? " on" : ""}`}
                            aria-pressed={on}
                            disabled={busy !== null}
                            onClick={() => void togglePart(c, p.key)}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                      <span className="tg-chat-buttons">
                        <button
                          className="button ghost small-btn"
                          disabled={busy !== null}
                          onClick={() => void test(c)}
                        >
                          {busy === `${c.id}:test` ? "Sending…" : "Send a test"}
                        </button>
                        <button
                          className="button ghost danger small-btn"
                          disabled={busy !== null}
                          onClick={() => unlink(c)}
                        >
                          <TrashIcon size={13} /> Unlink
                        </button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {note && (
        <p className="notice small" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function chatName(c: TelegramChat): string {
  return c.title ?? (c.kind === "private" ? "Private chat" : "Group");
}
