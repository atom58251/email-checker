// =============================================================================
// Клиент Supabase для браузера. Использует ТОЛЬКО публичный anon key —
// он безопасен для фронтенда именно потому, что вся защита данных лежит
// на RLS-политиках в базе (см. supabase/migrations). service_role key
// НИКОГДА не должен появляться в этом файле или любом другом коде web/.
// =============================================================================
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Не заданы NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Добавьте их в переменные окружения проекта на Vercel."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
