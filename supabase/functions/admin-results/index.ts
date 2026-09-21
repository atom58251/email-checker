// Admin-only access to result metadata and short-lived result links.  Keeping
// this behind an Edge Function avoids weakening the owner-only RLS policies.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { corsHeaders, handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Prevent spreadsheet applications from treating imported bounce text as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvResponse(filename: string, headers: string[], rows: unknown[][]): Response {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return new Response(`\uFEFF${csv}`, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await admin.from("profiles").select("role").eq("id", data.user.id).single();
  return profile?.role === "admin" ? admin : null;
}

async function userEmails(admin: ReturnType<typeof createClient>): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  let page = 1;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const user of data.users) emails.set(user.id, user.email ?? "—");
    if (data.users.length < 1000) return emails;
    page++;
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  const admin = await requireAdmin(req);
  if (!admin) return jsonResponse({ error: "Administrator rights are required" }, { status: 403 });

  try {
    const { action, checkId, kind, queryText = "", category = "", trap, page = 0, pageSize = 50 } = await req.json();
    if (action === "list") {
      const [{ data, error }, emails] = await Promise.all([
        admin
        .from("checks")
        .select("id, user_id, original_filename, status, total_rows, stats, error_message, result_storage_path, created_at, expires_at")
        .order("created_at", { ascending: false }),
        userEmails(admin),
      ]);
      if (error) throw error;
      return jsonResponse({ checks: (data ?? []).map((check) => ({ ...check, user_email: emails.get(check.user_id) ?? "Удалённый пользователь" })) });
    }

    if (action === "summary") {
      const [checksResult, doneResult, processingResult, pendingResult, errorResult, suppressionResult, trapResult, retryResult, domainsResult, auditResult] = await Promise.all([
        admin.from("checks").select("id", { count: "exact", head: true }),
        admin.from("checks").select("id", { count: "exact", head: true }).eq("status", "done"),
        admin.from("checks").select("id", { count: "exact", head: true }).eq("status", "processing"),
        admin.from("checks").select("id", { count: "exact", head: true }).eq("status", "pending"),
        admin.from("checks").select("id", { count: "exact", head: true }).eq("status", "error"),
        admin.from("suppression_entries").select("id", { count: "exact", head: true }),
        admin.from("suppression_entries").select("id", { count: "exact", head: true }).eq("is_trap", true),
        admin.from("suppression_entries").select("id", { count: "exact", head: true }).ilike("action", "%retry%"),
        admin.from("dead_domains").select("domain", { count: "exact", head: true }),
        admin.from("admin_audit_log").select("id", { count: "exact", head: true }),
      ]);
      for (const result of [checksResult, doneResult, processingResult, pendingResult, errorResult, suppressionResult, trapResult, retryResult, domainsResult, auditResult]) {
        if (result.error) throw result.error;
      }
      return jsonResponse({
        checks: {
          total: checksResult.count ?? 0,
          done: doneResult.count ?? 0,
          processing: (processingResult.count ?? 0) + (pendingResult.count ?? 0),
          error: errorResult.count ?? 0,
        },
        blocklists: {
          suppression: suppressionResult.count ?? 0,
          traps: trapResult.count ?? 0,
          retry: retryResult.count ?? 0,
          deadDomains: domainsResult.count ?? 0,
        },
        imports: auditResult.count ?? 0,
      });
    }

    if (action === "blocklist") {
      const safeQueryText = String(queryText).trim();
      const safeCategory = String(category).trim();
      const safeTrap = trap === true ? "true" : trap === false ? "false" : "";
      const safePage = Math.max(Number(page) || 0, 0);
      const safePageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 100);

      if (kind === "suppression") {
        let query = admin.from("suppression_entries").select("email_hash, domain, category, action, is_trap, last_seen, bounce_count", { count: "exact" });
        if (safeQueryText) query = query.ilike("domain", `%${safeQueryText}%`);
        if (safeCategory) query = query.eq("category", safeCategory);
        if (safeTrap === "true") query = query.eq("is_trap", true);
        if (safeTrap === "false") query = query.eq("is_trap", false);
        const { data, error, count } = await query.order("last_seen", { ascending: false }).range(safePage * safePageSize, safePage * safePageSize + safePageSize - 1);
        if (error) throw error;
        return jsonResponse({ rows: data ?? [], total: count ?? 0 });
      }

      if (kind === "dead-domains") {
        let query = admin.from("dead_domains").select("domain, reason, last_confirmed_at, confirm_count", { count: "exact" });
        if (safeQueryText) query = query.ilike("domain", `%${safeQueryText}%`);
        const { data, error, count } = await query.order("last_confirmed_at", { ascending: false }).range(safePage * safePageSize, safePage * safePageSize + safePageSize - 1);
        if (error) throw error;
        return jsonResponse({ rows: data ?? [], total: count ?? 0 });
      }
      return jsonResponse({ error: "Unsupported blocklist" }, { status: 400 });
    }

    if (action === "audit") {
      const { data, error } = await admin
        .from("admin_audit_log")
        .select("id, admin_id, action, details, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const emails = await userEmails(admin);
      return jsonResponse({ entries: (data ?? []).map((entry) => ({ ...entry, admin_email: emails.get(entry.admin_id ?? "") ?? "Удалённый пользователь" })) });
    }

    if (action === "signed-url" && typeof checkId === "string") {
      const { data: check, error } = await admin
        .from("checks")
        .select("result_storage_path")
        .eq("id", checkId)
        .single();
      if (error || !check?.result_storage_path) {
        return jsonResponse({ error: "Result file not found" }, { status: 404 });
      }
      const { data, error: urlError } = await admin.storage
        .from("results")
        .createSignedUrl(check.result_storage_path, 60);
      if (urlError || !data) throw urlError ?? new Error("Could not create a signed URL");
      return jsonResponse({ signedUrl: data.signedUrl });
    }

    if (action === "suppression-csv") {
      const { data, error } = await admin
        .from("suppression_entries")
        .select("email_hash, domain, reason, category, action, is_trap, first_seen, last_seen, bounce_count, created_at")
        .order("domain", { ascending: true });
      if (error) throw error;
      return csvResponse(
        "suppression-list.csv",
        ["email_hash", "domain", "reason", "category", "action", "is_trap", "first_seen", "last_seen", "bounce_count", "created_at"],
        (data ?? []).map((row) => [row.email_hash, row.domain, row.reason, row.category, row.action, row.is_trap, row.first_seen, row.last_seen, row.bounce_count, row.created_at]),
      );
    }

    if (action === "dead-domains-csv") {
      const { data, error } = await admin
        .from("dead_domains")
        .select("domain, reason, first_confirmed_at, last_confirmed_at, confirm_count")
        .order("domain", { ascending: true });
      if (error) throw error;
      return csvResponse(
        "dead-domains.csv",
        ["domain", "reason", "first_confirmed_at", "last_confirmed_at", "confirm_count"],
        (data ?? []).map((row) => [row.domain, row.reason, row.first_confirmed_at, row.last_confirmed_at, row.confirm_count]),
      );
    }

    return jsonResponse({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, { status: 500 });
  }
});
