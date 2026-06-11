import { createClient } from "@supabase/supabase-js";

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

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
