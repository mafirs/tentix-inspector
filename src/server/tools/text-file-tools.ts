import { execFile } from 'child_process';
import { readdir, readFile, realpath, stat } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { SearchResultMatch, SearchToolResponse } from '../kubernetes/types';
import {
  ListTextFilesInputSchema,
  ReadTextSliceInputSchema,
  SearchTextInputSchema,
  TextRootType,
} from './types';

const execFileAsync = promisify(execFile);

const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_READ_LINE_COUNT = 120;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_TERMS = 24;
const RG_TIMEOUT_MS = Number(process.env.AGENT_TEXT_SEARCH_RG_TIMEOUT_MS ?? 5_000);
const RG_MAX_BUFFER = Number(process.env.AGENT_TEXT_SEARCH_RG_MAX_BUFFER ?? 1_000_000);
const NODE_FALLBACK_MAX_FILES = Number(process.env.AGENT_TEXT_SEARCH_NODE_MAX_FILES ?? 5_000);
const NODE_FALLBACK_TIMEOUT_MS = Number(process.env.AGENT_TEXT_SEARCH_NODE_TIMEOUT_MS ?? 20_000);
const SENSITIVE_PATH_PATTERN = /(kubeconfig|secret|credential|token|\.env|id_rsa)/i;
const KNOWLEDGE_EXTENSIONS = new Set(['.md', '.txt']);
const SOURCE_EXTENSIONS = new Set(['.go', '.ts', '.tsx', '.js', '.yaml', '.yml', '.md', '.json']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  '问题',
  '一直',
  '今天',
  '几次',
  '这个',
  '那个',
]);
const DOMAIN_TERMS = [
  '公网',
  '外网',
  '域名',
  '地址',
  '准备中',
  '网络',
  '分配',
  '应用',
  '部署',
  '访问',
  '入口',
  '网关',
  '证书',
  '数据库',
  '备份',
  '实例',
  '配额',
  '欠费',
  'devbox',
  'ingress',
  'service',
  'endpoint',
  'loadbalancer',
];

type RootConfig = {
  rootType: TextRootType;
  roots: string[];
  allowedExtensions: Set<string>;
  maxFiles: number;
  maxFileBytes: number;
  maxSnippetChars: number;
};

type ResolvedStart = {
  root: string;
  startPath: string;
};

type FileCandidate = {
  root: string;
  file: string;
};

type ScoredMatch = SearchResultMatch & {
  score: number;
};

type NodeFallbackBudget = {
  startedAt: number;
  maxFiles: number;
  maxRuntimeMs: number;
  filesScanned: number;
  stoppedReason?: 'max_files' | 'timeout';
};

type NodeFallbackResult = {
  matches: ScoredMatch[];
  filesScanned: number;
  stoppedReason?: 'max_files' | 'timeout';
};

