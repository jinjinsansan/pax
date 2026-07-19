/**
 * Telegram Bot API送信（仕様書§10）。
 * Bot Tokenはログ・DB・ブラウザへ出さない（§24）。
 */
export interface SendResult {
  ok: boolean;
  response: unknown;
}

export interface Notifier {
  send(text: string): Promise<SendResult>;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(text: string): Promise<SendResult> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      const body: unknown = await res.json().catch(() => null);
      const ok =
        res.ok &&
        typeof body === "object" &&
        body !== null &&
        (body as { ok?: boolean }).ok === true;
      return { ok, response: body };
    } catch (err) {
      return {
        ok: false,
        response: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
