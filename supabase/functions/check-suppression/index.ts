// =============================================================================
// Edge Function: check-suppression
//
// Заменяет тяжёлую часть старой check-emails. Принимает только МАССИВ
// ХЭШЕЙ (не файл целиком) и возвращает, какие из них есть в
// suppression_entries. Вся тяжёлая работа (парсинг файла, офлайн-проверки,
// сам хэш email → SHA-256) теперь делается в БРАУЗЕРЕ — там нет лимита
// CPU-времени на запрос, в отличие от Edge Function. Здесь остаётся
// только то, что и должно быть на сервере: доступ к suppression_entries
// (обычные пользователи не имеют туда прямого доступа через RLS).
//
// Один batch — до 10000 хэшей (см. синхронизированный лимит в
// web/lib/processFile.ts). Ограничение больше не про длину URL (это
// RPC/POST — см. миграцию 0006), а просто разумный размер одного запроса.
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_HASHES_PER_REQUEST = 10000;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Не авторизован" }, { status: 401 });
  }

  const { hashes } = await req.json();
  if (!Array.isArray(hashes) || hashes.length === 0) {
    return jsonResponse({ error: "hashes: непустой массив обязателен" }, { status: 400 });
  }
  if (hashes.length > MAX_HASHES_PER_REQUEST) {
    return jsonResponse({ error: `максимум ${MAX_HASHES_PER_REQUEST} хэшей за один запрос` }, { status: 400 });
  }

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    // RPC вместо .from().in() — параметры уходят в теле POST-запроса,
    // а не в URL, так что размер батча больше не ограничен длиной URL
    // (см. миграцию 0006_check_suppression_rpc.sql).
    const { data, error } = await admin.rpc("check_suppression_hashes", { hashes });

    if (error) {
      return jsonResponse({ error: `check_suppression_hashes: ${error.message}` }, { status: 500 });
    }

    return jsonResponse({ suppressed: (data ?? []).map((r: { email_hash: string }) => r.email_hash) });
  } catch (e) {
    return jsonResponse({ error: `check-suppression: ${String(e?.message ?? e)}` }, { status: 500 });
  }
});
