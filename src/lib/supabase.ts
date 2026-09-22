import { createClient, processLock } from "@supabase/supabase-js";

// Where the project lives, and the key the browser uses to reach it.
//
// Both come from the environment rather than from this file. That is not about
// keeping the anon key secret — it is published to every visitor by design, and
// is safe to publish ONLY because row-level security is enabled on every table.
// It is about being able to point the app at a different project, or take a new
// key, by changing the host's settings and redeploying, without a code change.
//
// Vite only exposes variables prefixed VITE_, and inlines them at BUILD time, so
// changing either one in the host's dashboard takes a fresh deploy to have any
// effect. Setting it and waiting does nothing.
//
// SECURITY: only ever the anon key here. The service_role key bypasses row-level
// security completely, and anything in this file ships to the browser. If you
// need privileged access, do it from a trusted server (a Supabase Edge
// Function), never from the client.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Fail loudly and immediately, naming what is missing. Every screen is a query,
// so without these the choice is not between working and broken — it is between
// a blank page and a blank page that says why. vite.config.ts refuses to BUILD
// without them; this covers `npm run dev` without a .env.local.
if (!supabaseUrl || !supabaseAnonKey) {
  const missing = [
    !supabaseUrl && "VITE_SUPABASE_URL",
    !supabaseAnonKey && "VITE_SUPABASE_ANON_KEY",
  ].filter(Boolean);
  throw new Error(
    `Supabase is not configured: ${missing.join(" and ")} ${
      missing.length > 1 ? "are" : "is"
    } not set. Set them in the host's environment variables and redeploy, or ` +
      `copy .env.example to .env.local for local development.`,
  );
}

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
