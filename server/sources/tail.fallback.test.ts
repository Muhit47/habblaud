// FileTail with unhelpful stat: Linux without statx (WSL1, legacy seccomp) where Node returns ctime as
// birthtime, and a filesystem reusing inodes of deleted files (ext4). node:fs is mocked solely in
// this test file to simulate both behaviors portably.
import { appendFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/fixtures';
import { FileTail } from './tail';

const sim = vi.hoisted(() => ({ birthIsCtime: false, sameIno: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const fake = (st: Stats): Stats => {
    if (sim.birthIsCtime) st.birthtimeMs = st.ctimeMs;
    if (sim.sameIno) st.ino = 1;
    return st;
  };
  return { ...fs, fstatSync: (fd: number) => fake(fs.fstatSync(fd)), statSync: (path: string) => fake(fs.statSync(path)) };
});

/** Waits for filesystem clock progression (ext4 records timestamps in multi-millisecond ticks). */
const tick = () => new Promise((ok) => setTimeout(ok, 15));

describe('FileTail com stat que não ajuda', () => {
  let tmp: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    tmp = tempDir();
    file = join(tmp.dir, 'a.jsonl');
  });
  afterEach(() => {
    sim.birthIsCtime = false;
    sim.sameIno = false;
    tmp.cleanup();
  });

  it('Linux sem statx (birthtime = ctime): linhas acrescentadas não contam como troca', async () => {
    sim.birthIsCtime = true;
    writeFileSync(file, '{"a":1}\n');
    const t = new FileTail(file);
    t.seekTail(1024);
    expect(t.read().lines).toEqual(['{"a":1}']);
    for (const n of [2, 3]) {
      await tick();
      appendFileSync(file, `{"a":${n}}\n`);
      expect(t.read()).toMatchObject({ reset: false, lines: [`{"a":${n}}`] });
    }
  });

  it('inode reaproveitado: a troca aparece pelo começo do arquivo, com ou sem birthtime de verdade', async () => {
    sim.sameIno = true;
    // On NTFS, a file recreated under same name within 15s inherits deleted file birthtime ("tunneling"): with
    // identical simulated inode, FileTail has no means to detect replacement. There inodes do not collide (file ID changes),
    // so only the birthtime = ctime variant is tested.
    for (const birthIsCtime of process.platform === 'win32' ? [true] : [false, true]) {
      sim.birthIsCtime = birthIsCtime;
      writeFileSync(file, 'velho-1\n');
      const t = new FileTail(file);
      t.read();
      await tick();
      rmSync(file);
      writeFileSync(file, 'novo-1\nnovo-2\n');
      expect(t.read()).toMatchObject({ reset: true, lines: ['novo-1', 'novo-2'] });
    }
  });
});
