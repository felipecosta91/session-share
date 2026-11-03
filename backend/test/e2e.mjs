// End-to-end: real handler behind a local HTTP server, S3 replaced by an in-memory store,
// plugin hooks run as child processes with isolated HOME dirs for owner and viewer.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '../../plugin/bin/ss.mjs');

const objects = new Map();
const s3Error = (name) => Object.assign(new Error(name), { name });

S3Client.prototype.send = async function send(command) {
  const input = command.input;
  if (command instanceof PutObjectCommand) {
    if (input.IfNoneMatch === '*' && objects.has(input.Key)) throw s3Error('PreconditionFailed');
    objects.set(input.Key, Buffer.from(input.Body));
    return {};
  }
  if (command instanceof GetObjectCommand) {
    const body = objects.get(input.Key);
    if (!body) throw s3Error('NoSuchKey');
    return { Body: { transformToString: async () => body.toString('utf8'), transformToByteArray: async () => new Uint8Array(body) } };
  }
  if (command instanceof ListObjectsV2Command) {
    const keys = [...objects.keys()].filter((key) => key.startsWith(input.Prefix) && (!input.StartAfter || key > input.StartAfter)).sort();
    const limit = input.MaxKeys ?? 1000;
    return { Contents: keys.slice(0, limit).map((Key) => ({ Key, Size: objects.get(Key).length })), IsTruncated: keys.length > limit };
  }
  if (command instanceof DeleteObjectsCommand) {
    input.Delete.Objects.forEach(({ Key }) => objects.delete(Key));
    return {};
  }
  throw new Error(`unexpected command ${command.constructor.name}`);
};

process.env.BUCKET = 'test-bucket';
const { handler } = await import('../src/handler.mjs');

const ROUTES = [
  ['POST', /^\/shares$/, 'POST /shares', []],
  ['PUT', /^\/shares\/([^/]+)\/chunks\/([^/]+)$/, 'PUT /shares/{id}/chunks/{seq}', ['id', 'seq']],
  ['GET', /^\/shares\/([^/]+)\/chunks$/, 'GET /shares/{id}/chunks', ['id']],
  ['DELETE', /^\/shares\/([^/]+)$/, 'DELETE /shares/{id}', ['id']],
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const route = ROUTES.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
  if (!route) return response.writeHead(404).end();

  const [, pattern, routeKey, names] = route;
  const values = pattern.exec(url.pathname).slice(1);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  const result = await handler({
    routeKey,
    headers: request.headers,
    pathParameters: Object.fromEntries(names.map((name, index) => [name, values[index]])),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: Buffer.concat(chunks).toString('base64'),
    isBase64Encoded: true,
  });
  response.writeHead(result.statusCode, result.headers).end(result.body);
});
await new Promise((resolve) => server.listen(0, resolve));
const API_URL = `http://127.0.0.1:${server.address().port}`;

function runHook(hook, input, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, hook], { env: { ...process.env, HOME: home, SESSION_SHARE_API_URL: API_URL } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null }));
    child.stdin.end(JSON.stringify(input));
  });
}

const encodeProjectDir = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// Owner
const ownerHome = mkdtempSync(join(tmpdir(), 'ss-owner-'));
const ownerCwd = mkdtempSync(join(tmpdir(), 'ss-owner-proj-'));
const ownerSessionId = randomUUID();
const transcriptPath = join(ownerHome, '.claude', 'projects', encodeProjectDir(ownerCwd), `${ownerSessionId}.jsonl`);
mkdirSync(dirname(transcriptPath), { recursive: true });

// Real transcripts carry usage counters whose keys match the generic "token" secret pattern.
const USAGE = { input_tokens: 123456, output_tokens: 654321, cache_read_input_tokens: 9999999 };
const entry = (type, content) => `${JSON.stringify({ type, sessionId: ownerSessionId, cwd: ownerCwd, message: { role: type, content, usage: USAGE } })}\n`;
const ownerInput = (prompt) => ({ session_id: ownerSessionId, transcript_path: transcriptPath, cwd: ownerCwd, prompt });

