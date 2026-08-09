import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // New builds take over as soon as they finish downloading rather than waiting for
      // every tab to close. Combined with the revisioned precache, this is what stops the
      // installed app getting stuck on an old build.
      registerType: "autoUpdate",
      injectRegister: "auto",

      // public/manifest.webmanifest is maintained by hand and already linked from
      // index.html; don't let the plugin generate a competing one.
      manifest: false,

      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        clientsClaim: true,
        skipWaiting: true,

        // Serve the app shell for navigations so the app opens without a connection.
        navigateFallback: "/index.html",
        // ...but never for the sync endpoint. Returning cached HTML there would hand the
        // client an HTML body where it expects JSON, surfacing as a confusing parse error
        // instead of an honest network failure.
        navigateFallbackDenylist: [/^\/\.netlify\//],

        runtimeCaching: [
          {
            // Sheets sync is live or nothing. A cached response here would show stale
            // tasks as though they were current, which is worse than being offline.
            urlPattern: /\/\.netlify\//,
            handler: "NetworkOnly",
          },
        ],
      },

      devOptions: {
        // Keep the service worker out of `npm run dev`; a stale precache during
        // development is pure confusion.
        enabled: false,
      },
    }),
  ],
});
