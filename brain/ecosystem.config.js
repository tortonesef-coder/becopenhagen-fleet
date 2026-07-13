// pm2 config for the brain — a SEPARATE process from the fleet app.
// If the brain crashes, bc-fleet is unaffected.
module.exports = {
  apps: [{
    name: 'bc-brain',
    script: 'server.js',
    cwd: '/var/www/becopenhagen-fleet/brain',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
  }],
};
