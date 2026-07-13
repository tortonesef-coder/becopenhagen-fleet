// brain/hash-password.js
//
// Run this ON THE VPS to generate the password hash for your .env.
// Your password is never stored in plaintext, never committed, and never
// leaves the machine.
//
//   node hash-password.js
//
// It prompts for a password (hidden), prints one line to paste into .env.

const crypto = require('crypto');
const readline = require('readline');

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Hide the typed characters.
    const onData = (char) => {
      char = char + '';
      if (['\n', '\r', '\u0004'].includes(char)) {
        process.stdin.removeListener('data', onData);
      } else {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const pw = await prompt('New brain password: ');
  if (!pw || pw.length < 8) {
    console.error('\nPassword must be at least 8 characters. Nothing written.');
    process.exit(1);
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  const hash = salt.toString('hex') + ':' + key.toString('hex');

  console.log('\nAdd this line to brain/.env :\n');
  console.log('BRAIN_PASSWORD_HASH=' + hash);
  console.log('\n(The password itself is not stored anywhere.)');
})();
