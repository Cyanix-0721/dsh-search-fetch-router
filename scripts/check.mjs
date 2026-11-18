// Syntax-check every shipped source file.
//
// Walks index.js plus whatever is in lib/ at run time, so a newly added
// lib/*.js is covered without editing a hand-written list (the old list made it
// easy to add a file and silently skip it — the exact failure this check exists
// to prevent).
//
// Cross-platform: no shell glob or `for`-loop, so `npm run check` behaves the
// same under Windows cmd, PowerShell and POSIX sh. Each file is checked with the
// same node process that runs this script.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = [
  'index.js',
  ...readdirSync('lib')
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => `lib/${name}`),
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`check ok (${files.length} files)`);
