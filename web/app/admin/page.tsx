"use client";

export const dynamic = "force-dynamic";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAdmin } from "@/lib/useAdmin";

type Tab = "overview" | "checks" | "blocklists" | "audit" | "import";
type Check = { id: string; user_email: string; original_filename: string | null; status: string; total_rows: number | null; stats: Record<string, number> | null; error_message: string | null; result_storage_path: string | null; created_at: string; expires_at: string };
type Summary = { checks: { total: number; done: number; processing: number; error: number }; blocklists: { suppression: number; traps: number; retry: number; deadDomains: number }; imports: number };
type Audit = { id: number; admin_email: string; action: string; details: Record<string, unknown> | null; created_at: string };
type Suppression = { email_hash: string; domain: string; category: string | null; action: string | null; is_trap: boolean; last_seen: string | null; bounce_count: number };
type DeadDomain = { domain: string; reason: string | null; last_confirmed_at: string; confirm_count: number };
const PAGE_SIZE = 50;
const DELETE = new Set(["INVALID_SYNTAX", "DELETE_SUPPRESSED", "DELETE_DISPOSABLE", "DELETE_DOMAIN_NOT_EXISTS", "TYPO_SUSPECTED", "EMPTY"]);
const REVIEW = new Set(["NO_MAIL_SUSPECTED", "DNS_INCONCLUSIVE", "DNS_INCONSISTENT"]);
const date = (value?: string | null) => value ? new Date(value).toLocaleString("ru-RU") : "—";

