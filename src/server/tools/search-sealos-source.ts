import { readdir, readFile, realpath, stat } from 'fs/promises';
import * as path from 'path';
import { SearchToolResponse } from '../kubernetes/types';
import { SearchSealosSourceInputSchema } from './types';

const MAX_FILES = Number(process.env.AGENT_SOURCE_MAX_FILES ?? 1000);
const MAX_FILE_BYTES = Number(process.env.AGENT_SOURCE_MAX_FILE_BYTES ?? 300_000);
const MAX_SNIPPET_CHARS = Number(process.env.AGENT_SOURCE_SNIPPET_CHARS ?? 800);
const ALLOWED_EXTENSIONS = new Set(['.go', '.ts', '.tsx', '.js', '.yaml', '.yml', '.md', '.json']);
const SENSITIVE_PATH_PATTERN = /(kubeconfig|auth|secret|credential|token|\.env|id_rsa)/i;

export async function searchSealosSource(input: unknown): Promise<SearchToolResponse> {
  const { query, limit = 5, pathHint = '' } = SearchSealosSourceInputSchema.parse(input);
  const roots = getRoots(process.env.AGENT_SEALOS_SOURCE_ROOTS || process.env.AGENT_SEALOS_SOURCE_ROOT || '');
  if (roots.length === 0) {
    return { query, matches: [], total: 0, error: { reason: 'NotConfigured', message: 'Sealos source root is not configured' }, success: false };
  }
  const matches = [];
  for (const root of roots) {
    const files = await collectFiles(root, pathHint);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const index = content.toLowerCase().indexOf(query.toLowerCase());
      if (index < 0) {
        continue;
      }
      matches.push({
        root,
        path: path.relative(root, file),
        snippet: content.slice(Math.max(0, index - 160), index + MAX_SNIPPET_CHARS),
      });
      if (matches.length >= limit) {
        return { query, matches, total: matches.length, success: true };
      }
    }
  }
  return { query, matches, total: matches.length, success: true };
}

async function collectFiles(root: string, pathHint: string): Promise<string[]> {
  const out: string[] = [];
  let resolvedRoot: string;
  let startPath: string;
  try {
    resolvedRoot = await realpath(path.resolve(root));
    startPath = await realpath(path.resolve(resolvedRoot, pathHint));
  } catch {
    return out;
  }
  if (!isPathInsideRoot(startPath, resolvedRoot)) {
    return out;
  }
  await walk(startPath, resolvedRoot, out);
  return out.slice(0, MAX_FILES);
}

async function walk(current: string, root: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) {
    return;
  }
  const relative = path.relative(root, current);
  if (SENSITIVE_PATH_PATTERN.test(relative)) {
    return;
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(current, entry.name);
    let resolvedFullPath: string;
    try {
      resolvedFullPath = await realpath(fullPath);
    } catch {
      continue;
    }
    if (
      !isPathInsideRoot(resolvedFullPath, root) ||
      SENSITIVE_PATH_PATTERN.test(path.relative(root, resolvedFullPath))
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      await walk(resolvedFullPath, root, out);
      continue;
    }
    const info = await stat(resolvedFullPath);
    if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && info.size <= MAX_FILE_BYTES) {
      out.push(resolvedFullPath);
    }
  }
}

function isPathInsideRoot(targetPath: string, root: string): boolean {
  return targetPath === root || targetPath.startsWith(`${root}${path.sep}`);
}

function getRoots(raw: string): string[] {
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}
