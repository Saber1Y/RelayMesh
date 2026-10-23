// PM2 process file for serving the built web app on an always-on server behind a reverse proxy
// (Caddy terminates TLS). Build with `pnpm --filter @relaymesh/web build`, then from the repository root:
//   pm2 start apps/web/ecosystem.config.cjs && pm2 save
// Configuration comes from the repository's .env, which next.config.ts loads.
module.exports = {
  apps: [
    {
      name: "relaymesh-web",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      // Loopback only: the reverse proxy is the public entry point.
      args: "start --hostname 127.0.0.1 --port 3200",
      interpreter: "node",
      node_args: "--max-old-space-size=192",
      max_memory_restart: "450M",
      exp_backoff_restart_delay: 1000,
      kill_timeout: 10000,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
