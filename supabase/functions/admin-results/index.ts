// Admin-only access to result metadata and short-lived result links.  Keeping
// this behind an Edge Function avoids weakening the owner-only RLS policies.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handleCorsPreflight, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

    return jsonResponse({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return jsonResponse({ error: String(error instanceof Error ? error.message : error) }, { status: 500 });
  }
});