export async function searchText(input: unknown): Promise<SearchToolResponse> {
  const { rootType, query, limit = DEFAULT_SEARCH_LIMIT, pathHint = '', contextLines = DEFAULT_CONTEXT_LINES, fileGlobs } = SearchTextInputSchema.parse(input);
  const config = getRootConfig(rootType);
  const terms = extractSearchTerms(query);
  const startedAt = Date.now();
  console.error(`[Server] Executing: search_text rootType=${rootType} roots=${config.roots.length} limit=${limit} pathHintSet=${Boolean(pathHint)} queryChars=${query.length} terms=${terms.join(',')}`);

  if (config.roots.length === 0) {
    console.error(`[Server] search_text result: error rootType=${rootType} reason=NotConfigured total=0 elapsedMs=${Date.now() - startedAt}`);
    return { query, matches: [], total: 0, error: { reason: 'NotConfigured', message: `${rootType} root is not configured` }, success: false };
  }

  const resolved = await resolveStarts(config, pathHint);
  if (resolved.starts.length === 0) {
    const reason = resolved.errors.some((error) => error.includes('outside configured root')) ? 'PathOutsideRoot' : 'RootUnavailable';
    console.error(`[Server] search_text result: error rootType=${rootType} reason=${reason} total=0 elapsedMs=${Date.now() - startedAt}`);
    return { query, matches: [], total: 0, error: { reason, message: resolved.errors[0] ?? `${rootType} root is not available` }, success: false };
  }

  const matches: ScoredMatch[] = [];
  let backend = 'rg';
  let fallbackFilesScanned = 0;
  let fallbackStoppedReason: NodeFallbackResult['stoppedReason'];
  for (const start of resolved.starts) {
    let scored = await collectRgCandidates(start, config, terms, fileGlobs)
      .then((candidates) => candidates ? scoreCandidates(candidates, query, terms, contextLines, config) : undefined);
    if (!scored) {
      backend = 'node_fs';
      const fallback = await searchWithNodeFs(start.startPath, start.root, config, query, terms, contextLines, fileGlobs);
      scored = fallback.matches;
      fallbackFilesScanned += fallback.filesScanned;
      fallbackStoppedReason = fallbackStoppedReason ?? fallback.stoppedReason;
    }
    matches.push(...scored);
  }

  matches.sort((left, right) => right.score - left.score);
  const limited = matches.slice(0, limit).map(({ score: _score, ...match }) => match);
  const fallbackSuffix = backend === 'node_fs' ? ` fallbackFilesScanned=${fallbackFilesScanned}${fallbackStoppedReason ? ` fallbackStoppedReason=${fallbackStoppedReason}` : ''}` : '';
  console.error(`[Server] search_text result: ${limited.length === 0 ? 'no_data' : 'success'} rootType=${rootType} backend=${backend}${fallbackSuffix} total=${limited.length} elapsedMs=${Date.now() - startedAt}`);
  return { query, matches: limited, total: limited.length, success: true };
}

export async function readTextSlice(input: unknown): Promise<Record<string, unknown>> {
  const { rootType, path: requestedPath, startLine = 1, lineCount = DEFAULT_READ_LINE_COUNT } = ReadTextSliceInputSchema.parse(input);
  const config = getRootConfig(rootType);
  const startedAt = Date.now();
  console.error(`[Server] Executing: read_text_slice rootType=${rootType} path=${requestedPath} startLine=${startLine} lineCount=${lineCount}`);
  const resolved = await resolveFile(config, requestedPath);
  if (!resolved.file) {
    console.error(`[Server] read_text_slice result: error rootType=${rootType} reason=${resolved.reason} elapsedMs=${Date.now() - startedAt}`);
    return { rootType, path: requestedPath, error: { reason: resolved.reason, message: resolved.message }, success: false };
  }

  const content = await readFile(resolved.file, 'utf8');
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, startLine - 1);
  const selected = lines.slice(startIndex, startIndex + lineCount);
  console.error(`[Server] read_text_slice result: success rootType=${rootType} path=${path.relative(resolved.root, resolved.file)} lines=${selected.length} elapsedMs=${Date.now() - startedAt}`);
  return {
    rootType,
    root: resolved.root,
    path: path.relative(resolved.root, resolved.file),
    startLine: startIndex + 1,
    lineCount: selected.length,
    totalLines: lines.length,
    content: selected.join('\n'),
    success: true,
  };
}

export async function listTextFiles(input: unknown): Promise<Record<string, unknown>> {
  const { rootType, pathHint = '', extensions, limit = 50 } = ListTextFilesInputSchema.parse(input);
  const config = getRootConfig(rootType);
  const startedAt = Date.now();
  console.error(`[Server] Executing: list_text_files rootType=${rootType} roots=${config.roots.length} pathHintSet=${Boolean(pathHint)} limit=${limit}`);
  if (config.roots.length === 0) {
    console.error(`[Server] list_text_files result: error rootType=${rootType} reason=NotConfigured total=0 elapsedMs=${Date.now() - startedAt}`);
    return { rootType, files: [], total: 0, error: { reason: 'NotConfigured', message: `${rootType} root is not configured` }, success: false };
  }

  const resolved = await resolveStarts(config, pathHint);
  const extensionSet = extensions ? new Set(extensions.map((item) => item.toLowerCase())) : config.allowedExtensions;
  const files: Array<{ root: string; path: string }> = [];
  for (const start of resolved.starts) {
    const candidates = await collectFiles(start.startPath, start.root, { ...config, allowedExtensions: extensionSet }, undefined);
    for (const candidate of candidates) {
      files.push({ root: candidate.root, path: path.relative(candidate.root, candidate.file) });
      if (files.length >= limit) {
        break;
      }
    }
    if (files.length >= limit) {
      break;
    }
  }

  console.error(`[Server] list_text_files result: ${files.length === 0 ? 'no_data' : 'success'} rootType=${rootType} total=${files.length} elapsedMs=${Date.now() - startedAt}`);
  return { rootType, files, total: files.length, success: true };
}

