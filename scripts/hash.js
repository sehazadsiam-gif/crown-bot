import bcrypt from 'bcryptjs';

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash -- "your-password"');
  process.exit(1);
}
if (pw.length < 10) console.warn('Warning: use at least 10 characters.\n');

console.log('\nPaste this into .env as ADMIN_PASSWORD_HASH:\n');
console.log(bcrypt.hashSync(pw, 12) + '\n');
