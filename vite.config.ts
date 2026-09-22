import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

/**
 * Refuse to produce a build that cannot reach Supabase.
 *
 * `src/lib/supabase.ts` throws when either variable is missing, but that throw
 * happens in the browser. Vite replaces an unset `import.meta.env.VITE_*` with
 * `undefined` and builds happily, so a misspelled variable in a host's dashboard
 * would produce a green deploy and a white screen for every student.
 *
 * Failing here means the deploy fails instead, and on Vercel a failed build does
 * not replace what is already live. So the worst case of a wrong setting is "the
 * site that was up is still up, and the deploy log names the missing variable".
 *
 * Only for real builds. `npm run dev` stays usable without a .env.local for
 * anyone poking at a component; they get the runtime error if they reach a
 * screen that queries.
 */
const requireSupabaseEnv = (mode: string) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `Cannot build: ${missing.join(" and ")} ${
        missing.length > 1 ? "are" : "is"
      } not set.\n` +
        `Set them in the host's environment variables (Vercel: Project ` +
        `Settings > Environment Variables) and redeploy, or copy .env.example ` +
        `to .env.local locally.`,
    );
  }
};

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  if (command === "build") requireSupabaseEnv(mode);

  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(
      Boolean,
    ),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
