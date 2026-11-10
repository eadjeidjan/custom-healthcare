import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const target = process.env.API_PROXY_TARGET || "http://localhost:8210";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5310,
    strictPort: true,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        // keep Server-Sent Events flowing: no compression, no buffering
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("Accept-Encoding", "identity"));
          proxy.on("proxyRes", (res) => {
            if (String(res.headers["content-type"] || "").includes("text/event-stream")) {
              res.headers["cache-control"] = "no-cache";
              res.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
