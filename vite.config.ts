import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const local = loadEnv(mode, process.cwd(), "");
  if (!process.env.DATABASE_URL && local.DATABASE_URL) process.env.DATABASE_URL = local.DATABASE_URL;
  if (!process.env.APP_ORIGIN && local.APP_ORIGIN) process.env.APP_ORIGIN = local.APP_ORIGIN;
  if (!process.env.TORUNI_MAX_QUOTE_NOTIONAL && local.TORUNI_MAX_QUOTE_NOTIONAL) process.env.TORUNI_MAX_QUOTE_NOTIONAL = local.TORUNI_MAX_QUOTE_NOTIONAL;
  if (!process.env.TORUNI_MAX_ACCOUNT_EXPOSURE && local.TORUNI_MAX_ACCOUNT_EXPOSURE) process.env.TORUNI_MAX_ACCOUNT_EXPOSURE = local.TORUNI_MAX_ACCOUNT_EXPOSURE;
  if (local.TORUNI_READ_ONLY_ACCOUNT_PROBES) process.env.TORUNI_READ_ONLY_ACCOUNT_PROBES = local.TORUNI_READ_ONLY_ACCOUNT_PROBES;
  if (local.TORUNI_BUILDER_CODE_PROBE) process.env.TORUNI_BUILDER_CODE_PROBE = local.TORUNI_BUILDER_CODE_PROBE;
  return {
  plugins: [react(), {
    name: "toruni-development-api",
    async configureServer(server) {
      const { handle } = await import("./server/app.ts");
      if (mode === "development" || mode === "wallet-preview") {
        const { startRoundWorker } = await import("./server/worker.ts");
        const stopWorker = startRoundWorker();
        server.httpServer?.once("close", () => { void stopWorker(); });
      }
      server.httpServer?.once("listening", () => {
        void import("./server/readiness.ts").then(async ({ checkReadiness }) => {
          console.info("Toruni development dependency check:", JSON.stringify(await checkReadiness()));
        });
        if (mode === "visual-review") {
          const address = server.httpServer?.address();
          if (address && typeof address !== "string") {
            void import("./scripts/visual-review.mjs").then(({ runVisualReview }) => runVisualReview(address.port))
              .catch(error => console.error("Toruni visual review failed:", error instanceof Error ? error.message : "Browser unavailable."));
          }
        }
        if (mode === "integration-check") {
          void import("./server/readiness.ts").then(async ({ checkOptionalL3 }) => console.info("Toruni optional L3 check:", JSON.stringify(await checkOptionalL3())));
          void import("./tests/postgres.integration.ts").then(async ({ runPostgresChecks }) => {
            console.info("Toruni Postgres integration checks:", JSON.stringify(await runPostgresChecks()));
          }).catch(error => console.error("Toruni Postgres integration checks failed:", error instanceof Error ? error.message : "Unknown failure."));
        }
      });
      server.middlewares.use((request, response, next) => {
        if (mode !== "wallet-preview" && !request.url?.startsWith("/api/")) { next(); return; }
        void handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Request could not be completed." }));
        });
      });
    },
  }],
  // Keep CSS intact when building from the offline cache. Its matching native
  // minifier archive is unavailable; this does not alter stylesheet semantics.
  build: { cssMinify: false },
  server: {
    ...(["wallet-preview", "visual-review", "integration-check"].includes(mode) ? { hmr: false, watch: null, strictPort: true } : {}),
    fs: { deny: ["**/.env", "**/.env.*", "**/.git/**", "**/.toruni/**", "**/*.md", "**/*.mdx", "**/server/**", "**/sql/**"] },
  },
  };
});
