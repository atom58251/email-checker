// =============================================================================
// CORS: без этого браузер блокирует запросы с фронтенда (Vercel/Netlify) к
// Edge Function как ошибку CORS, даже не пытаясь получить содержательный
// ответ — сначала уходит служебный OPTIONS-запрос (preflight), и если на
// него не ответить правильными заголовками, реальный POST-запрос браузер
// вообще не отправит. Именно это давало "Failed to fetch" на проде: функция
// сама по себе работала правильно, просто ни один ответ не нёс CORS-заголовков.
//
// "*" в Access-Control-Allow-Origin — намеренно: у Edge Function и так нет
// доступа к чему-либо приватному без анонимного/пользовательского JWT в
// Authorization, а сама функция сама проверяет авторизацию пользователя.
// Открытый CORS тут не ослабляет защиту — она вся на стороне RLS и на
// проверке JWT внутри каждой функции.
// =============================================================================
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Вызывать первой строкой в Deno.serve — отвечает на preflight и ничего больше не делает. */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}

/** Оборачивает JSON-ответ, добавляя CORS-заголовки — использовать вместо голого `new Response(...)`. */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}
