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
    if (url.pathname === "/api/status" && request.method === "GET") {
      if (!String(env.ONEAI_API_KEY || "").trim()) {
        return json({ ok: true, connected: false, provider: "1AI", reason: "configuration" }, 200, origin);
      }
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort("status timeout"), 8000);
        try {
          const upstream = await fetch("https://1ai.ir/v1/models", {
            method: "GET",
            headers: { "Authorization": "Bearer " + String(env.ONEAI_API_KEY).trim(), "Accept": "application/json" },
            signal: controller.signal
          });
          return json({ ok: true, connected: upstream.ok, provider: "1AI" }, 200, origin);
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return json({ ok: true, connected: false, provider: "1AI", reason: "network" }, 200, origin);
      }
    }
    if (url.pathname === "/api/chat" && request.method === "POST") return handleChat(request, env);

    if (url.pathname === "/api/media-image" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "درخواست تصویر معتبر نیست." }, 400, origin); }
      const image = typeof body?.image === "string" ? body.image : "";
      const prompt = typeof body?.prompt === "string" ? body.prompt.slice(0, 12000) : "این تصویر را دقیق بررسی کن و درباره موارد ناخوانا حدس نزن.";
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) return json({ ok: false, error: "فرمت تصویر معتبر نیست." }, 400, origin);
      if (image.length > 8000000) return json({ ok: false, error: "حجم تصویر بیش از حد مجاز است." }, 413, origin);
      if (!env.ONEAI_API_KEY) return json({ ok: false, error: "کلید سرویس چت تنظیم نشده است." }, 503, origin);
      try {
        const upstream = await fetch(AI_URL, { method: "POST", headers: { "Authorization": "Bearer " + String(env.ONEAI_API_KEY).trim(), "Content-Type": "application/json" }, body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image, detail: "high" } }] }], reasoning_effort: "low", max_completion_tokens: 4096 }), signal: AbortSignal.timeout(55000) });
        const data = await upstream.json().catch(() => ({}));
        const answer = extractText(data);
        if (!upstream.ok || !answer) return json({ ok: false, error: "تحلیل تصویر ناموفق بود.", provider_status: upstream.status }, 502, origin);
        return json({ ok: true, text: answer, provider: "1AI", model: AI_MODEL }, 200, origin);
      } catch { return json({ ok: false, error: "ارتباط برای تحلیل تصویر برقرار نشد." }, 502, origin); }
    }

    if (url.pathname === "/api/media-audio" && request.method === "POST") {
      if (!env.ONEAI_API_KEY) return json({ ok: false, error: "کلید سرویس چت تنظیم نشده است." }, 503, origin);
      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return json({ ok: false, error: "فایل صوتی ارسال نشده است." }, 400, origin);
      if (file.size < 1 || file.size > 20 * 1024 * 1024) return json({ ok: false, error: "حجم فایل صوتی باید حداکثر ۲۰ مگابایت باشد." }, 413, origin);
      const payload = new FormData();
      payload.append("file", file, file.name || "audio-file");
      payload.append("model", String(env.ONEAI_AUDIO_MODEL || "openai/whisper-1"));
      payload.append("language", "fa");
      payload.append("response_format", "json");
      try {
        const upstream = await fetch("https://1ai.ir/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": "Bearer " + String(env.ONEAI_API_KEY).trim() }, body: payload, signal: AbortSignal.timeout(60000) });
        const data = await upstream.json().catch(() => ({}));
        if (!upstream.ok) return json({ ok: false, error: "تبدیل صوت به متن ناموفق بود.", provider_status: upstream.status, provider_message: String(data?.error?.message || data?.message || "").slice(0, 500) }, 502, origin);
        const transcript = String(data.text || "").trim();
        if (!transcript) return json({ ok: false, error: "متنی از فایل صوتی دریافت نشد." }, 502, origin);
        return json({ ok: true, text: transcript, provider: "1AI" }, 200, origin);
      } catch { return json({ ok: false, error: "ارتباط برای تبدیل صوت برقرار نشد." }, 502, origin); }
    }

    if (url.pathname === "/api/unity-precedents/ask" && request.method === "POST") {
      try {
        const payload = await request.json();
        const body = JSON.stringify(payload);
        let upstream;
        if (env.UNITY_SERVICE && typeof env.UNITY_SERVICE.fetch === "function") {
          const internalRequest = new Request(new URL("/api/unity-precedents/ask", request.url), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(90000)
          });
          upstream = await env.UNITY_SERVICE.fetch(internalRequest);
        } else {
          const base = String(env.UNITY_API_URL || "").trim().replace(/\\/+$/, "");
          if (!base || !/^https:\\/\\//i.test(base)) {
            return json({ ok: false, error: "اتصال امن به سرویس مستقل بانک آرای وحدت رویه هنوز برقرار نشده است." }, 503, origin);
          }
          upstream = await fetch(base + "/api/unity-precedents/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(90000)
          });
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin"
          }
        });
      } catch {
        return json({ ok: false, error: "ارتباط با سرویس بانک آرای وحدت رویه برقرار نشد." }, 502, origin);
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "مسیر API پیدا نشد." }, 404, origin);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("K-Law Chat service is running.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
