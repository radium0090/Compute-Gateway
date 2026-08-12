import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = new URL('../', import.meta.url);
const historicalAdr = /^docs\/adr\/(?:000[1-9]|001[0-2])-.*\.md$/u;
const retiredIdentifiers = [
  {
    label: 'former product name',
    pattern: new RegExp(['gen', 'chi'].join(''), 'iu'),
  },
  {
    label: 'former short prefix',
    pattern: new RegExp(['g', 'ch_'].join(''), 'u'),
  },
] as const;

const { stdout } = await execFileAsync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root },
);
const violations: string[] = [];

for (const path of stdout.split('\0').filter(Boolean).sort()) {
  if (historicalAdr.test(path)) continue;
  let contents: Buffer;
  try {
    contents = await readFile(new URL(path, root));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  if (contents.includes(0)) continue;
  const source = contents.toString('utf8');
  for (const identifier of retiredIdentifiers) {
    if (identifier.pattern.test(path) || identifier.pattern.test(source)) {
      violations.push(`${path}: ${identifier.label}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `Retired product identifiers found outside historical ADRs:\n${violations.join('\n')}`,
  );
}

process.stdout.write('product identity valid\n');
