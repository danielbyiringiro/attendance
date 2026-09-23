import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";
import path from "path";
import { componentTagger } from "lovable-tagger";

/**
 * `npm run dev:mig` must not quietly talk to the everyday project.
 *
 * Vite loads .env.local in every mode, and a mode file only overrides it when
 * that file exists. So with no .env.migration, `--mode migration` starts
 * happily against whatever .env.local points at — which is the live project,
 * while the person running it believes they are testing another one. That is
 * the one mistake this mode exists to prevent, so it stops instead.
 */
const requireMigrationEnv = () => {
  if (!fs.existsSync(path.resolve(process.cwd(), ".env.migration"))) {
    throw new Error(
      "Cannot run in migration mode: .env.migration does not exist. " +
        "Copy .env.migration.example to .env.migration and point it at the " +
        "other project. Without it this would run against whatever .env.local " +
        "points at, which is not what this mode is for.",
    );
  }
};

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
  if (mode === "migration") requireMigrationEnv();
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
