import { TelegramApi, type TelegramResult } from "./api.js";

/**
 * Test double for the Bot API: records every call and answers from a script. Shared by the
 * core and api test suites, so it ships in the package rather than beside one test.
 */
/** A 1x1 PNG. */
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

export class FakeTelegramApi extends TelegramApi {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Per method, what to answer; a function sees the params. Default: ok with an empty result. */
  readonly answers = new Map<
    string,
    TelegramResult<unknown> | ((params: Record<string, unknown>) => TelegramResult<unknown>)
  >();

  /**
   * By default every artwork URL serves a tiny PNG, so an alert with artwork goes out as an
   * upload ("upload" in sent()); a fetch that fails sends the alert as text (sendAlert).
   */
  constructor(
    fetchImpl: typeof fetch = async () =>
      new Response(TINY_PNG, { headers: { "content-type": "image/png" } }),
  ) {
    // Every host resolves to a public address, so the fake fetch is what decides.
    super("fake-token", fetchImpl, async () => ["93.184.216.34"]);
  }

  override async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramResult<T>> {
    this.calls.push({ method, params });
    const answer = this.answers.get(method);
    const result = typeof answer === "function" ? answer(params) : answer;
    return (result ?? { ok: true, result: {} }) as TelegramResult<T>;
  }

  /**
   * Every message that went out, text or photo. `photo` is the URL handed to Telegram, or
   * "upload" when the bytes were uploaded, or null for a text message.
   */
  sent(): { chatId: string; text: string; photo: string | null }[] {
    return this.calls
      .filter((c) => c.method === "sendMessage" || c.method === "sendPhoto")
      .map((c) => ({
        chatId: String(c.params.chat_id),
        text: String(c.method === "sendPhoto" ? c.params.caption : c.params.text),
        photo:
          c.method !== "sendPhoto"
            ? null
            : c.params.photo instanceof Blob
              ? "upload"
              : String(c.params.photo),
      }));
  }
}
