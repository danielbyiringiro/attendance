import { createClient, processLock } from "@supabase/supabase-js";

// Public (anon) credentials only. The anon key is safe to ship to the browser
// ONLY when Row Level Security (RLS) is enabled on every table in Supabase.
//
// SECURITY: Never put the service_role key in client code. It bypasses RLS and
// would let anyone read, edit, or delete the entire database straight from the
// browser console. If you need privileged access, do it from a trusted server
// (e.g. a Supabase Edge Function) — never here.
const supabaseUrl = "https://ostozdfvnjiamtuyjemh.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zdG96ZGZ2bmppYW10dXlqZW1oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMTAzNzQsImV4cCI6MjA5NDY4NjM3NH0.vmYN_sSWfYkQzyWUk_mTaDzDBL6p2t50z6snVEt5ovI";

/*
 * The auth lock is kept inside this tab.
 *
 * By default the auth client coordinates through the browser's Web Locks API,
 * shared by every tab on the same site, and it asks for the lock with no
 * timeout — a negative acquire timeout in navigatorLock means wait forever. So
 * if any other context on the site holds that lock and never lets go (a frozen
 * background tab, a tab suspended mid-refresh), every Supabase call in every
 * other tab waits indefinitely.
 *
 * That is what the deployed site hit: sign-in completed, then ensure_staff's
 * request sat waiting for a token it could not get, and the dashboard stayed
 * on "Checking your account…". Localhost is a different site to the browser,
 * with its own lock, which is why it kept working.
 *
 * processLock serialises auth work within this tab only, so no other tab can
 * block it. The trade-off is that two open tabs can now refresh the session at
 * the same moment instead of taking turns; Supabase accepts a reused refresh
 * token for a short window precisely so that does not sign anyone out.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { lock: processLock },
});
