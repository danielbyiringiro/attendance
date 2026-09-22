/// <reference types="vite/client" />

// Typed so a misspelled variable is a compile error rather than `undefined`
// reaching createClient at runtime. Declared `string` though either can be
// absent at build time: supabase.ts checks that once, up front, and nothing
// downstream should have to check again.
interface ImportMetaEnv {
  /** e.g. https://<project-ref>.supabase.co */
  readonly VITE_SUPABASE_URL: string;
  /** The anon (publishable) key. Never the service_role key. */
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
