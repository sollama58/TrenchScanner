import { TelegramApi, type TelegramResult } from "./api.js";

/**
 * Test double for the Bot API: records every call and answers from a script. Shared by the
 * core and api test suites, so it ships in the package rather than beside one test.
 */
export class FakeTelegramApi extends TelegramApi {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Per method, what to answer; a function sees the params. Default: ok with an empty result. */
  readonly answers = new Map<
    string,
    TelegramResult<unknown> | ((params: Record<string, unknown>) => TelegramResult<unknown>)
  >();

  constructor() {
    super("fake-token", () => Promise.reject(new Error("the fake never fetches")));
  }

  override async call<T>(method: string, params: Record<string, unknown> = {}): Promise<TelegramResult<T>> {
    this.calls.push({ method, params });
    const answer = this.answers.get(method);
    const result = typeof answer === "function" ? answer(params) : answer;
    return (result ?? { ok: true, result: {} }) as TelegramResult<T>;
  }

  /** Every message that went out, text or photo, with the photo's URL when there was one. */
  sent(): { chatId: string; text: string; photo: string | null }[] {
    return this.calls
      .filter((c) => c.method === "sendMessage" || c.method === "sendPhoto")
      .map((c) => ({
        chatId: String(c.params.chat_id),
        text: String(c.method === "sendPhoto" ? c.params.caption : c.params.text),
        photo: c.method === "sendPhoto" ? String(c.params.photo) : null,
      }));
  }
}
