// =============================================================================
// Edge Function: import-bounces
//
// Только для админа. Принимает bounce-отчёт (файл, который админ загрузил
// в bucket 'uploads' под своим user_id) и пополняет suppression_entries.
// Email хэшируются перед записью в БД — открытый адрес в базе не остаётся.
//
// Поддерживает оба формата, с которыми уже сталкивались:
//   - отдельная колонка email/address/recipient
//   - только smtp_response, адрес извлекается регуляркой (если провайдер
//     его туда публикует; Gmail/Yandex — нет, такие строки пропускаются
//     и возвращаются в ответе как unresolvedCount, без попытки угадать)
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { hashEmail, checkSyntax, EMAIL_IN_TEXT_RE, classifyCategory, normalizeReportDate } from "../_shared/emailUtils.ts";
import { parseUploadedFile } from "../_shared/parseFile.ts";
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
  const adminUserId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // проверяем роль admin на сервере — не доверяем клиенту
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", adminUserId)
    .single();
  if (profile?.role !== "admin") {
    return jsonResponse({ error: "Требуются права администратора" }, { status: 403 });
  }

  const { storagePath, filename, emailColumn, senderEmail } = await req.json();
  if (!storagePath) {
    return jsonResponse({ error: "storagePath обязателен" }, { status: 400 });
  }
  const senderEmailNorm = String(senderEmail ?? "").trim().toLowerCase();
  if (!senderEmailNorm || !senderEmailNorm.includes("@")) {
    await admin.storage.from("uploads").remove([storagePath]).catch(() => {});
    return jsonResponse(
      { error: "senderEmail обязателен — с какой почты/домена был этот отчёт (нужно для правильной привязки отписок к проекту)" },
      { status: 400 }
    );
  }
  const senderDomain = senderEmailNorm.split("@")[1];

  // Файл с открытыми email не должен оставаться в Storage ни при каком исходе.
  const dropUpload = async () => { try { await admin.storage.from("uploads").remove([storagePath]); } catch (_) { /* не критично */ } };

  try {
    const { data: fileBlob, error: dlErr } = await admin.storage.from("uploads").download(storagePath);
    if (dlErr || !fileBlob) throw new Error(`Не удалось скачать файл: ${dlErr?.message}`);

    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    const rows = parseUploadedFile(bytes, filename ?? "report.csv");

    if (rows.length === 0) throw new Error("Файл пуст");
    const CATEGORY_COL_ALIASES = ["category", "Результат отправки"];
    const foundCategoryCol = CATEGORY_COL_ALIASES.find((c) => c in rows[0]);
    if (!foundCategoryCol) {
      throw new Error(
        `В отчёте нет колонки категории (ожидалась одна из: ${CATEGORY_COL_ALIASES.join(", ")}). Найдены: ${Object.keys(rows[0]).join(", ")}`
      );
    }

    const candidates = [emailColumn, "email", "address", "recipient", "recipient_email"].filter(Boolean);
    const foundEmailCol = candidates.find((c) => c in rows[0]);

    let resolvedFromColumn = 0;
    let resolvedFromText = 0;
    let unresolved = 0;
    let trapsFound = 0;
    let dateFallbackCount = 0;
    let ignoredCount = 0;
    const senderIssueCounts: Record<string, number> = {};
    const upserts: Array<{
      email_hash: string;
      domain: string;
      reason: string;
      category: string;
      action: string;
      is_trap: boolean;
      sender_email: string;
      sender_domain: string;
      last_seen: string;
      added_by: string;
    }> = [];

    for (const row of rows) {
      // "Результат отправки" — реальное название колонки в выгрузке Unisender
      // Go (см. обсуждение в чате); foundCategoryCol определён выше по тому
      // же списку алиасов, которым уже прошла валидация файла.
      const category = String(row[foundCategoryCol] ?? "").trim();
      // ВАЖНО: action НЕ берём дословно из файла. У разных источников разные
      // слова для одного и того же смысла — у Postal action='RETRY in 2-4
      // weeks' (содержит 'retry'), у Listmonk та же по сути ситуация
      // называется action='review' (НЕ содержит 'retry'). Если хранить
      // чужое слово как есть, 28-дневное автоистечение (см. миграцию 0008,
      // проверяет action ILIKE '%retry%') могло бы не сработать для
      // Listmonk-записей, которые классификатор считает временными —
      // запись осела бы в базе навсегда вопреки своей же категории.
      // Поэтому action всегда выводим из НАШЕЙ классификации категории —
      // она единый источник истины и для "хранить или нет", и для
      // "навсегда или временно".
      const dateRaw = String(row["sent_utc"] ?? row["added_utc"] ?? row["Время обновления"] ?? "").trim();
      const dateNormalized = normalizeReportDate(dateRaw);
      if (dateRaw && !dateNormalized) dateFallbackCount++;
      const text = String(row["smtp_response"] ?? row["last_response"] ?? "");

      const bucket = classifyCategory(category);

      // IGNORE: статус не говорит о проблеме с адресом вообще (успешная
      // доставка/открытие/клик, дубль внутри той же рассылки Unisender,
      // ещё не финальный статус) — пропускаем молча, даже не засоряя
      // сводку senderIssueCounts (иначе на большой базе "ok_read: 50000"
      // забьёт собой реально полезные предупреждения в сводке).
      if (bucket === "IGNORE") {
        ignoredCount++;
        continue;
      }

      const action =
        bucket === "RETRY_LATER" ? "RETRY in 2-4 weeks" :
        bucket === "COMPLAINT_UNSUBSCRIBE" ? "DELETE — complaint/unsubscribe" :
        "DELETE from list";

      // SENDER_ISSUE: проблема отправителя (throttling, временная
      // недоступность сервера, отказ по политике) — НЕ повод удалять
      // адрес получателя. Не трогаем suppression-list, только считаем
      // для сводки в ответе (например, чтобы предупредить про throttling).
      if (bucket === "SENDER_ISSUE") {
        senderIssueCounts[category] = (senderIssueCounts[category] ?? 0) + 1;
        continue;
      }

      let email: string | null = null;
      if (foundEmailCol) {
        const val = String(row[foundEmailCol] ?? "").trim();
        if (val && checkSyntax(val)) email = val;
      }
      if (email) {
        resolvedFromColumn++;
      } else {
        const matches = text.match(EMAIL_IN_TEXT_RE);
        if (matches?.[0]) {
          email = matches[0];
          resolvedFromText++;
        }
      }

      if (email) {
        const emailNorm = email.toLowerCase();
        const domain = emailNorm.split("@")[1];
        const isTrap = bucket === "TRAP";
        if (isTrap) trapsFound++;
        // Глобальная блокировка (bounce-факт про адрес, спам-жалоба) —
        // sender_domain = '' (сентинел из 0013). Только отписка
        // (COMPLAINT_UNSUBSCRIBE) привязывается к конкретному домену
        // отправителя: у админа 10 проектов на разных доменах, и отписка
        // от одного не должна блокировать рассылки с другого.
        // Договорённость: по домену отправителя делится ТОЛЬКО отписка (ok_unsubscribed).
        // Спам-жалоба (ok_fbl) и попадание в папку "Спам" бьют по репутации отправителя
        // в целом — блокируем глобально, как и bounce-факты.
        const isUnsubscribe = /unsubscrib/i.test(category);
        const entrySenderDomain = bucket === "COMPLAINT_UNSUBSCRIBE" && isUnsubscribe ? senderDomain : "";
        upserts.push({
          email_hash: await hashEmail(emailNorm),
          domain,
          reason: text.trim() || category,
          category,
          action,
          is_trap: isTrap,
          sender_email: senderEmailNorm,
          sender_domain: entrySenderDomain,
          last_seen: dateNormalized ?? new Date().toISOString().slice(0, 10),
          added_by: adminUserId,
        });
      } else {
        unresolved++;
      }
    }

    // upsert по (email_hash, sender_domain): если запись уже есть — обновляем
    // last_seen/bounce_count через RPC (см. 0013_sender_scoped_unsubscribe.sql —
    // конфликт теперь по паре, а не только по email_hash, чтобы глобальная
    // bounce-запись и запись об отписке от конкретного домена не затирали
    // друг друга).
    // Один и тот же адрес может встретиться в отчёте несколько раз (отчёт
    // Юнисендера построен по событиям: например, и отписка, и жалоба, или
    // повторная недоставка). Если такие дубли попадут в один пакет upsert,
    // Postgres откажет во всём пакете ("ON CONFLICT DO UPDATE command cannot
    // affect row a second time"). Поэтому схлопываем по ключу конфликта
    // (email_hash + sender_domain): trap-запись приоритетнее, иначе берём
    // более свежую; last_seen — максимальный из двух.
    const merged = new Map<string, (typeof upserts)[number]>();
    for (const u of upserts) {
      const key = `${u.email_hash}:${u.sender_domain}`;
      const prev = merged.get(key);
      if (!prev) { merged.set(key, u); continue; }
      const pick =
        u.is_trap && !prev.is_trap ? u :
        prev.is_trap && !u.is_trap ? prev :
        u.last_seen >= prev.last_seen ? u : prev;
      merged.set(key, { ...pick, last_seen: u.last_seen >= prev.last_seen ? u.last_seen : prev.last_seen });
    }
    const uniqueUpserts = Array.from(merged.values());

    const CHUNK = 500;
    for (let i = 0; i < uniqueUpserts.length; i += CHUNK) {
      const chunk = uniqueUpserts.slice(i, i + CHUNK);
      const { error: upsertErr } = await admin.rpc("upsert_suppression_batch", {
        entries: chunk,
      });
      if (upsertErr) throw new Error(`Ошибка записи в suppression-list: ${upsertErr.message}`);
    }

    // Ошибку записи в аудит не глотаем молча (раньше из-за этого журнал
    // оставался пустым, а импорт выглядел успешным): пишем в логи
    // функции. Сам импорт к этому моменту уже выполнен, поэтому его не роняем.
    const { error: auditErr } = await admin.from("admin_audit_log").insert({
      admin_id: adminUserId,
      action: "import_bounces",
      details: {
        filename, resolvedFromColumn, resolvedFromText, unresolved,
        total: rows.length, trapsFound, senderIssueCounts, dateFallbackCount, ignoredCount,
        senderEmail: senderEmailNorm, senderDomain,
      },
    });
    if (auditErr) console.error("admin_audit_log insert failed:", auditErr.message);

    // исходный отчёт можно удалить — он больше не нужен после импорта
    await admin.storage.from("uploads").remove([storagePath]);

    return jsonResponse({
      ok: true,
      resolvedFromColumn,
      resolvedFromText,
      unresolved,
      totalAddedOrUpdated: uniqueUpserts.length,
      trapsFound,
      senderIssueCounts,
      dateFallbackCount,
      ignoredCount,
    });
  } catch (e) {
    await dropUpload();
    return jsonResponse({ error: String(e?.message ?? e) }, { status: 500 });
  }
});
