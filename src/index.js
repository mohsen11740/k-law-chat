const AI_URL = "https://1ai.ir/v1/chat/completions";
const AI_MODEL = "openai/gpt-5.4-mini";
const VERSION = "k-law-chat-1";

const SYSTEM_PROMPT = [
  "تو دستیار گفت‌وگوی حقوقی فارسی‌زبان K-Law هستی و در چارچوب حقوق ایران پاسخ می‌دهی.",
  "پاسخ را دقیق، مرتبط، روشن و متناسب با پرسش کاربر ارائه کن.",
  "میان حکم قانون، تحلیل حقوقی و فرضیات پرونده تفاوت بگذار.",
  "شماره ماده، عنوان قانون، رأی وحدت رویه یا منبع را جعل یا حدس نزن.",
  "اگر از صحت مستند قانونی اطمینان نداری، این موضوع را صریح اعلام کن و آن را نیازمند تطبیق با منبع رسمی بدان.",
  "اگر اطلاعات ضروری برای پاسخ کافی نیست، فقط سؤال تکمیلی ضروری را بپرس.",
  "از مقدمه‌های طولانی و هشدارهای عمومی غیرضروری خودداری کن.",
  "به زبان فارسی روان و با ساختار خوانا پاسخ بده."
].join("\n");

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    }
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const configured = String(env.ALLOWED_ORIGIN || "").trim();
  if (!configured) return "*";
  return origin === configured ? configured : configured;
}

function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => typeof part === "string" ? part : String(part?.text || "")).filter(Boolean).join("\n").trim();
  }
  return "";
}

async function handleChat(request, env) {
  if (!env.ONEAI_API_KEY || !String(env.ONEAI_API_KEY).trim()) {
    return json({ ok: false, error: "کلید اتصال هوش مصنوعی در سرویس چت تنظیم نشده است.", stage: "configuration" }, 503, allowedOrigin(request, env));
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "درخواست ارسالی معتبر نیست." }, 400, allowedOrigin(request, env)); }

  const incoming = Array.isArray(body?.messages) ? body.messages : [];
  const messages = incoming
    .filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string" && item.content.trim())
    .slice(-12)
    .map(item => ({ role: item.role, content: item.content.trim().slice(0, 12000) }));

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ ok: false, error: "پیام کاربر خالی است یا ترتیب مکالمه معتبر نیست." }, 400, allowedOrigin(request, env));
  }
  if (messages.reduce((sum, item) => sum + item.content.length, 0) > 50000) {
    return json({ ok: false, error: "حجم مکالمه بیش از حد مجاز است؛ لطفاً پیام کوتاه‌تری ارسال کنید." }, 413, allowedOrigin(request, env));
  }

  const stream = body?.stream === true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("upstream timeout"), 55000);

  try {
    const upstream = await fetch(AI_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.ONEAI_API_KEY).trim(),
        "Content-Type": "application/json",
        "Accept": stream ? "text/event-stream" : "application/json"
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        reasoning_effort: "low",
        max_completion_tokens: 1600,
        stream
      }),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return json({
        ok: false,
        error: "سرویس هوش مصنوعی نتوانست پاسخ دهد.",
        stage: "provider",
        provider_status: upstream.status,
        provider_message: detail.slice(0, 700)
      }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, allowedOrigin(request, env));
    }

    if (stream) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") || "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": allowedOrigin(request, env),
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Vary": "Origin",
          "X-K-Law-Chat-Version": VERSION
        }
      });
    }

    const data = await upstream.json().catch(() => ({}));
    const answer = extractText(data);
    if (!answer) return json({ ok: false, error: "پاسخ متنی معتبری از هوش مصنوعی دریافت نشد.", stage: "empty_response" }, 502, allowedOrigin(request, env));
    return json({ ok: true, text: answer, provider: "1AI", model: AI_MODEL, version: VERSION }, 200, allowedOrigin(request, env));
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return json({
      ok: false,
      error: timedOut ? "زمان پاسخ‌گویی هوش مصنوعی به پایان رسید؛ دوباره تلاش کنید." : "ارتباط با سرویس هوش مصنوعی برقرار نشد.",
      stage: timedOut ? "timeout" : "network"
    }, timedOut ? 504 : 502, allowedOrigin(request, env));
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    }});
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "k-law-chat", version: VERSION, provider: "1AI", model: AI_MODEL, api_key_configured: !!String(env.ONEAI_API_KEY || "").trim() }, 200, origin);
    }
    if (url.pathname === "/api/chat" && request.method === "POST") return handleChat(request, env);
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "مسیر API پیدا نشد." }, 404, origin);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("K-Law Chat service is running.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
