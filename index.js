import { createClient } from "@supabase/supabase-js";

// --- SHA-256 хэш ---
async function hashMessage(normalized) {
  const msgUint8 = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- нормализация содержимого embed ---
function normalizeEmbed(embed) {
    let parts = [];

    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    if (embed.color) parts.push(String(embed.color));

    if (Array.isArray(embed.fields)) {
        for (const field of embed.fields) {
            parts.push(field.name || "");
            parts.push(field.value || "");
        }
    }

    let text = parts.join("|").toLowerCase();

    text = text.replace(/\s+/g, " ").trim();
    text = text.replace(/[^a-z0-9а-яё\s]/gi, "");

    return text;  // n
}


export default {
  async fetch(request, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";

    // --- проверка бана ---
    const { data: banData, error: banError } = await supabase
      .from("bans")
      .select("banned_until")
      .eq("ip", clientIp)
      .single();

    if (banError && banError.code !== "PGRST116") {
      console.error("Ban check error:", banError);
      return new Response("Internal server error", { status: 500 });
    }

    if (banData && new Date(banData.banned_until) > new Date()) {
      return new Response("IP is banned", { status: 403 });
    }

    // --- проверка метода ---
    if (request.method !== "POST") {
      return new Response("Use POST method", { status: 405 });
    }

    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      return new Response("Content-Type must be application/json", { status: 415 });
    }

    // --- парсинг тела ---
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
      return new Response("Invalid embeds array", { status: 400 });
    }

    const allowedColors = [6591981, 16711680];
    if (embed.color !== undefined && !allowedColors.includes(embed.color)) {
      return new Response(`Invalid embed color: ${embed.color}`, { status: 400 });
    }

    const allowedFieldNames = [
      "🪙 Name:",
      "📈 Generation:",
      "👥 Players:",
      "🔗 Server Link:",
      "📱 Job-ID (Mobile):",
      "💻 Job-ID (PC):",
      "📲 Join:",
    ];
    const blacklist = ["raided", "discord", "everyone", "lol", "raid", "fucked", "fuck"];

    for (const field of embed.fields) {
      if (!allowedFieldNames.includes(field.name) || typeof field.value !== "string") {
        return new Response(`Invalid field: ${field.name}`, { status: 400 });
      }
      if (field.inline !== undefined && typeof field.inline !== "boolean") {
        return new Response(`Invalid inline value in: ${field.name}`, { status: 400 });
      }
      for (const badWord of blacklist) {
        if (
          field.name.toLowerCase().includes(badWord) ||
          field.value.toLowerCase().includes(badWord)
        ) {
          return new Response(`Blacklisted word detected: ${badWord}`, { status: 400 });
        }
      }
    }

    // --- готовим хэш ---
    const normalized = normalizeEmbed(embed);
    const messageHash = await hashMessage(normalized);
    const timestamp = new Date().toISOString();

    // --- проверка повторов за последнюю минуту ---
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: recentMessages, error: recentError } = await supabase
      .from("messages")
      .select("id")
      .eq("ip", clientIp)
      .eq("hash", messageHash)
      .gte("timestamp", oneMinuteAgo);

    if (recentError) {
      console.error("Message query error:", recentError);
      return new Response("Internal server error", { status: 500 });
    }

    if (recentMessages.length >= 3) {
      // --- бан ---
      const bannedUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const { error: banInsertError } = await supabase
        .from("bans")
        .upsert([{ ip: clientIp, banned_until: bannedUntil }], { onConflict: "ip" });

      if (banInsertError) {
        console.error("Ban insert error:", banInsertError);
        return new Response("Failed to process ban", { status: 500 });
      }

      // --- удаляем последние сообщения этого IP ---
      const { data: toDelete } = await supabase
        .from("messages")
        .select("id")
        .eq("ip", clientIp)
        .order("timestamp", { ascending: true })
        .limit(5);

      if (toDelete?.length) {
        await supabase.from("messages").delete().in("id", toDelete.map((m) => m.id));
      }

      return new Response(
        "IP banned for sending 3 identical messages within a minute",
        { status: 403 }
      );
    }

    // --- вставка сообщения ---
    const { error: messageError } = await supabase
      .from("messages")
      .insert([{ ip: clientIp, hash: messageHash, timestamp }]);

    if (messageError) {
      console.error("Message insert error:", messageError);
      return new Response("Failed to process message", { status: 500 });
    }

    // --- лимит сообщений для IP (100 шт.) ---
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
        .in("id", allMessages.slice(0, excess).map((m) => m.id));
    }

    // --- автоочистка старых (7 дней) ---
    await supabase
      .from("messages")
      .delete()
      .lt("timestamp", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

    // --- отправляем в Discord ---
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: body.embeds }),
    });

    if (!res.ok) {
      return new Response(`Discord error: ${await res.text()}`, { status: res.status });
    }

    return new Response("OK", { status: 200 });
  },
};
