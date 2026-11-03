import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const s3 = new S3Client({});
const Bucket = process.env.BUCKET;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNKS_PER_SHARE = 50;
// Lambda caps sync responses at 6 MB; base64 adds ~33%.
const PAGE_BUDGET_BYTES = 3 * 1024 * 1024;
const PAGE_MAX_KEYS = 50;
const ID_PATTERN = /^[0-9a-f]{32}$/;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const chunkKey = (id, seq) => `shares/${id}/chunks/${String(seq).padStart(8, '0')}`;
const metaKey = (id) => `shares/${id}/meta.json`;

function reply(statusCode, body) {
  if (body === undefined) return { statusCode };
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const error = (statusCode, message) => reply(statusCode, { statusCode, message });

async function readMeta(id) {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket, Key: metaKey(id) }));
    return JSON.parse(await object.Body.transformToString());
  } catch (cause) {
    if (cause.name === 'NoSuchKey') return null;
    throw cause;
  }
}

function isOwner(meta, headers) {
  const token = headers?.authorization?.replace(/^Bearer /, '');
  if (!token) return false;
  return timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(meta.writeTokenHash));
}

async function createShare() {
  const id = randomBytes(16).toString('hex');
  const writeToken = randomBytes(32).toString('base64url');
  const meta = { writeTokenHash: sha256(writeToken), createdAt: new Date().toISOString() };
  await s3.send(new PutObjectCommand({ Bucket, Key: metaKey(id), Body: JSON.stringify(meta), IfNoneMatch: '*' }));
  return reply(201, { id, writeToken });
}

async function putChunk(id, rawSeq, event, meta) {
  if (!isOwner(meta, event.headers)) return error(403, 'Forbidden');

  const seq = Number(rawSeq);
  if (!Number.isInteger(seq) || seq < 1) return error(422, 'Invalid seq');
  if (seq > MAX_CHUNKS_PER_SHARE) return error(413, 'Share size limit reached');

  const body = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8');
  if (!body.length || body.length > MAX_CHUNK_BYTES) return error(413, 'Invalid chunk size');

  try {
    await s3.send(new PutObjectCommand({ Bucket, Key: chunkKey(id, seq), Body: body, IfNoneMatch: '*' }));
    return reply(204);
  } catch (cause) {
    if (cause.name === 'PreconditionFailed' || cause.name === 'ConditionalRequestConflict') {
      return error(409, 'Chunk already exists');
    }
    throw cause;
  }
}

async function listChunks(id, rawAfter) {
  const after = Number(rawAfter ?? 0);
  if (!Number.isInteger(after) || after < 0) return error(422, 'Invalid after');

  const listing = await s3.send(new ListObjectsV2Command({
    Bucket, Prefix: `shares/${id}/chunks/`, StartAfter: chunkKey(id, after), MaxKeys: PAGE_MAX_KEYS,
  }));
  const available = listing.Contents ?? [];

  const selected = [];
  let pageBytes = 0;
  for (const object of available) {
    if (selected.length && pageBytes + object.Size > PAGE_BUDGET_BYTES) break;
    selected.push(object.Key);
    pageBytes += object.Size;
  }

  const chunks = await Promise.all(selected.map(async (Key) => {
    const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
    const data = Buffer.from(await object.Body.transformToByteArray()).toString('base64');
    return { seq: Number(Key.split('/').pop()), data };
  }));

  const hasMore = listing.IsTruncated || selected.length < available.length;
  return reply(200, { chunks, next: hasMore ? chunks.at(-1).seq : null });
}

async function deleteShare(id, event, meta) {
  if (!isOwner(meta, event.headers)) return error(403, 'Forbidden');

  // MAX_CHUNKS_PER_SHARE + meta stays under the 1000-key page, so one listing covers it.
  const listing = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `shares/${id}/` }));
  const Objects = (listing.Contents ?? []).map(({ Key }) => ({ Key }));
  if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects } }));
  return reply(204);
}

export async function handler(event) {
  if (event.routeKey === 'POST /shares') return createShare();

  const id = event.pathParameters?.id;
  if (!ID_PATTERN.test(id ?? '')) return error(404, 'Not Found');

  const meta = await readMeta(id);
  if (!meta) return error(404, 'Not Found');

  switch (event.routeKey) {
    case 'PUT /shares/{id}/chunks/{seq}': return putChunk(id, event.pathParameters.seq, event, meta);
    case 'GET /shares/{id}/chunks': return listChunks(id, event.queryStringParameters?.after);
    case 'DELETE /shares/{id}': return deleteShare(id, event, meta);
    default: return error(404, 'Not Found');
  }
}
