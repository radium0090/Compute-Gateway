import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    }),
  );
  return nested.flat();
}

function localTarget(source: string, rawTarget: string): string | undefined {
  const target = rawTarget.trim().replace(/^<|>$/gu, '');
  if (target.startsWith('#') || /^(?:https?|mailto|tel|data):/u.test(target)) {
    return undefined;
  }
  const path = decodeURIComponent(target.split(/[?#]/u, 1)[0] ?? '');
  if (path.length === 0) return undefined;
  return path.startsWith('/')
    ? resolve(root, path.slice(1))
    : resolve(dirname(source), path);
}

const files = [
  resolve(root, 'README.md'),
  resolve(root, 'CHANGELOG.md'),
  resolve(root, 'CODE_OF_CONDUCT.md'),
  resolve(root, 'SECURITY.md'),
  ...(await markdownFiles(resolve(root, 'docs'))),
  ...(await markdownFiles(resolve(root, 'examples'))),
  resolve(root, 'sdk/typescript/README.md'),
  resolve(root, 'sdk/python/README.md'),
];
const broken: string[] = [];
for (const file of files.sort()) {
  const contents = await readFile(file, 'utf8');
  for (const match of contents.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1];
    if (rawTarget === undefined) continue;
    const target = localTarget(file, rawTarget);
    if (target === undefined) continue;
    const escapedRoot = relative(root, target);
    if (escapedRoot.startsWith(`..${sep}`) || escapedRoot === '..') {
      broken.push(
        `${relative(root, file)} -> ${rawTarget} (outside repository)`,
      );
      continue;
    }
    try {
      await stat(target);
    } catch {
      broken.push(`${relative(root, file)} -> ${rawTarget}`);
    }
  }
}

if (broken.length > 0) {
  throw new Error(`Broken local documentation links:\n${broken.join('\n')}`);
}
process.stdout.write(
  `documentation links valid (${String(files.length)} files)\n`,
);