writeFileSync(transcriptPath, entry('user', 'minha chave é sk-abcdefghijklmnopqrstuvwxyz123456 e password=hunter2secret'));
appendFileSync(transcriptPath, entry('assistant', [{ type: 'text', text: 'primeira resposta' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]));

const shared = await runHook('prompt', ownerInput('/share-session'), ownerHome);
assert.equal(shared.json.decision, 'block', shared.stderr);
const link = /\/join-session (\S+)/.exec(shared.json.reason)[1];

const sharedAgain = await runHook('prompt', ownerInput('/session-share:share-session'), ownerHome);
assert.match(sharedAgain.json.reason, /já está compartilhada/);

// 5 MB of 2-byte chars: forces multiple chunks, pagination, and chunk splits inside a character.
const bigText = 'é'.repeat(2.5 * 1024 * 1024);
appendFileSync(transcriptPath, entry('assistant', [{ type: 'text', text: bigText }]));
appendFileSync(transcriptPath, entry('user', 'segunda pergunta'));
const pushed = await runHook('push', ownerInput(), ownerHome);
assert.equal(pushed.stderr, '');

// Viewer
const viewerHome = mkdtempSync(join(tmpdir(), 'ss-viewer-'));
const viewerCwd = mkdtempSync(join(tmpdir(), 'ss-viewer-proj-'));
const viewerInput = (sessionId, prompt) => ({ session_id: sessionId, transcript_path: '/dev/null', cwd: viewerCwd, prompt });

const joined = await runHook('prompt', viewerInput(randomUUID(), `/join-session ${link}`), viewerHome);
assert.equal(joined.json.decision, 'block', joined.stderr);
const viewerSessionId = /claude --resume (\S+)/.exec(joined.json.reason)[1];

const importedPath = join(viewerHome, '.claude', 'projects', encodeProjectDir(viewerCwd), `${viewerSessionId}.jsonl`);
const imported = readFileSync(importedPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.equal(imported.length, 4);
assert.ok(imported.every((line) => line.sessionId === viewerSessionId && line.cwd === viewerCwd));
assert.equal(imported[2].message.content[0].text, bigText);
assert.doesNotMatch(JSON.stringify(imported), /sk-abcdef|hunter2secret/);
assert.match(imported[0].message.content, /password=\[REDACTED\]/);
assert.deepEqual(imported[0].message.usage, USAGE);

// Incremental updates; the trailing incomplete line must wait until it is complete.
appendFileSync(transcriptPath, entry('assistant', [{ type: 'text', text: 'terceira resposta' }]));
appendFileSync(transcriptPath, entry('user', 'quarta').slice(0, 20));
await runHook('push', ownerInput(), ownerHome);

const update = await runHook('prompt', viewerInput(viewerSessionId, 'o que mudou?'), viewerHome);
const context = update.json.hookSpecificOutput.additionalContext;
assert.match(context, /terceira resposta/);
assert.doesNotMatch(context, /primeira resposta|quarta/);

const noUpdate = await runHook('prompt', viewerInput(viewerSessionId, 'e agora?'), viewerHome);
assert.equal(noUpdate.stdout, '');

appendFileSync(transcriptPath, entry('user', 'quarta').slice(20));
await runHook('push', ownerInput(), ownerHome);
const completed = await runHook('prompt', viewerInput(viewerSessionId, 'e agora?'), viewerHome);
assert.match(completed.json.hookSpecificOutput.additionalContext, /user: quarta/);

// Unrelated sessions are untouched.
const unrelated = await runHook('prompt', viewerInput(randomUUID(), 'oi'), viewerHome);
assert.equal(unrelated.stdout, '');
assert.equal(unrelated.stderr, '');

// Viewer has no write access.
const shareId = link.split('.')[0];
const forged = await fetch(`${API_URL}/shares/${shareId}/chunks/99`, { method: 'PUT', body: 'x', headers: { authorization: 'Bearer forged' } });
assert.equal(forged.status, 403);
assert.equal((await fetch(`${API_URL}/shares/${shareId}`, { method: 'DELETE' })).status, 403);

// Server only ever sees ciphertext.
const stored = [...objects.entries()].filter(([key]) => key.includes('/chunks/')).map(([, body]) => body.toString('latin1')).join('');
assert.doesNotMatch(stored, /primeira resposta|terceira resposta/);

// Revocation
const revoked = await runHook('prompt', ownerInput('/unshare-session'), ownerHome);
assert.match(revoked.json.reason, /revogado/);
assert.ok(!existsSync(join(ownerHome, '.claude', 'session-share', `share-${ownerSessionId}.json`)));
assert.equal((await fetch(`${API_URL}/shares/${shareId}/chunks`)).status, 404);

const afterRevoke = await runHook('prompt', viewerInput(viewerSessionId, 'oi'), viewerHome);
assert.equal(afterRevoke.code, 0);
assert.match(afterRevoke.stderr, /revogado/);

const badLink = await runHook('prompt', viewerInput(randomUUID(), '/join-session abc"$(touch /tmp/pwned)"'), viewerHome);
assert.match(badLink.json.reason, /link inválido/);

server.close();
console.log('e2e ok');
