import { createClient } from "./supabase";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

/** company_id for the current user (first membership). Null if no session. */
export async function getCompanyId(): Promise<string | null> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data } = await supabase
    .from("memberships").select("company_id")
    .eq("user_id", session.user.id).limit(1).single();
  return data?.company_id ?? null;
}

/** Auth-aware fetch: attaches Authorization + X-Company-Id from the Supabase session. */
export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  // FormData sets its own multipart Content-Type — don't override it.
  const isFormData = options?.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options?.headers as Record<string, string>),
  };
  if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;
  const companyId = await getCompanyId();
  if (companyId) headers["X-Company-Id"] = companyId;

  return fetch(`${API_URL}${path}`, { ...options, headers });
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** apiFetch that THROWS on non-2xx and returns parsed JSON. Prefer this everywhere. */
export async function apiCall<T = any>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, options);
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.clone().json();
      detail = body?.error || body?.message || "";
    } catch {
      detail = (await res.text().catch(() => "")).slice(0, 200);
    }
    const fallback =
      res.status === 401 || res.status === 403
        ? "You don't have permission to do that. Try signing in again."
        : res.status >= 500
          ? "Something went wrong on our side. Please try again."
          : "That didn't work. Please try again.";
    throw new ApiError(res.status, detail || fallback);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => undefined)) as T;
}
