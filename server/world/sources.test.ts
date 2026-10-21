// Files stored as exact copies on Habblaud World server (protocol.ts and city.ts, with SHA-256 verified
// there) have zero dependencies and use neither Node nor DOM: copied byte-for-byte, they compile on the other side. Kept here
// (rather than alongside in shared/) because disk access is required.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'world', file), 'utf8');

describe('arquivos copiados para o servidor do mundo', () => {
  for (const file of ['protocol.ts', 'city.ts']) {
    it(`${file}: sem imports, sem Node nem DOM, com o aviso no topo`, () => {
      const src = read(file);
      expect(src).not.toMatch(/^\s*import\s/m);
      expect(src).not.toMatch(/\brequire\(|\bprocess\.|\bwindow\.|\bdocument\./);
      expect(src.startsWith('// AVISO')).toBe(true);
    });
  }
});
