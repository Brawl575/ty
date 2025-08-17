// t
import { createClient } from "@supabase/supabase-js";

function normalizeMessage(msg) {
  return msg
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]/gi, ""); // оставляем только буквы/цифры
}

const allowedColors = [6591981, 16711680];
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

export default {
  async fetch(request, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip");

    console.log(`Processing request from IP: ${clientIp}, URL: ${url.pathname}`);

    if (!clientIp) {
      console.error("Missing client IP in request headers");
      return new Response(JSON.stringify({ error: "IP address is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Проверка бана
    const { data: banData, error: banError } = await supabase
      .from("bans")
      .select("banned_until")
      .eq("ip", clientIp)
      .single();

    if (banError && banError.code !== "PGRST116") {
      console.error(`Ban check failed for IP: ${clientIp}`, {
        error: banError.message,
        code: banError.code,
        details: banError.details,
      });
      return new Response(
        JSON.stringify({ error: "Failed to check ban status", details: banError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (banData && new Date(banData.banned_until) > new Date()) {
      console.warn(`Access denied: IP ${clientIp} is banned until ${banData.banned_until}`);
      return new Response(
        JSON.stringify({ error: `IP is banned until ${banData.banned_until}` }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Проверка метода
    if (request.method !== "POST") {
      console.error(`Invalid method: ${request.method} from IP: ${clientIp}`);
      return new Response(JSON.stringify({ error: "Only POST method is allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const ct = request.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      console.error(`Invalid Content-Type: ${ct} from IP: ${clientIp}`);
      return new Response(
        JSON.stringify({ error: "Content-Type must be application/json" }),
        { status: 415, headers: { "Content-Type": "application/json" } }
      );
    }

    // Парсинг тела запроса
    let body;
    try {
      body = await request.json();
    } catch (error) {
      console.error(`JSON parsing failed for IP: ${clientIp}`, {
        error: error.message,
        stack: error.stack,
      });
      return new Response(JSON.stringify({ error: "Invalid JSON", details: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!body.embeds || !Array.isArray(body.embeds) || body.embeds.length < 1) {
      console.error(`Invalid embeds array from IP: ${clientIp}`, { embeds: body.embeds });
      return new Response(JSON.stringify({ error: "Invalid or empty embeds array" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const embed = body.embeds[0];
    if (!embed.title || !embed.description || !embed.fields || embed.fields.length < 5) {
      console.error(`Invalid embed structure from IP: ${clientIp}`, {
        title: embed.title,
        description: embed.description,
        fields: embed.fields?.length,
      });
      return new Response(
        JSON.stringify({ error: "Invalid embed structure: missing title, description, or insufficient fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (embed.color !== undefined && !allowedColors.includes(embed.color)) {
      console.error(`Invalid embed color: ${embed.color} from IP: ${clientIp}`);
      return new Response(
        JSON.stringify({ error: `Invalid embed color: ${embed.color}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Проверка черного списка
    const embedString = JSON.stringify(embed).toLowerCase();
    for (const badWord of blacklist) {
      if (embedString.includes(badWord)) {
        console.error(`Blacklisted word detected: ${badWord} from IP: ${clientIp}`);
        return new Response(
          JSON.stringify({ error: `Blacklisted word detected: ${badWord}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Проверка полей
    for (const field of embed.fields) {
      if (!allowedFieldNames.includes(field.name) || typeof field.value !== "string") {
        console.error(`Invalid field: ${field.name} from IP: ${clientIp}`, {
          fieldValue: field.value,
        });
        return new Response(
          JSON.stringify({ error: `Invalid field name or value: ${field.name}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      if (field.inline !== undefined && typeof field.inline !== "boolean") {
        console.error(`Invalid inline value in field: ${field.name} from IP: ${clientIp}`);
        return new Response(
          JSON.stringify({ error: `Invalid inline value in field: ${field.name}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const messageContent = JSON.stringify(body.embeds);
    const normalizedContent = normalizeMessage(messageContent);
    const timestamp = new Date().toISOString();

    // Антиспам проверка
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: recentMessages, error: recentError } = await supabase
      .from("messages")
      .select("id")
      .eq("ip", clientIp)
      .eq("normalized_content", normalizedContent)
      .gte("timestamp", oneMinuteAgo);

    if (recentError) {
      console.error(`Message query failed for IP: ${clientIp}`, {
        error: recentError.message,
        code: recentError.code,
        details: recentError.details,
      });
      return new Response(
        JSON.stringify({ error: "Failed to check recent messages", details: recentError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (recentMessages.length >= 3) {
      const bannedUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const { error: banInsertError } = await supabase
        .from("bans")
        .upsert([{ ip: clientIp, banned_until: bannedUntil }], { onConflict: "ip" });

      if (banInsertError) {
        console.error(`Ban insert failed for IP: ${clientIp}`, {
          error: banInsertError.message,
          code: banInsertError.code,
          details: banInsertError.details,
        });
        return new Response(
          JSON.stringify({ error: "Failed to process ban", details: banInsertError.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      await supabase.from("messages").delete().eq("ip", clientIp);
      console.warn(`IP ${clientIp} banned until ${bannedUntil} for spam`);
      return new Response(
        JSON.stringify({ error: `IP banned for spam until ${bannedUntil}` }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Вставка сообщения
    const { error: messageError } = await supabase
      .from("messages")
      .insert([{ ip: clientIp, content: messageContent, normalized_content: normalizedContent, timestamp }]);

    if (messageError) {
      console.error(`Message insert failed for IP: ${clientIp}`, {
        error: messageError.message,
        code: messageError.code,
        details: messageError.details,
      });
      return new Response(
        JSON.stringify({ error: "Failed to process message", details: messageError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Удаление лишних сообщений (>100)
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
      console.log(`Deleted ${excess} excess messages for IP: ${clientIp}`);
    }

    // Очистка старых сообщений (>7 дней)
    await supabase
      .from("messages")
      .delete()
      .lt("timestamp", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    console.log(`Cleaned old messages for IP: ${clientIp}`);

    // Отправка в Discord
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: body.embeds }),
    });

    if (!res.ok) {
      const discordError = await res.text();
      console.error(`Discord webhook failed for IP: ${clientIp}`, {
        status: res.status,
        response: discordError,
      });
      return new Response(
        JSON.stringify({ error: "Discord webhook error", details: discordError }),
        { status: res.status, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`Successfully processed request from IP: ${clientIp}`);
    return new Response(JSON.stringify({ message: "OK" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
