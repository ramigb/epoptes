#!/usr/bin/env node
// Launcher: runs the TypeScript source in a git checkout (Node strips the types), or the compiled dist/ in a package.
import fs from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`epoptes needs Node.js 22.18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
const src = new URL('../src/cli.ts', import.meta.url);
await import(fs.existsSync(src) ? src.href : new URL('../dist/cli.js', import.meta.url).href);