function getRootConfig(rootType: TextRootType): RootConfig {
  const rawRoots =
    rootType === 'knowledge'
      ? process.env.AGENT_KNOWLEDGE_ROOTS || process.env.AGENT_KNOWLEDGE_ROOT || ''
      : process.env.AGENT_SEALOS_SOURCE_ROOTS || process.env.AGENT_SEALOS_SOURCE_ROOT || '';
  return {
    rootType,
    roots: splitRoots(rawRoots),
    allowedExtensions: rootType === 'knowledge' ? KNOWLEDGE_EXTENSIONS : SOURCE_EXTENSIONS,
    maxFiles: Number(rootType === 'knowledge' ? process.env.AGENT_KNOWLEDGE_MAX_FILES ?? 500 : process.env.AGENT_SOURCE_MAX_FILES ?? 1000),
    maxFileBytes: Number(rootType === 'knowledge' ? process.env.AGENT_KNOWLEDGE_MAX_FILE_BYTES ?? 200_000 : process.env.AGENT_SOURCE_MAX_FILE_BYTES ?? 300_000),
    maxSnippetChars: Number(rootType === 'knowledge' ? process.env.AGENT_KNOWLEDGE_SNIPPET_CHARS ?? 600 : process.env.AGENT_SOURCE_SNIPPET_CHARS ?? 800),
  };
}

async function resolveStarts(config: RootConfig, pathHint: string): Promise<{ starts: ResolvedStart[]; errors: string[] }> {
  const starts: ResolvedStart[] = [];
  const errors: string[] = [];
  for (const rawRoot of config.roots) {
    try {
      const root = await realpath(path.resolve(rawRoot));
      const requestedPath = pathHint ? (path.isAbsolute(pathHint) ? pathHint : path.resolve(root, pathHint)) : root;
      const startPath = await realpath(requestedPath);
      if (!isPathInsideRoot(startPath, root)) {
        errors.push('pathHint is outside configured root');
        continue;
      }
      starts.push({ root, startPath });
    } catch {
      errors.push(`${config.rootType} root or pathHint is not available`);
    }
  }
  return { starts, errors };
}

async function resolveFile(config: RootConfig, requestedPath: string): Promise<{ root: string; file?: string; reason?: string; message?: string }> {
  for (const rawRoot of config.roots) {
    try {
      const root = await realpath(path.resolve(rawRoot));
      const candidate = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(root, requestedPath);
      const file = await realpath(candidate);
      if (!isPathInsideRoot(file, root)) {
        return { root, reason: 'PathOutsideRoot', message: 'path is outside configured root' };
      }
      if (isSensitivePath(root, file)) {
        return { root, reason: 'SensitivePath', message: 'path is not readable by this tool' };
      }
      const info = await stat(file);
      if (!info.isFile()) {
        return { root, reason: 'NotFile', message: 'path is not a file' };
      }
      if (!isAllowedFile(file, info.size, config)) {
        return { root, reason: 'UnsupportedFile', message: 'file extension or size is not allowed' };
      }
      return { root, file };
    } catch {
      continue;
    }
  }
  return { root: '', reason: 'NotFound', message: 'file is not available under configured roots' };
}

