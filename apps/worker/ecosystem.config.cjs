// PM2 process file for running the watcher on an always-on server, from the repository root:
//   node --import tsx --env-file=.env packages/db/src/migrate-cli.ts
//   pm2 start apps/worker/ecosystem.config.cjs && pm2 save
// Configuration comes from the repository's .env (see .env.example). Node runs the TypeScript
// sources through tsx's loader directly, without the tsx CLI's extra process.
module.exports = {
  apps: [
    {
      name: "relaymesh-watcher",
      cwd: __dirname,
      script: "src/main.ts",
      interpreter: "node",
      // A capped heap makes V8 collect sooner instead of growing on a small shared server. Startup
      // (decoding chain metadata) peaks near 250 MB resident and settles around 170 MB.
      node_args: "--max-old-space-size=160 --import tsx --env-file-if-exists=../../.env",
      // Only for a real leak: restart well above the normal peak.
      max_memory_restart: "400M",
      exp_backoff_restart_delay: 1000,
      kill_timeout: 10000,
      time: true,
    },
  ],
};
