import * as path from 'node:path';
import type { Position, TextEdit } from 'vscode-languageserver/node';
import type Analyzer from '../analyzer';
import type { SymbolEntry } from '../types';
import { normalizeUri, uriToPath } from '../utils';

export interface AutoImportCandidate {
    symbolName: string;
    entry: SymbolEntry;
    importSpec: string;
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

function escapeImportSpec(spec: string): string {
    return spec.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatImportSpecToken(spec: string): string {
    if (/^[^\s()"';]+$/u.test(spec)) {
        return spec;
    }
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
        const spec = stripQuotes(tokens[tokens.length - 1]);
        if (spec) specs.add(spec);
    }

    return specs;
}

function buildRelativeImportSpec(sourceUri: string, targetUri: string): string | null {
    const sourcePath = uriToPath(sourceUri);
    const targetPath = uriToPath(targetUri);
    if (!sourcePath || !targetPath) return null;

    const sourceDir = path.dirname(sourcePath);
    let relative = path.relative(sourceDir, targetPath).replace(/\\/g, '/');
    if (!relative) return null;

    if (relative.endsWith('/main.metta')) {
        relative = relative.slice(0, -('/main.metta'.length));
    } else if (relative.endsWith('.metta')) {
        relative = relative.slice(0, -('.metta'.length));
    }

    relative = relative.replace(/^\.\//u, '');
    if (!relative) return null;

    // Prefer MeTTa module syntax (:) when path stays within the current module root.
    if (!relative.startsWith('../')) {
        relative = relative.replace(/\//g, ':');
    }
    return relative;
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
    const declaredImports = collectDeclaredImportSpecs(sourceText);
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

        const importSpec = buildRelativeImportSpec(normalizedSourceUri, normalizedEntryUri);
        if (!importSpec || declaredImports.has(importSpec)) {
            continue;
        }

        const candidate: AutoImportCandidate = {
            symbolName,
            entry,
            importSpec,
            targetUri: normalizedEntryUri
        };
        const existing = candidatesBySpec.get(importSpec);
        if (!existing || shouldReplaceCandidate(candidate, existing)) {
            candidatesBySpec.set(importSpec, candidate);
        }
    }

    const candidates = Array.from(candidatesBySpec.values());
    candidates.sort((left, right) => {
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

export function buildAutoImportEdit(sourceText: string, importSpec: string): TextEdit | null {
    const declaredImports = collectDeclaredImportSpecs(sourceText);
    if (declaredImports.has(importSpec)) {
        return null;
    }

    const insertion = findImportInsertionPosition(sourceText);
    const token = formatImportSpecToken(importSpec);
    return {
        range: { start: insertion, end: insertion },
        newText: `! (import! &self ${token})\n`
    };
}
