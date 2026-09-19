// Decode a multi-frame zstd DSH session transcript into plain JSONL.
// Usage: node decode-session.mjs <in.zstd> <out.jsonl>
//
// Forensics tooling for the manager-crash investigation: a DSH session store
// keeps transcripts as concatenated zstd frames, one per appended chunk, which
// a single-shot decompressor rejects. Used to reconstruct what a session was
// doing right before the service tree died (see
// .agents/notes/implemented/bug-fix/2026-09-14-manager-crash-forensics-and-guard-startup-race.md).
// Decoded output contains full conversation content — keep it out of the repo.
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: node decode-session.mjs <in.zstd> <out.jsonl>');
  process.exit(2);
}

const buf = readFileSync(input);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const offsets = [];
let i = 0;
while ((i = buf.indexOf(MAGIC, i)) !== -1) {
  offsets.push(i);
  i += 4;
}

const chunks = [];
let pending = null;
let failed = 0;
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k];
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
  const slice = buf.subarray(start, end);
  const candidate = pending ? Buffer.concat([pending, slice]) : slice;
  try {
    chunks.push(zstdDecompressSync(candidate));
    pending = null;
  } catch {
    // Magic bytes inside compressed payload: merge with the next candidate.
    pending = candidate;
  }
}
if (pending) {
  try {
    chunks.push(zstdDecompressSync(pending));
  } catch {
    failed += 1;
  }
}

const text = Buffer.concat(chunks).toString('utf8');
writeFileSync(output, text);
const lines = text.split('\n').filter(Boolean);
console.error(
  `frames=${offsets.length} decoded=${chunks.length} failed=${failed} bytes=${text.length} lines=${lines.length}`,
);
