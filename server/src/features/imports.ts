import * as path from 'node:path';
import type { Position, TextEdit } from 'vscode-languageserver/node';
import type Analyzer from '../analyzer';
import type { SymbolEntry } from '../types';
import { normalizeUri, uriToPath } from '../utils';

export interface AutoImportCandidate {
    symbolName: string;
    entry: SymbolEntry;
    importSpec: string;
    registerModulePath: string | null;
    targetUri: string;
}

interface AutoImportOptions {
    allowedOps?: ReadonlySet<string>;
    includeVisible?: boolean;
    maxResults?: number;
}

function stripQuotes(text: string): string {
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith('\'') && text.endsWith('\''))
    ) {
        return text.slice(1, -1);
    }
    return text;
}

function normalizeImportSpec(spec: string): string {
    let normalized = stripQuotes(spec.trim());
    if (!normalized) return '';

    normalized = normalized.replace(/\\/g, '/');

    if (normalized.endsWith('/main.metta')) {
        normalized = normalized.slice(0, -('/main.metta'.length));
    } else if (normalized.endsWith(':main.metta')) {
        normalized = normalized.slice(0, -(':main.metta'.length));
    } else if (normalized.endsWith('.metta')) {
        normalized = normalized.slice(0, -('.metta'.length));
    }

    normalized = normalized.replace(/^\.\//u, '');
    normalized = normalized.replace(/\//g, ':');
    return normalized;
}

function normalizeRegisterModulePath(spec: string): string {
    let normalized = stripQuotes(spec.trim());
    if (!normalized) return '';

    normalized = normalized.replace(/\\/g, '/');
    normalized = normalized.replace(/\/+/g, '/');
    normalized = normalized.replace(/\/$/u, '');
    normalized = normalized.replace(/^\.\//u, '');
    return normalized;
}

function escapeImportSpec(spec: string): string {
    return spec.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatImportSpecToken(spec: string): string {
    if (/^[^\s()"';]+$/u.test(spec)) {
        return spec;
    }
    return `"${escapeImportSpec(spec)}"`;
}

function formatRegisterModulePathToken(spec: string): string {
    return `"${escapeImportSpec(spec)}"`;
}

function entryKey(entry: SymbolEntry): string {
    const uri = normalizeUri(entry.uri);
    const { start, end } = entry.range;
    return `${uri}:${start.line}:${start.character}:${end.line}:${end.character}:${entry.op}`;
}

function operationPriority(op: string): number {
    switch (op) {
        case '=':
            return 0;
        case 'macro':
            return 1;
        case 'defmacro':
            return 2;
        case ':':
            return 3;
        case 'bind!':
            return 4;
        default:
            return 5;
    }
}

function importSpecScore(spec: string): { parents: number; segments: number; chars: number } {
    const parts = spec.split(/[/:]/u).filter(Boolean);
    const parents = parts.filter((part) => part === '..').length;
    return {
        parents,
        segments: parts.length,
        chars: spec.length
    };
}

function isTopLevelDirectiveLine(trimmed: string): boolean {
    return /^(?:!\s*)?\(\s*(?:import!|register-module!)\b/.test(trimmed);
}

function findImportInsertionPosition(text: string): Position {
    const lines = text.split(/\r?\n/u);
    let line = 0;

    while (line < lines.length) {
        const trimmed = lines[line].trim();
        if (trimmed === '' || trimmed.startsWith(';')) {
            line += 1;
            continue;
        }
        if (isTopLevelDirectiveLine(trimmed)) {
            line += 1;
            continue;
        }
        break;
    }

    return { line, character: 0 };
}

function collectDeclaredImportSpecs(text: string): Set<string> {
    const specs = new Set<string>();
    const importRegex = /\(\s*import!\s+([^)]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(text)) !== null) {
        const payload = match[1] ?? '';
        const tokens = payload
            .split(/\s+/u)
            .map((token) => token.trim())
            .filter(Boolean)
            .filter((token) => !token.startsWith('&'));
        if (tokens.length === 0) continue;
        const spec = normalizeImportSpec(tokens[tokens.length - 1] ?? '');
        if (spec) specs.add(spec);
    }

    return specs;
}

function collectDeclaredRegisterModulePaths(text: string): Set<string> {
    const roots = new Set<string>();
    const registerRegex = /\(\s*register-module!\s+([^)]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = registerRegex.exec(text)) !== null) {
        const payload = match[1] ?? '';
        const tokens = payload
            .split(/\s+/u)
            .map((token) => token.trim())
            .filter(Boolean)
            .filter((token) => !token.startsWith('&'));
        if (tokens.length === 0) continue;
        const root = normalizeRegisterModulePath(tokens[0] ?? '');
        if (root) roots.add(root);
    }

    return roots;
}

function toModulePath(filePath: string): string {
    if (filePath.endsWith(`${path.sep}main.metta`)) {
        return path.dirname(filePath);
    }
    if (filePath.endsWith('.metta')) {
        return filePath.slice(0, -('.metta'.length));
    }
    return filePath;
}

function buildRegisterModulePath(sourceDir: string, registerRoot: string): string | null {
    const rootName = path.basename(registerRoot);
    if (rootName) {
        const parent = path.dirname(registerRoot);
        const relToParent = path.relative(sourceDir, parent).replace(/\\/g, '/');
        const combined = relToParent ? `${relToParent}/${rootName}` : rootName;
        const normalizedCombined = normalizeRegisterModulePath(combined);
        if (normalizedCombined) return normalizedCombined;
    }

    const fallback = normalizeRegisterModulePath(path.relative(sourceDir, registerRoot).replace(/\\/g, '/'));
    if (fallback) return fallback;
    return null;
}

function buildRelativeImportSpec(
    sourceUri: string,
    targetUri: string
): { importSpec: string; registerModulePath: string | null } | null {
    const sourcePath = uriToPath(sourceUri);
    const targetPath = uriToPath(targetUri);
    if (!sourcePath || !targetPath) return null;

    const sourceDir = path.dirname(sourcePath);
    const relative = path.relative(sourceDir, targetPath).replace(/\\/g, '/');
    if (!relative) return null;

    const relativeSegments = relative.split('/').filter(Boolean);
    let parentSegments = 0;
    while (parentSegments < relativeSegments.length && relativeSegments[parentSegments] === '..') {
        parentSegments += 1;
    }

    if (parentSegments === 0) {
        const importSpec = normalizeImportSpec(relative);
        if (!importSpec) return null;
        return { importSpec, registerModulePath: null };
    }

    let registerRoot = sourceDir;
    for (let index = 0; index < parentSegments; index++) {
        const parent = path.dirname(registerRoot);
        if (parent === registerRoot) break;
        registerRoot = parent;
    }

    const rootName = path.basename(registerRoot);
    const targetModulePath = toModulePath(targetPath);
    const relativeFromRoot = path.relative(registerRoot, targetModulePath).replace(/\\/g, '/');
    if (relativeFromRoot.startsWith('../') || relativeFromRoot === '..') {
        const fallbackImportSpec = normalizeImportSpec(relative);
        if (!fallbackImportSpec) return null;
        return { importSpec: fallbackImportSpec, registerModulePath: null };
    }

    if (!rootName) {
        const fallbackImportSpec = normalizeImportSpec(relative);
        if (!fallbackImportSpec) return null;
        return { importSpec: fallbackImportSpec, registerModulePath: null };
    }

    const tail = normalizeImportSpec(relativeFromRoot);
    const importSpec = tail ? `${rootName}:${tail}` : rootName;
    const registerModulePath = buildRegisterModulePath(sourceDir, registerRoot);
    return {
        importSpec,
        registerModulePath
    };
}

function shouldReplaceCandidate(next: AutoImportCandidate, current: AutoImportCandidate): boolean {
    const opScoreNext = operationPriority(next.entry.op);
    const opScoreCurrent = operationPriority(current.entry.op);
    if (opScoreNext !== opScoreCurrent) {
        return opScoreNext < opScoreCurrent;
    }

    const nextScore = importSpecScore(next.importSpec);
    const currentScore = importSpecScore(current.importSpec);
    if (nextScore.parents !== currentScore.parents) {
        return nextScore.parents < currentScore.parents;
    }
    if (nextScore.segments !== currentScore.segments) {
        return nextScore.segments < currentScore.segments;
    }
    if (nextScore.chars !== currentScore.chars) {
        return nextScore.chars < currentScore.chars;
    }

    return next.targetUri.localeCompare(current.targetUri) < 0;
}

export function collectAutoImportCandidates(
    analyzer: Analyzer,
    sourceUri: string,
    sourceText: string,
    symbolName: string,
    options: AutoImportOptions = {}
): AutoImportCandidate[] {
    const normalizedSourceUri = normalizeUri(sourceUri);
    const allEntries = analyzer.globalIndex.get(symbolName) ?? [];
    if (allEntries.length === 0) return [];

    const visibleEntries = analyzer.getVisibleEntries(symbolName, normalizedSourceUri);
    if (!options.includeVisible && visibleEntries.length > 0) {
        return [];
    }

    const allowedOps = options.allowedOps;
    const visibleKeys = new Set(visibleEntries.map((entry) => entryKey(entry)));
    const candidatesBySpec = new Map<string, AutoImportCandidate>();

    for (const entry of allEntries) {
        if (allowedOps && !allowedOps.has(entry.op)) {
            continue;
        }

        const normalizedEntryUri = normalizeUri(entry.uri);
        if (normalizedEntryUri === normalizedSourceUri) {
            continue;
        }
        if (!options.includeVisible && visibleKeys.has(entryKey(entry))) {
            continue;
        }

        const importRef = buildRelativeImportSpec(normalizedSourceUri, normalizedEntryUri);
        if (!importRef) {
            continue;
        }

        const candidate: AutoImportCandidate = {
            symbolName,
            entry,
            importSpec: importRef.importSpec,
            registerModulePath: importRef.registerModulePath,
            targetUri: normalizedEntryUri
        };
        const key = `${candidate.registerModulePath ?? ''}\u0000${candidate.importSpec}`;
        const existing = candidatesBySpec.get(key);
        if (!existing || shouldReplaceCandidate(candidate, existing)) {
            candidatesBySpec.set(key, candidate);
        }
    }

    const candidates = Array.from(candidatesBySpec.values());
    candidates.sort((left, right) => {
        if (Boolean(left.registerModulePath) !== Boolean(right.registerModulePath)) {
            return left.registerModulePath ? 1 : -1;
        }
        const leftScore = importSpecScore(left.importSpec);
        const rightScore = importSpecScore(right.importSpec);
        if (leftScore.parents !== rightScore.parents) {
            return leftScore.parents - rightScore.parents;
        }
        if (leftScore.segments !== rightScore.segments) {
            return leftScore.segments - rightScore.segments;
        }
        if (leftScore.chars !== rightScore.chars) {
            return leftScore.chars - rightScore.chars;
        }
        return left.importSpec.localeCompare(right.importSpec);
    });

    if (options.maxResults && options.maxResults > 0) {
        return candidates.slice(0, options.maxResults);
    }
    return candidates;
}

export function buildAutoImportEdit(
    sourceText: string,
    importSpec: string,
    registerModulePath: string | null = null
): TextEdit | null {
    const normalizedImportSpec = normalizeImportSpec(importSpec);
    if (!normalizedImportSpec) {
        return null;
    }

    const declaredImports = collectDeclaredImportSpecs(sourceText);
    const normalizedRegisterPath = registerModulePath
        ? normalizeRegisterModulePath(registerModulePath)
        : '';
    const declaredRegisterPaths = collectDeclaredRegisterModulePaths(sourceText);

    const shouldInsertImport = !declaredImports.has(normalizedImportSpec);
    const shouldInsertRegister = Boolean(normalizedRegisterPath) &&
        !declaredRegisterPaths.has(normalizedRegisterPath);
    if (!shouldInsertImport && !shouldInsertRegister) {
        return null;
    }

    const insertion = findImportInsertionPosition(sourceText);
    const token = formatImportSpecToken(normalizedImportSpec);
    const lines: string[] = [];
    if (shouldInsertRegister && normalizedRegisterPath) {
        const registerToken = formatRegisterModulePathToken(normalizedRegisterPath);
        lines.push(`! (register-module! ${registerToken})`);
    }
    if (shouldInsertImport) {
        lines.push(`! (import! &self ${token})`);
    }
    return {
        range: { start: insertion, end: insertion },
        newText: `${lines.join('\n')}\n`
    };
}
