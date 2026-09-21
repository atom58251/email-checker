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

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  const admin = await requireAdmin(req);
  if (!admin) return jsonResponse({ error: "Administrator rights are required" }, { status: 403 });

  try {
    const { action, checkId } = await req.json();
    if (action === "list") {
      const { data, error } = await admin
        .from("checks")
        .select("id, user_id, original_filename, status, total_rows, stats, error_message, result_storage_path, created_at, expires_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return jsonResponse({ checks: data ?? [] });
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
