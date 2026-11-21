const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const src = path.join(repoRoot, 'backend-node');
const dest = path.dirname(require.resolve('localminidrama-runtime/package.json'));

const dirsToCopy = require(path.join(src, 'package.json')).files;

if (!fs.existsSync(src)) {
  console.error('backend-node not found at', src);
  process.exit(1);
}

if (fs.realpathSync(dest) === fs.realpathSync(src)) throw new Error('desktop requires npm install-links=true');
fs.mkdirSync(dest, { recursive: true });

for (const dir of dirsToCopy) {
  const from = path.join(src, dir);
  const to = path.join(dest, dir);
  if (fs.existsSync(from)) {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

console.log('Updated packaged backend sources');