export default function AdminPage() {
  const { isAdmin, loading } = useAdmin();
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [kind, setKind] = useState<"suppression" | "dead-domains">("suppression");
  const [domain, setDomain] = useState("");
  const [category, setCategory] = useState("");
  const [trap, setTrap] = useState<"" | "true" | "false">("");
  const [rows, setRows] = useState<Array<Suppression | DeadDomain>>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [emailColumn, setEmailColumn] = useState("");
  const [importResult, setImportResult] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function api<T>(body: unknown): Promise<T> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Сессия истекла. Войдите снова.");
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/admin-results`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? `Ошибка сервера (${response.status})`);
    return json as T;
  }
  async function loadDashboard() {
    setBusy(true); try { const [s, c] = await Promise.all([api<Summary>({ action: "summary" }), api<{ checks: Check[] }>({ action: "list" })]); setSummary(s); setChecks(c.checks); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); }
  }
  async function loadAudit() { setBusy(true); try { setAudit((await api<{ entries: Audit[] }>({ action: "audit" })).entries); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); } }
  async function loadBlocklist(nextPage = 0) { setBusy(true); try { const data = await api<{ rows: Array<Suppression | DeadDomain>; total: number }>({ action: "blocklist", kind, queryText: domain, category, trap: trap === "" ? null : trap === "true", page: nextPage, pageSize: PAGE_SIZE }); setRows(data.rows); setRowTotal(data.total); setPage(nextPage); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); } }
  useEffect(() => { if (isAdmin) loadDashboard(); }, [isAdmin]);
  const visibleChecks = useMemo(() => checks.filter((c) => (status === "all" || c.status === status) && (!search || `${c.user_email} ${c.original_filename ?? ""}`.toLowerCase().includes(search.toLowerCase()))), [checks, status, search]);
  async function downloadResult(id: string) { try { window.open((await api<{ signedUrl: string }>({ action: "signed-url", checkId: id })).signedUrl, "_blank", "noopener,noreferrer"); } catch (e: any) { setError(e.message ?? String(e)); } }
  async function exportCsv(action: "suppression-csv" | "dead-domains-csv", filename: string) {
    try { const { data } = await supabase.auth.getSession(); const token = data.session?.access_token; if (!token) throw new Error("Сессия истекла."); const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/admin-results`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action }) }); if (!response.ok) throw new Error((await response.json()).error ?? "Не удалось скачать файл"); const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); } catch (e: any) { setError(e.message ?? String(e)); }
  }
  async function importBounce() {
    const file = fileRef.current?.files?.[0]; if (!file) return; setBusy(true); setError(null); setImportResult(null);
    try { const { data } = await supabase.auth.getSession(); const session = data.session; if (!session) throw new Error("Сессия истекла."); const storagePath = `${session.user.id}/bounce_${Date.now()}_${file.name}`; const { error: uploadError } = await supabase.storage.from("uploads").upload(storagePath, file); if (uploadError) throw uploadError; const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/import-bounces`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ storagePath, filename: file.name, emailColumn: emailColumn || undefined }) }); const json = await response.json(); if (!response.ok) throw new Error(json.error ?? `Ошибка сервера (${response.status})`); setImportResult(json); if (fileRef.current) fileRef.current.value = ""; await loadDashboard(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); }
  }
  if (loading) return <div className="container">Загрузка...</div>;
  if (!isAdmin) return null;
  const openTab = (next: Tab) => { setTab(next); if (next === "audit" && !audit.length) loadAudit(); if (next === "blocklists" && !rows.length) loadBlocklist(); };
  return <div className="container admin-container">
    <div className="admin-header"><div><h1>Админ-панель</h1><p className="muted">Проверки, блоклисты и история импортов.</p></div><div className="button-row"><a href="/"><button className="secondary">Проверка списков</button></a><a href="/help"><button className="secondary">Справка</button></a></div></div>
    <div className="admin-tabs">{([ ["overview", "Обзор"], ["checks", "Проверки"], ["blocklists", "Блоклисты"], ["audit", "Аудит"], ["import", "Импорт bounce"] ] as Array<[Tab, string]>).map(([key, label]) => <button key={key} className={tab === key ? "tab-active" : "secondary"} onClick={() => openTab(key)}>{label}</button>)}</div>
    {error && <div className="card"><p className="error">{error}</p></div>}
    {tab === "overview" && <><div className="metric-grid"><Metric label="Всего проверок" value={summary?.checks.total} /><Metric label="Готово" value={summary?.checks.done} /><Metric label="Ошибка / в работе" value={summary ? `${summary.checks.error} / ${summary.checks.processing}` : undefined} /><Metric label="Suppression-list" value={summary?.blocklists.suppression} /><Metric label="Spam trap / временные" value={summary ? `${summary.blocklists.traps} / ${summary.blocklists.retry}` : undefined} /><Metric label="Мёртвые домены" value={summary?.blocklists.deadDomains} /></div><div className="card"><Title title="Последние проверки" text="Полная история, поиск и статистика доступны во вкладке «Проверки»." action={() => loadDashboard()} busy={busy} /><ChecksTable checks={checks.slice(0, 5)} expanded={expanded} setExpanded={setExpanded} onDownload={downloadResult} /></div></>}
    {tab === "checks" && <div className="card"><Title title="Проверки пользователей" text={`${visibleChecks.length} из ${checks.length}`} action={() => loadDashboard()} busy={busy} /><div className="filter-row"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Email пользователя или имя файла" /><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">Все статусы</option><option value="done">Готово</option><option value="processing">В работе</option><option value="error">Ошибка</option><option value="pending">В очереди</option></select></div><ChecksTable checks={visibleChecks} expanded={expanded} setExpanded={setExpanded} onDownload={downloadResult} /></div>}
    {tab === "blocklists" && <div className="card"><Title title="Блоклисты" text="Открытые email не хранятся: suppression-list содержит только SHA-256 хэши." /><div className="button-row"><button className="secondary" onClick={() => exportCsv("suppression-csv", "suppression-list.csv")}>CSV suppression</button><button className="secondary" onClick={() => exportCsv("dead-domains-csv", "dead-domains.csv")}>CSV домены</button></div><div className="filter-row"><select value={kind} onChange={(e) => { setKind(e.target.value as "suppression" | "dead-domains"); setRows([]); setPage(0); }}><option value="suppression">Suppression-list</option><option value="dead-domains">Мёртвые домены</option></select><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="Поиск по домену" />{kind === "suppression" && <><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Категория" /><select value={trap} onChange={(e) => setTrap(e.target.value as "" | "true" | "false")}><option value="">Все записи</option><option value="true">Только spam trap</option><option value="false">Без spam trap</option></select></>}<button onClick={() => loadBlocklist(0)} disabled={busy}>{busy ? "Поиск..." : "Применить"}</button></div><BlocklistTable kind={kind} rows={rows} /><div className="pagination"><span className="muted">Найдено: {rowTotal}</span><button className="secondary" disabled={!page || busy} onClick={() => loadBlocklist(page - 1)}>Назад</button><span>{page + 1}</span><button className="secondary" disabled={(page + 1) * PAGE_SIZE >= rowTotal || busy} onClick={() => loadBlocklist(page + 1)}>Далее</button></div></div>}
    {tab === "audit" && <div className="card"><Title title="Аудит импортов" text="Последние 100 административных действий." action={loadAudit} busy={busy} /><AuditTable entries={audit} /></div>}
    {tab === "import" && <div className="card"><h3>Импорт bounce-отчёта</h3><p className="muted">CSV/XLSX обрабатывается и удаляется сразу после импорта. В блоклист записываются SHA-256 хэши email.</p><input value={emailColumn} onChange={(e) => setEmailColumn(e.target.value)} placeholder="Название колонки с email, если нестандартное" /><input type="file" ref={fileRef} accept=".csv,.xlsx" /><button onClick={importBounce} disabled={busy}>{busy ? "Импорт..." : "Импортировать"}</button>{importResult && <div className="import-result"><p>Добавлено/обновлено: <b>{importResult.totalAddedOrUpdated}</b></p><p className="muted">Из колонки: {importResult.resolvedFromColumn} · из текста: {importResult.resolvedFromText} · не распознано: {importResult.unresolved}</p>{importResult.trapsFound > 0 && <p className="error">⚠ Spam trap: {importResult.trapsFound}</p>}{importResult.dateFallbackCount > 0 && <p className="muted">⚠ Дата не распознана в {importResult.dateFallbackCount} строк(ах) — использована сегодняшняя дата вместо даты из отчёта.</p>}</div>}</div>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string | number | undefined }) { return <div className="metric"><span>{label}</span><b>{value ?? "—"}</b></div>; }
function Title({ title, text, action, busy }: { title: string; text: string; action?: () => void; busy?: boolean }) { return <div className="section-title"><div><h3>{title}</h3><p className="muted">{text}</p></div>{action && <button className="secondary" onClick={action} disabled={busy}>{busy ? "Обновление..." : "Обновить"}</button>}</div>; }
function ChecksTable({ checks, expanded, setExpanded, onDownload }: { checks: Check[]; expanded: string | null; setExpanded: (id: string | null) => void; onDownload: (id: string) => void }) {
  if (!checks.length) return <p className="muted">Нет проверок.</p>;
  return <div className="table-wrap"><table><thead><tr><th>Файл / пользователь</th><th>Статус</th><th>Строк</th><th>Создана</th><th /></tr></thead><tbody>{checks.map((check) => { const isOpen = expanded === check.id; const stats = Object.entries(check.stats ?? {}); const remove = stats.filter(([key]) => DELETE.has(key)).reduce((sum, [, value]) => sum + value, 0); const review = stats.filter(([key]) => REVIEW.has(key)).reduce((sum, [, value]) => sum + value, 0); const keep = stats.filter(([key]) => !DELETE.has(key) && !REVIEW.has(key)).reduce((sum, [, value]) => sum + value, 0); return <Fragment key={check.id}><tr><td><b>{check.original_filename ?? "—"}</b><br /><span className="muted">{check.user_email}</span></td><td className={`status-${check.status === "done" ? "ok" : check.status === "error" ? "error" : "processing"}`}>{check.status}</td><td>{check.total_rows ?? "—"}</td><td>{date(check.created_at)}</td><td className="button-row"><button className="secondary" onClick={() => setExpanded(isOpen ? null : check.id)}>{isOpen ? "Скрыть" : "Детали"}</button>{check.status === "done" && check.result_storage_path && <button className="secondary" onClick={() => onDownload(check.id)}>Скачать</button>}</td></tr>{isOpen && <tr className="details-row"><td colSpan={5}>{check.error_message && <p className="error">{check.error_message}</p>}<p className="muted">Оставить: {keep} · проверить: {review} · удалить: {remove} · удаление: {date(check.expires_at)}</p><div className="stats-list">{stats.map(([key, value]) => <span key={key}>{key}: {value}</span>)}</div></td></tr>}</Fragment>; })}</tbody></table></div>;
}
function BlocklistTable({ kind, rows }: { kind: "suppression" | "dead-domains"; rows: Array<Suppression | DeadDomain> }) { if (!rows.length) return <p className="muted">Нажмите «Применить», чтобы загрузить данные.</p>; return kind === "dead-domains" ? <div className="table-wrap"><table><thead><tr><th>Домен</th><th>Причина</th><th>Подтверждён</th><th>Кол-во</th></tr></thead><tbody>{(rows as DeadDomain[]).map((row) => <tr key={row.domain}><td>{row.domain}</td><td>{row.reason ?? "—"}</td><td>{date(row.last_confirmed_at)}</td><td>{row.confirm_count}</td></tr>)}</tbody></table></div> : <div className="table-wrap"><table><thead><tr><th>Домен</th><th>Категория</th><th>Статус</th><th>Trap</th><th>Последний bounce</th><th>Кол-во</th></tr></thead><tbody>{(rows as Suppression[]).map((row) => <tr key={row.email_hash}><td>{row.domain}</td><td>{row.category ?? "—"}</td><td>{row.action ?? "—"}</td><td>{row.is_trap ? "Да" : "Нет"}</td><td>{date(row.last_seen)}</td><td>{row.bounce_count}</td></tr>)}</tbody></table></div>; }
function AuditTable({ entries }: { entries: Audit[] }) { if (!entries.length) return <p className="muted">Записей пока нет.</p>; return <div className="table-wrap"><table><thead><tr><th>Когда</th><th>Администратор</th><th>Действие</th><th>Результат</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{date(entry.created_at)}</td><td>{entry.admin_email}</td><td>{entry.action}</td><td className="muted">{entry.details?.filename ? `Файл: ${String(entry.details.filename)}; всего: ${String(entry.details.total ?? "—")}` : JSON.stringify(entry.details ?? {})}</td></tr>)}</tbody></table></div>; }
