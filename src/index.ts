import { handleTelegramWebhook, processTelegramJob, type Env, type TelegramJob } from "./telegram/webhook";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram/webhook") return handleTelegramWebhook(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
  async queue(batch: MessageBatch<TelegramJob>, env: Env): Promise<void> {
    for (const message of batch.messages) await processTelegramJob(message.body, env);
  }
} satisfies ExportedHandler<Env, TelegramJob>;
