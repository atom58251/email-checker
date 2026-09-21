"use client";

export const dynamic = "force-dynamic";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAdmin } from "@/lib/useAdmin";

type AdminCheck = {
  id: string;
  user_id: string;
  original_filename: string | null;
  status: string;
  total_rows: number | null;
  result_storage_path: string | null;
  created_at: string;
};

export default function AdminPage() {
  const { isAdmin, loading } = useAdmin();
  const [emailColumn, setEmailColumn] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<AdminCheck[]>([]);
  const [loadingChecks, setLoadingChecks] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function callAdminResults<T>(body: unknown): Promise<T> {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("Сессия истекла. Войдите снова.");
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/admin-results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Ошибка сервера (${response.status})`);
    return data as T;
  }

  async function loadAllChecks() {
    setLoadingChecks(true);
    try {
      const data = await callAdminResults<{ checks: AdminCheck[] }>({ action: "list" });
      setChecks(data.checks);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingChecks(false);
    }
  }

  async function downloadResult(checkId: string) {
    try {
      const data = await callAdminResults<{ signedUrl: string }>({ action: "signed-url", checkId });
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  }

  async function downloadBlocklist(action: "suppression-csv" | "dead-domains-csv", filename: string) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Сессия истекла. Войдите снова.");
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/admin-results`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `Ошибка сервера (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  }

  useEffect(() => {
    if (isAdmin) loadAllChecks();
  }, [isAdmin]);

  async function handleImport() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setUploading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      const storagePath = `${userId}/bounce_${Date.now()}_${file.name}`;

      const { error: upErr } = await supabase.storage.from("uploads").upload(storagePath, file);
      if (upErr) throw upErr;

      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/import-bounces`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionData.session?.access_token}`,
          },
          body: JSON.stringify({
            storagePath,
            filename: file.name,
            emailColumn: emailColumn || undefined,
          }),
        }
      );
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error ?? `Ошибка сервера (${resp.status})`);
      setResult(body);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setUploading(false);
    }
  }

  if (loading) return <div className="container">Загрузка...</div>;
  if (!isAdmin) return null;

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Админ-панель</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/"><button className="secondary">Проверка списков</button></a>
          <a href="/help"><button className="secondary">Справка</button></a>
        </div>
      </div>
      <div className="card">
        <h3>Импорт bounce-отчёта в suppression-list</h3>
        <p className="muted">
          Загрузите CSV-отчёт о недоставленных письмах (например, экспорт из
          Postal). Адреса добавятся в общую базу как SHA-256 хэши — открытые
          адреса в базе не сохраняются. Поддерживается как отдельная колонка
          с адресом, так и извлечение адреса из текста ответа сервера
          (там, где провайдер его публикует).
        </p>
        <input
          type="text"
          value={emailColumn}
          onChange={(e) => setEmailColumn(e.target.value)}
          placeholder="Название колонки с email, если нестандартное (необязательно)"
        />
        <input type="file" ref={fileInputRef} accept=".csv,.xlsx" />
        {error && <p className="error">{error}</p>}
        <button onClick={handleImport} disabled={uploading}>
          {uploading ? "Импорт..." : "Импортировать"}
        </button>

        {result && (
          <div className="card" style={{ marginTop: 16 }}>
            <p>Добавлено/обновлено записей: <b>{result.totalAddedOrUpdated}</b></p>
            <p className="muted">
              Адрес взят из колонки: {result.resolvedFromColumn} · извлечён из текста ответа: {result.resolvedFromText} · не распознан: {result.unresolved}
            </p>

            {result.trapsFound > 0 && (
              <div className="card" style={{ marginTop: 12, borderColor: "var(--danger)" }}>
                <p className="error">
                  ⚠ Обнаружено {result.trapsFound} spam trap адресов — заблокированы навсегда.
                </p>
                <p className="muted">
                  Наличие spam trap в списке — сигнал, что часть базы собрана не через
                  честный opt-in. Стоит проверить источник пополнения базы, иначе повторные
                  попадания продолжат бить по репутации отправителя.
                </p>
              </div>
            )}

            {result.senderIssueCounts && Object.keys(result.senderIssueCounts).length > 0 && (
              <div className="card" style={{ marginTop: 12 }}>
                <p><b>Пропущено (проблема отправителя, не адреса):</b></p>
                <ul className="muted">
                  {Object.entries(result.senderIssueCounts).map(([cat, cnt]) => (
                    <li key={cat}>{cat}: {cnt as number}</li>
                  ))}
                </ul>
                {result.senderIssueCounts["gmail_throttling"] && (
                  <p className="error">
                    gmail_throttling обнаружен — Gmail ограничивает скорость приёма писем от
                    вашего сервера. Адреса тут ни при чём, снизьте частоту отправки на gmail.com.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="card">
        <h3>Блоклисты для анализа</h3>
        <p className="muted">Suppression-list содержит SHA-256 хэши email и причины блокировки; открытые email в нём не хранятся.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="secondary" onClick={() => downloadBlocklist("suppression-csv", "suppression-list.csv")}>Скачать suppression-list</button>
          <button className="secondary" onClick={() => downloadBlocklist("dead-domains-csv", "dead-domains.csv")}>Скачать блоклист доменов</button>
        </div>
      </div>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Результаты всех проверок</h3>
            <p className="muted">Скачать можно только готовый результат; ссылка действует 60 секунд.</p>
          </div>
          <button className="secondary" onClick={loadAllChecks} disabled={loadingChecks}>
            {loadingChecks ? "Обновление..." : "Обновить"}
          </button>
        </div>
        {checks.length === 0 && !loadingChecks && <p className="muted">Проверок пока нет.</p>}
        {checks.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Файл</th><th>Пользователь</th><th>Статус</th><th>Строк</th><th /></tr></thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.id}>
                    <td>{check.original_filename ?? "—"}</td>
                    <td className="muted">{check.user_id}</td>
                    <td>{check.status}</td>
                    <td>{check.total_rows ?? "—"}</td>
                    <td>{check.status === "done" && check.result_storage_path && <button className="secondary" onClick={() => downloadResult(check.id)}>Скачать</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