async function collectRgCandidates(start: ResolvedStart, config: RootConfig, terms: string[], fileGlobs: string[] | undefined): Promise<FileCandidate[] | undefined> {
  const args = [
    '--files-with-matches',
    '--ignore-case',
    '--fixed-strings',
    '--color',
    'never',
  ];
  for (const glob of buildGlobs(config, fileGlobs)) {
    args.push('--glob', glob);
  }
  for (const term of terms) {
    args.push('-e', term);
  }
  args.push(start.startPath);

  try {
    const { stdout } = await execFileAsync('rg', args, { timeout: RG_TIMEOUT_MS, maxBuffer: RG_MAX_BUFFER });
    return String(stdout)
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((file) => ({ root: start.root, file }));
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 1) {
      return [];
    }
    if (code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

async function collectFiles(current: string, root: string, config: RootConfig, fileGlobs: string[] | undefined): Promise<FileCandidate[]> {
  const out: FileCandidate[] = [];
  const seenDirs = new Set<string>();
  await walk(current, root, config, buildExtensionSet(config, fileGlobs), out, seenDirs);
  return out.slice(0, config.maxFiles);
}

async function searchWithNodeFs(
  current: string,
  root: string,
  config: RootConfig,
  query: string,
  terms: string[],
  contextLines: number,
  fileGlobs: string[] | undefined
): Promise<NodeFallbackResult> {
  const matches: ScoredMatch[] = [];
  const seenDirs = new Set<string>();
  const budget: NodeFallbackBudget = {
    startedAt: Date.now(),
    maxFiles: NODE_FALLBACK_MAX_FILES,
    maxRuntimeMs: NODE_FALLBACK_TIMEOUT_MS,
    filesScanned: 0,
  };
  await walkAndScore(current, root, config, buildExtensionSet(config, fileGlobs), query, terms, contextLines, matches, seenDirs, budget);
  return { matches, filesScanned: budget.filesScanned, stoppedReason: budget.stoppedReason };
}

async function walk(current: string, root: string, config: RootConfig, allowedExtensions: Set<string>, out: FileCandidate[], seenDirs: Set<string>): Promise<void> {
  if (out.length >= config.maxFiles) {
    return;
  }
  let resolvedCurrent: string;
  let info;
  try {
    resolvedCurrent = await realpath(current);
    info = await stat(resolvedCurrent);
  } catch {
    return;
  }
  if (!isPathInsideRoot(resolvedCurrent, root) || isSensitivePath(root, resolvedCurrent)) {
    return;
  }
  if (info.isFile()) {
    if (allowedExtensions.has(path.extname(resolvedCurrent).toLowerCase()) && info.size <= config.maxFileBytes) {
      out.push({ root, file: resolvedCurrent });
    }
    return;
  }
  if (!info.isDirectory() || seenDirs.has(resolvedCurrent)) {
    return;
  }
  seenDirs.add(resolvedCurrent);
  const entries = await readdir(resolvedCurrent, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    await walk(path.join(resolvedCurrent, entry.name), root, config, allowedExtensions, out, seenDirs);
    if (out.length >= config.maxFiles) {
      return;
    }
  }
}

async function walkAndScore(
  current: string,
  root: string,
  config: RootConfig,
  allowedExtensions: Set<string>,
  query: string,
  terms: string[],
  contextLines: number,
  matches: ScoredMatch[],
  seenDirs: Set<string>,
  budget: NodeFallbackBudget
): Promise<void> {
  if (budget.stoppedReason) {
    return;
  }
  if (Date.now() - budget.startedAt >= budget.maxRuntimeMs) {
    budget.stoppedReason = 'timeout';
    return;
  }
  let resolvedCurrent: string;
  let info;
  try {
    resolvedCurrent = await realpath(current);
    info = await stat(resolvedCurrent);
  } catch {
    return;
  }
  if (!isPathInsideRoot(resolvedCurrent, root) || isSensitivePath(root, resolvedCurrent)) {
    return;
  }
  if (info.isFile()) {
    if (!allowedExtensions.has(path.extname(resolvedCurrent).toLowerCase()) || info.size > config.maxFileBytes) {
      return;
    }
    if (budget.filesScanned >= budget.maxFiles) {
      budget.stoppedReason = 'max_files';
      return;
    }
    budget.filesScanned += 1;
    const scored = await scoreFile(root, resolvedCurrent, query, terms, contextLines, config);
    if (scored) {
      matches.push(scored);
    }
    return;
  }
  if (!info.isDirectory() || seenDirs.has(resolvedCurrent)) {
    return;
  }
  seenDirs.add(resolvedCurrent);
  const entries = await readdir(resolvedCurrent, { withFileTypes: true });
  for (const entry of entries) {
    if (budget.stoppedReason) {
      return;
    }
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    await walkAndScore(path.join(resolvedCurrent, entry.name), root, config, allowedExtensions, query, terms, contextLines, matches, seenDirs, budget);
  }
}

async function scoreCandidates(candidates: FileCandidate[], query: string, terms: string[], contextLines: number, config: RootConfig): Promise<ScoredMatch[]> {
  const matches: ScoredMatch[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.root}:${candidate.file}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      const info = await stat(candidate.file);
      if (!isAllowedFile(candidate.file, info.size, config) || isSensitivePath(candidate.root, candidate.file)) {
        continue;
      }
      const scored = await scoreFile(candidate.root, candidate.file, query, terms, contextLines, config);
      if (scored) {
        matches.push(scored);
      }
    } catch {
      continue;
    }
  }
  return matches;
}

