// Resolve paths before ego's stdin runtime discards cwd/environment; use a local test origin.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const name = process.argv[2];
if (!['e2e-answer.mjs', 'e2e-image-compress.mjs'].includes(name)) throw new Error('Unknown browser test');
const source = readFileSync(new URL(name, import.meta.url), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html><head><title>YuketangStudio test fixture</title></head><body><div id="app"></div></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/?ykt_test=1`;
try {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
  child.stdin.end(`globalThis.__YKS_ROOT__ = ${JSON.stringify(root)};\nglobalThis.__YKS_FIXTURE_URL__ = ${JSON.stringify(fixtureUrl)};\n` + source);
  process.exitCode = await done;
} finally { server.closeAllConnections(); server.close(); }
