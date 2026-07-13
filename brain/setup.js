// brain/setup.js
//
// One-time setup. Run it once, answer three questions, and it writes the
// .env file for you. No hand-editing.
//
//   cd /var/www/becopenhagen-fleet/brain
//   node setup.js
//
// Your password is hashed immediately and only the hash is stored. The
// plaintext password is never written to disk and never leaves this machine.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENV_PATH = path.join(__dirname, '.env');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const onData = (char) => {
        char = String(char);
        if (['\n', '\r', '\u0004'].includes(char)) {
          process.stdin.removeListener('data', onData);
        } else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question);
        }
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

(async () => {
  console.log('\n  beCopenhagen Brain — setup\n  ' + '-'.repeat(30) + '\n');

  if (fs.existsSync(ENV_PATH)) {
    const overwrite = await ask('  .env already exists. Overwrite it? (y/N) ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\n  Left it alone. Nothing changed.\n');
      process.exit(0);
    }
    console.log('');
  }

  // 1. email
  let email = await ask('  1. Your login email [federico@becopenhagen.dk]: ');
  if (!email) email = 'federico@becopenhagen.dk';

  // 2. password -> hash
  let pw = '';
  while (pw.length < 8) {
    pw = await ask('  2. Choose a password (min 8 chars): ', { hidden: true });
    if (pw.length < 8) console.log('     Too short — try again.');
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  const passwordHash = salt.toString('hex') + ':' + key.toString('hex');

  // 3. anthropic key
  let apiKey = '';
  while (!apiKey.startsWith('sk-ant-')) {
    apiKey = await ask('  3. Anthropic API key (starts sk-ant-): ');
    if (!apiKey.startsWith('sk-ant-')) console.log("     That doesn't look right — it should start with sk-ant-");
  }

  // generated for you
  const sessionSecret = crypto.randomBytes(32).toString('hex');

  const env = `# Written by setup.js — do not commit this file.
BRAIN_PORT=3001
BRAIN_EMAIL=${email}
BRAIN_PASSWORD_HASH=${passwordHash}
BRAIN_SESSION_SECRET=${sessionSecret}
ANTHROPIC_API_KEY_REPORTS=${apiKey}
FLEET_DB=/var/www/becopenhagen-fleet/data/fleet.db
BRAIN_MODEL=claude-sonnet-5
`;

  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });

  console.log(`
  Done. Wrote .env (readable only by you).

  Your password was hashed and the plaintext discarded — it is not stored
  anywhere on disk.

  Now start it:

      pm2 start ecosystem.config.js
      pm2 save

  Then open the brain in your browser and log in as ${email}.
`);
})();
