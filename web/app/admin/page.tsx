"use client";

export const dynamic = "force-dynamic";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAdmin } from "@/lib/useAdmin";

export default function AdminPage() {
  const { isAdmin, loading } = useAdmin();
  const [emailColumn, setEmailColumn] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        <a href="/help"><button className="secondary">Справка</button></a>
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
    </div>
  );
}
