import { createClient } from "@supabase/supabase-js";

function normalizeMessage(msg) {
  return msg
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, ""); // оставляем только буквы/цифры
}

const allowedColors = [6591981, 16711680];
const allowedFieldNames = [
  "🪙 Name:", "📈 Generation:", "👥 Players:", "🔗 Server Link:",
  "📱 Job-ID (Mobile):", "💻 Job-ID (PC):", "📲 Join:"
];
const blacklist = ["raided", "discord", "everyone", "lol", "raid", "fucked", "fuck"];

export default {
  async fetch(request, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip");
    if (!clientIp) return new Response("IP required", { status: 400 });

    // --- проверка бана ---
    const { data: banData, error: banError } = await supabase
      .from("bans")
      .select("banned_until")
      .eq("ip", clientIp)
      .single();

    if (banError && banError.code !== "PGRST116") {
      console.error("Ban check error:", banError.message);
      return new Response("Internal server error", { status: 500 });
    }

    if (banData && new Date(banData.banned_until) > new Date()) {
      return new Response("IP is banned", { status: 403 });
    }

    // --- метод ---
    if (request.method !== "POST") {
      return new Response("Use POST method", { status: 405 });
    }

    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      return new Response("Content-Type must be application/json", { status: 415 });
    }

    // --- тело ---
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!body.embeds || !Array.isArray(body.embeds) || body.embeds.length < 1) {
      return new Response("Invalid embeds array", { status: 400 });
    }

    const embed = body.embeds[0];
    if (!embed.title || !embed.description || !embed.fields || embed.fields.length < 5) {
      return new Response("Invalid embed structure", { status: 400 });
    }

    if (embed.color !== undefined && !allowedColors.includes(embed.color)) {
      return new Response(`Invalid embed color: ${embed.color}`, { status: 400 });
    }

    // --- глобальная проверка blacklist ---
    const embedString = JSON.stringify(embed).toLowerCase();
    for (const badWord of blacklist) {
      if (embedString.includes(badWord)) {
        return new Response(`Blacklisted word detected: ${badWord}`, { status: 400 });
      }
    }

    // --- проверка полей ---
    for (const field of embed.fields) {
      if (!allowedFieldNames.includes(field.name) || typeof field.value !== "string") {
        return new Response(`Invalid field: ${field.name}`, { status: 400 });
      }
      if (field.inline !== undefined && typeof field.inline !== "boolean") {
        return new Response(`Invalid inline value in: ${field.name}`, { status: 400 });
      }
    }

    const messageContent = JSON.stringify(body.embeds);
    const normalizedContent = normalizeMessage(messageContent);
    const timestamp = new Date().toISOString();

    // --- антиспам ---
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: recentMessages, error: recentError } = await supabase
      .from("messages")
      .select("id")
      .eq("ip", clientIp)
      .eq("normalized_content", normalizedContent)
      .gte("timestamp", oneMinuteAgo);

    if (recentError) {
      console.error("Message query error:", recentError.message);
      return new Response("Internal server error", { status: 500 });
    }

    if (recentMessages.length >= 3) {
      // --- бан ---
      const bannedUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const { error: banInsertError } = await supabase
        .from("bans")
        .upsert([{ ip: clientIp, banned_until: bannedUntil }], { onConflict: "ip" });

      if (banInsertError) {
        console.error("Ban insert error:", banInsertError.message);
        return new Response("Failed to process ban", { status: 500 });
      }

      // --- удаляем все сообщения этого IP ---
      await supabase
        .from("messages")
        .delete()
        .eq("ip", clientIp);

      return new Response("IP banned for spam", { status: 403 });
    }

    // --- вставка ---
    const { error: messageError } = await supabase
      .from("messages")
      .insert([{ ip: clientIp, content: messageContent, normalized_content: normalizedContent, timestamp }]);

    if (messageError) {
      console.error("Message insert error:", messageError.message);
      return new Response("Failed to process message", { status: 500 });
    }

    // --- удаляем лишнее (>100) ---
    const { data: allMessages } = await supabase
      .from("messages")
      .select("id")
      .eq("ip", clientIp)
      .order("timestamp", { ascending: true });

    if (allMessages?.length > 100) {
      const excess = allMessages.length - 100;
      await supabase
        .from("messages")
        .delete()
        .in("id", allMessages.slice(0, excess).map(m => m.id));
    }

    // --- чистим старые (>7 дней) ---
    await supabase
      .from("messages")
      .delete()
      .lt("timestamp", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    // --- дискорд ---
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: body.embeds })
    });

    if (!res.ok) {
      return new Response(`Discord error: ${await res.text()}`, { status: res.status });
    }

    return new Response("OK", { status: 200 });
  }
};