async function scoreFile(root: string, file: string, query: string, terms: string[], contextLines: number, config: RootConfig): Promise<ScoredMatch | undefined> {
  const content = await readFile(file, 'utf8');
  const scored = scoreContent(content, query, terms);
  if (!scored) {
    return undefined;
  }
  const line = getLineNumber(content, scored.index);
  return {
    root,
    path: path.relative(root, file),
    line,
    snippet: buildSnippet(content, line, contextLines, config.maxSnippetChars),
    score: scored.score,
  };
}

function scoreContent(content: string, query: string, terms: string[]): { score: number; index: number } | undefined {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  let firstIndex = -1;
  for (const term of terms) {
    const index = lowerContent.indexOf(term.toLowerCase());
    if (index < 0) {
      continue;
    }
    score += Math.max(2, term.length);
    if (firstIndex < 0 || index < firstIndex) {
      firstIndex = index;
    }
  }
  const fullIndex = lowerContent.indexOf(lowerQuery);
  if (fullIndex >= 0) {
    score += Math.min(50, query.length);
    firstIndex = fullIndex;
  }
  return score > 0 && firstIndex >= 0 ? { score, index: firstIndex } : undefined;
}

function buildSnippet(content: string, line: number, contextLines: number, maxChars: number): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  return lines.slice(start, end).join('\n').slice(0, maxChars);
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function extractSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  const lowerQuery = query.toLowerCase();
  for (const term of DOMAIN_TERMS) {
    if (lowerQuery.includes(term.toLowerCase())) {
      terms.add(term);
    }
  }
  for (const token of lowerQuery.match(/[a-z0-9][a-z0-9._/-]{1,63}/g) ?? []) {
    const cleaned = token.replace(/^[-_./]+|[-_./]+$/g, '');
    if (cleaned.length >= 2 && !STOP_WORDS.has(cleaned)) {
      terms.add(cleaned);
    }
  }
  for (const token of extractChineseTerms(query)) {
    if (!STOP_WORDS.has(token)) {
      terms.add(token);
    }
  }
  if (terms.size === 0) {
    terms.add(query.slice(0, 80));
  }
  return Array.from(terms).slice(0, MAX_TERMS);
}

function extractChineseTerms(query: string): string[] {
  const out = new Set<string>();
  const segments = query.match(/[\u4e00-\u9fff]{2,32}/g) ?? [];
  for (const segment of segments) {
    if (segment.length <= 8) {
      out.add(segment);
      continue;
    }
    for (const size of [4, 3, 2]) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        out.add(segment.slice(index, index + size));
      }
    }
  }
  return Array.from(out);
}

function buildGlobs(config: RootConfig, fileGlobs: string[] | undefined): string[] {
  if (fileGlobs && fileGlobs.length > 0) {
    return fileGlobs;
  }
  return Array.from(config.allowedExtensions).map((ext) => `*${ext}`);
}

function buildExtensionSet(config: RootConfig, fileGlobs: string[] | undefined): Set<string> {
  if (!fileGlobs || fileGlobs.length === 0) {
    return config.allowedExtensions;
  }
  const extensions = fileGlobs
    .map((glob) => path.extname(glob.replace(/[*?]/g, '')).toLowerCase())
    .filter(Boolean);
  return extensions.length > 0 ? new Set(extensions) : config.allowedExtensions;
}

function isAllowedFile(file: string, size: number, config: RootConfig): boolean {
  return config.allowedExtensions.has(path.extname(file).toLowerCase()) && size <= config.maxFileBytes;
}

function isSensitivePath(root: string, file: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path.relative(root, file));
}

function isPathInsideRoot(targetPath: string, root: string): boolean {
  const relative = path.relative(root, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function splitRoots(raw: string): string[] {
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function getErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
}
