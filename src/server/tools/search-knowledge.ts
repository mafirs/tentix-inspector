import { readdir, readFile, realpath, stat } from 'fs/promises';
import * as path from 'path';
import { SearchToolResponse } from '../kubernetes/types';
import { SearchKnowledgeInputSchema } from './types';

const MAX_FILES = Number(process.env.AGENT_KNOWLEDGE_MAX_FILES ?? 500);
const MAX_FILE_BYTES = Number(process.env.AGENT_KNOWLEDGE_MAX_FILE_BYTES ?? 200_000);
const MAX_SNIPPET_CHARS = Number(process.env.AGENT_KNOWLEDGE_SNIPPET_CHARS ?? 600);
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);

type CollectedFiles = {
  root: string;
  files: string[];
  error?: string;
};

export async function searchKnowledge(input: unknown): Promise<SearchToolResponse> {
  const { query, limit = 5 } = SearchKnowledgeInputSchema.parse(input);
  const roots = getRoots(process.env.AGENT_KNOWLEDGE_ROOTS || process.env.AGENT_KNOWLEDGE_ROOT || '');
  if (roots.length === 0) {
    return { query, matches: [], total: 0, error: { reason: 'NotConfigured', message: 'knowledge root is not configured' }, success: false };
  }
  const matches = [];
  const rootErrors: string[] = [];
  for (const root of roots) {
    const collected = await collectFiles(root);
    if (collected.error) {
      rootErrors.push(collected.error);
      continue;
    }
    for (const file of collected.files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const index = content.toLowerCase().indexOf(query.toLowerCase());
      if (index < 0) {
        continue;
      }
      matches.push({
        root: collected.root,
        path: path.relative(collected.root, file),
        snippet: content.slice(Math.max(0, index - 120), index + MAX_SNIPPET_CHARS),
      });
      if (matches.length >= limit) {
        return { query, matches, total: matches.length, success: true };
      }
    }
  }
  if (rootErrors.length === roots.length) {
    return { query, matches: [], total: 0, error: { reason: 'RootUnavailable', message: 'knowledge root is not available' }, success: false };
  }
  return { query, matches, total: matches.length, success: true };
}

async function collectFiles(root: string): Promise<CollectedFiles> {
  const out: string[] = [];
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(path.resolve(root));
    await walk(resolvedRoot, out);
  } catch {
    return { root, files: [], error: 'knowledge root is not available' };
  }
  return { root: resolvedRoot, files: out.slice(0, MAX_FILES) };
}

async function walk(current: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) {
    return;
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, out);
      continue;
    }
    let info;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }
    if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && info.size <= MAX_FILE_BYTES) {
      out.push(fullPath);
    }
  }
}

function getRoots(raw: string): string[] {
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}
