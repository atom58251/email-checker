"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";

export function useAdmin() {
  const { user, loading: userLoading } = useUser();
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        if (data?.role !== "admin") {
          router.push("/");
        } else {
          setIsAdmin(true);
        }
        setLoading(false);
      });
  }, [user, router]);

  return { isAdmin, loading: userLoading || loading };
}
