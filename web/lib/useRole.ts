"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";

/**
 * В отличие от useAdmin (который редиректит не-админа прочь), этот хук
 * просто отдаёт роль текущего пользователя — используется там, где страница
 * доступна всем, но содержимое отличается (например, /help: админ видит
 * полную инструкцию, обычный пользователь — версию без раздела про
 * администрирование).
 */
export function useRole() {
  const { user, loading: userLoading } = useUser();
  const [role, setRole] = useState<"user" | "admin" | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        setRole(data?.role === "admin" ? "admin" : "user");
        setLoading(false);
      });
  }, [user]);

  return { role, loading: userLoading || loading };
}
