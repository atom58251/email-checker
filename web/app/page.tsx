"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { useRole } from "@/lib/useRole";
import { runCheck, buildXlsxBlob, type ProgressStage } from "@/lib/processFile";
import { DELETE_STATUSES, REVIEW_STATUSES } from "@/lib/emailUtils";

type CheckRow = {
  id: string;
  original_filename: string | null;
  status: "pending" | "processing" | "done" | "error";
  total_rows: number | null;
  stats: Record<string, number> | null;
  error_message: string | null;
  result_storage_path: string | null;
  created_at: string;
};

const STAGE_LABELS: Record<ProgressStage, string> = {
  parsing: "Разбор файла...",
  offline: "Офлайн-проверки (синтаксис, опечатки, disposable)...",
  suppression: "Сверка с базой известных мёртвых адресов...",
  mx: "Проверка доменов (MX)...",
  assembling: "Сборка результата...",
  done: "Готово",
};

export default function HomePage() {
  const { user, loading: userLoading } = useUser();
  const { role } = useRole();
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [column, setColumn] = useState("email");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ stage: ProgressStage; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadChecks = useCallback(async () => {
    const { data, error: loadError } = await supabase.from("checks").select("*").order("created_at", { ascending: false });
    if (loadError) {
      setError(`Не удалось загрузить историю проверок: ${loadError.message}`);
      return;
    }
    setChecks((data as CheckRow[]) ?? []);
  }, []);

  useEffect(() => {
    if (user) loadChecks();
  }, [user, loadChecks]);

  async function handleUpload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file || !user) return;
    setError(null);
    setProcessing(true);
    setProgress({ stage: "parsing", done: 0, total: 0 });

    const checkId = crypto.randomUUID();
    try {
      // сразу создаём запись, чтобы она появилась в истории со статусом "обрабатывается"
      const { error: insertError } = await supabase.from("checks").insert({
        id: checkId,
        user_id: user.id,
        original_filename: file.name,
        status: "processing",
      });
      if (insertError) throw new Error(`Не удалось создать проверку: ${insertError.message}`);
      await loadChecks();

      // вся тяжёлая работа — в браузере (см. lib/processFile.ts), Edge
      // Functions вызываются только для лёгкой сверки хэшей и MX батчами,
      // чтобы не упираться в CPU time limit на больших файлах
      const { outputRows, stats } = await runCheck(file, column, (stage, done, total) => {
        setProgress({ stage, done, total });
      });

      const blob = buildXlsxBlob(outputRows);
      const resultPath = `${user.id}/${checkId}.xlsx`;
      const { error: upErr } = await supabase.storage.from("results").upload(resultPath, blob, { upsert: true });
      if (upErr) throw upErr;

      const { error: updateError } = await supabase
        .from("checks")
        .update({
          status: "done",
          total_rows: outputRows.length,
          stats,
          result_storage_path: resultPath,
        })
        .eq("id", checkId);
      if (updateError) throw new Error(`Файл результата сохранён, но статус не обновлён: ${updateError.message}`);

      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadChecks();
    } catch (err: any) {
      const message = err.message ?? String(err);
      setError(message);
      const { error: statusError } = await supabase
        .from("checks")
        .update({ status: "error", error_message: message })
        .eq("id", checkId);
      if (statusError) setError(`${message}. Не удалось сохранить ошибку: ${statusError.message}`);
      await loadChecks();
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  }

  async function handleDownload(check: CheckRow) {
    if (!check.result_storage_path) return;
    const { data, error } = await supabase.storage.from("results").createSignedUrl(check.result_storage_path, 60);
    if (error || !data) {
      setError(`Не удалось подготовить скачивание: ${error?.message ?? "файл не найден"}`);
      return;
    }
    window.open(data.signedUrl, "_blank");
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  if (userLoading) return <div className="container">Загрузка...</div>;

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Проверка email-списков</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/help"><button className="secondary">Справка</button></a>
          {role === "admin" && <a href="/admin"><button className="secondary">Админ-панель</button></a>}
          <button className="secondary" onClick={handleSignOut}>Выйти</button>
        </div>
      </div>

      <div className="card">
        <h3>Новая проверка</h3>
        <p className="muted">
          Загрузите .xlsx или .csv со списком email. Обработка идёт прямо у вас в
          браузере (синтаксис, опечатки, одноразовые сервисы) — сервер задействован
          только для сверки с базой известных мёртвых адресов и проверки MX-записей
          доменов. Никаких подключений к вашим почтовым серверам получателей не
          выполняется.
        </p>
        <input
          type="text"
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          placeholder="Название колонки с email (по умолчанию 'email')"
          disabled={processing}
        />
        <input type="file" ref={fileInputRef} accept=".xlsx,.xls,.csv" disabled={processing} />
        {error && <p className="error">{error}</p>}
        {progress && (
          <p className="muted">
            {STAGE_LABELS[progress.stage]}
            {progress.total > 0 && ` (${Math.min(progress.done, progress.total)}/${progress.total})`}
          </p>
        )}
        <button onClick={handleUpload} disabled={processing}>
          {processing ? "Обработка..." : "Загрузить и проверить"}
        </button>
      </div>

      <div className="card">
        <h3>Мои проверки</h3>
        {checks.length === 0 && <p className="muted">Пока нет ни одной проверки.</p>}
        {checks.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Статус</th>
                <th>Всего</th>
                <th>Удалить / Проверить / Оставить</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td>{c.original_filename}</td>
                  <td className={`status-${c.status === "done" ? "ok" : c.status === "error" ? "error" : "processing"}`}>
                    {c.status === "pending" && "в очереди"}
                    {c.status === "processing" && "обрабатывается..."}
                    {c.status === "done" && "готово"}
                    {c.status === "error" && `ошибка: ${c.error_message ?? ""}`}
                  </td>
                  <td>{c.total_rows ?? "—"}</td>
                  <td className="muted">
                    {c.stats
                      ? (() => {
                          const entries = Object.entries(c.stats);
                          const toDelete = entries
                            .filter(([k]) => DELETE_STATUSES.has(k))
                            .reduce((s, [, v]) => s + v, 0);
                          const toReview = entries
                            .filter(([k]) => REVIEW_STATUSES.has(k))
                            .reduce((s, [, v]) => s + v, 0);
                          const toKeep = entries
                            .filter(([k]) => !DELETE_STATUSES.has(k) && !REVIEW_STATUSES.has(k))
                            .reduce((s, [, v]) => s + v, 0);
                          return `удалить: ${toDelete} / проверить: ${toReview} / оставить: ${toKeep}`;
                        })()
                      : "—"}
                  </td>
                  <td>
                    {c.status === "done" && c.result_storage_path && (
                      <button className="secondary" onClick={() => handleDownload(c)}>Скачать</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          Результаты и исходные файлы автоматически удаляются через 14 дней.
        </p>
      </div>
    </div>
  );
}
