// Packaging a build's output as a checksummed .tar.gz.
//
// Written here rather than pulled from a dependency: it is ~60 lines of the
// POSIX ustar format, and the artifact is what the customer downloads, so its
// bytes should come from code this repository can read end to end.
//
// Deterministic: entries sorted, fixed mtime and owner, so the same output
// always packages to the same checksum and a re-run that changed nothing is
// visibly identical.
import { gunzipSync, gzipSync } from 'node:zlib';

export interface TarEntry {
  path: string;
  data: Buffer;
}

const BLOCK = 512;
const FIXED_MTIME = 0;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long to package: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder
  h.write('0', 156, 1, 'ascii'); // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

export function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    parts.push(header(e.path, e.data.length), e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Lists what a .tar.gz contains. Used by verification to check the artifact, not trust it. */
export function listTarGz(archive: Buffer): { path: string; size: number }[] {
  const tar = gunzipSync(archive);
  const out: { path: string; size: number }[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    out.push({ path: name, size });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/**
 * Unpacks a .tar.gz made by tarGz (regular files, ustar). Anything else —
 * links, devices, directories, unsafe or absolute names — is refused whole,
 * because an archive coming back from a build container is untrusted.
 */
export function extractTarGz(archive: Buffer, { maxBytes = 200_000_000 } = {}): TarEntry[] {
  const tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  const out: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const type = String.fromCharCode(h[156] || 48);
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    if (type !== '0') throw new Error(`The archive holds something other than a regular file: ${name}`);
    if (!Number.isFinite(size) || size < 0 || offset + BLOCK + size > tar.length) throw new Error('The archive is truncated.');
    const full = prefix ? `${prefix}/${name}` : name;
    out.push({ path: full, data: Buffer.from(tar.subarray(offset + BLOCK, offset + BLOCK + size)) });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
