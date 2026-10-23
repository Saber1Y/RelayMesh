// PM2 process file for running the watcher on an always-on server:
//   corepack pnpm db:migrate && pm2 start apps/worker/ecosystem.config.cjs && pm2 save
// Configuration comes from the repository's .env (see .env.example). Node runs the TypeScript
// sources through tsx's loader directly, without the tsx CLI's extra process.
module.exports = {
  apps: [
    {
      name: "relaymesh-watcher",
      cwd: __dirname,
      script: "src/main.ts",
      interpreter: "node",
      node_args: "--import tsx --env-file-if-exists=../../.env",
      // Restart on a leak rather than squeeze other services on a small server; it normally uses about 75 MB.
      max_memory_restart: "250M",
      exp_backoff_restart_delay: 1000,
      kill_timeout: 10000,
      time: true,
    },
  ],
};
