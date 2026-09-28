// =============================================================================
// Edge Function: purge-expired
//
// Вызывается по расписанию (pg_cron, см. миграцию 0001, раздел "АВТООЧИСТКА").
// Находит записи checks с истёкшим expires_at, удаляет их файлы результатов
// из Storage и сами строки метаданных — реализация принципа "не хранить
// персональные данные дольше необходимого".
//
// Защита: требует Authorization: Bearer <service_role_key>, вызывается
// только из pg_cron/из вашего собственного планировщика, никогда с фронтенда.
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Страховка: файлы в "uploads" (bounce-отчёты с открытыми email) должны удаляться
// сразу после импорта. Если импорт не дошёл до удаления (обрыв сети, сбой), файл
// остался бы навсегда — поэтому раз в запуск удаляем всё старше суток.
async function sweepUploads(admin: ReturnType<typeof createClient>, maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  const { data: top } = await admin.storage.from("uploads").list("", { limit: 1000 });
  for (const entry of top ?? []) {
    if (entry.id) { // файл прямо в корне bucket
      if (entry.created_at && Date.parse(entry.created_at) < cutoff) {
        await admin.storage.from("uploads").remove([entry.name]);
        removed++;
      }
      continue;
    }
    const { data: files } = await admin.storage.from("uploads").list(entry.name, { limit: 1000 });
    const old = (files ?? [])
      .filter((f) => f.id && f.created_at && Date.parse(f.created_at) < cutoff)
      .map((f) => `${entry.name}/${f.name}`);
    if (old.length) {
      await admin.storage.from("uploads").remove(old);
      removed += old.length;
    }
  }
  return removed;
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return new Response("Forbidden", { status: 403 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: expired, error } = await admin
    .from("checks")
    .select("id, user_id, result_storage_path, upload_storage_path")
    .lt("expires_at", new Date().toISOString());

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let removedFiles = 0;
  for (const row of expired ?? []) {
    const paths = [row.result_storage_path, row.upload_storage_path].filter(Boolean) as string[];
    if (paths.length) {
      await admin.storage.from("results").remove(paths);
      await admin.storage.from("uploads").remove(paths);
      removedFiles += paths.length;
    }
  }

  const { error: delErr } = await admin
    .from("checks")
    .delete()
    .lt("expires_at", new Date().toISOString());

  let sweptUploads = 0;
  try {
    sweptUploads = await sweepUploads(admin, 24 * 60 * 60 * 1000);
  } catch (e) {
    console.error("sweepUploads failed:", String((e as Error)?.message ?? e));
  }

  return new Response(
    JSON.stringify({ ok: !delErr, purgedChecks: expired?.length ?? 0, removedFiles, sweptUploads, delErr: delErr?.message }),
    { headers: { "Content-Type": "application/json" } },
  );
});
