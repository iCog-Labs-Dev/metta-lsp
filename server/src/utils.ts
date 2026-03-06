import * as path from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import stdlibDataJson from '../../metta-stdlib.json';
import type { Range } from 'vscode-languageserver/node';

type BuiltinCategory = 'keyword' | 'constant' | 'builtin';

interface BuiltinParam {
    name?: string;
    type?: string;
    description?: string;
}

interface BuiltinReturn {
    type?: string;
    description?: string;
}

interface BuiltinExample {
    expr?: string;
    result?: string;
}

interface BuiltinEntry {
    kind?: string;
    summary?: string;
    description?: string;
    signatures?: string[];
    params?: BuiltinParam[];
    returns?: BuiltinReturn;
    examples?: BuiltinExample[];
    source?: string;
}

interface StdlibData {
    builtins?: Record<string, BuiltinEntry>;
}

export interface BuiltinMeta {
    category: BuiltinCategory;
    source: string | null;
    signatures: string[];
    kind: string | null;
}

const stdlibData = stdlibDataJson as StdlibData;
const BUILTIN_ENTRIES: Record<string, BuiltinEntry> = stdlibData.builtins ?? {};

function getCategory(entry: BuiltinEntry): BuiltinCategory {
    const kind = entry.kind?.toLowerCase();
    if (kind === 'keyword') return 'keyword';
    if (kind === 'constant') return 'constant';
    return 'builtin';
}

function pushSection(lines: string[], title: string, content: string | string[]): void {
    if (!content || (Array.isArray(content) && content.length === 0)) return;
    lines.push(`**${title}**`);
    if (Array.isArray(content)) {
        for (const line of content) lines.push(line);
    } else {
        lines.push(content);
    }
    lines.push('');
}

function formatBuiltinMarkdown(symbol: string, entry: BuiltinEntry, category: BuiltinCategory): string {
    const lines: string[] = [];
    const kind = entry.kind ?? category;
    lines.push(`**\`${symbol}\`** (${category}, ${kind})`);
    lines.push('');

    if (entry.summary) pushSection(lines, 'Summary', entry.summary);
    if (entry.description && entry.description !== entry.summary) {
        pushSection(lines, 'Description', entry.description);
    }

    if (Array.isArray(entry.signatures) && entry.signatures.length > 0) {
        pushSection(lines, 'Signatures', [
            '```metta',
            ...entry.signatures,
            '```'
        ]);
    }

    if (Array.isArray(entry.params) && entry.params.length > 0) {
        const paramLines = entry.params.map((param, idx) => {
            const name = param.name ?? `$${idx + 1}`;
            const type = param.type ?? 'Any';
            const description = param.description ? ` - ${param.description}` : '';
            return `- \`${name}\` (\`${type}\`)${description}`;
        });
        pushSection(lines, 'Parameters', paramLines);
    }

    if (entry.returns && (entry.returns.type || entry.returns.description)) {
        const retType = entry.returns.type ? `\`${entry.returns.type}\`` : '`Any`';
        const retDesc = entry.returns.description ? ` - ${entry.returns.description}` : '';
        pushSection(lines, 'Returns', `${retType}${retDesc}`);
    }

    if (Array.isArray(entry.examples) && entry.examples.length > 0) {
        const exampleLines: string[] = [];
        for (const example of entry.examples) {
            if (example.expr) {
                exampleLines.push('```metta');
                exampleLines.push(example.expr);
                exampleLines.push('```');
            }
            if (example.result) {
                exampleLines.push(`Result: \`${example.result}\``);
            }
            exampleLines.push('');
        }
        while (exampleLines.length > 0 && exampleLines[exampleLines.length - 1] === '') {
            exampleLines.pop();
        }
        pushSection(lines, 'Examples', exampleLines);
    }

    if (entry.source) {
        pushSection(lines, 'Source', `[Corelib documentation](${entry.source})`);
    }

    return lines.join('\n').trim();
}

export const BUILTIN_META = new Map<string, BuiltinMeta>();
export const BUILTIN_DOCS = new Map<string, string>();

for (const [symbol, entry] of Object.entries(BUILTIN_ENTRIES)) {
    const category = getCategory(entry);
    BUILTIN_META.set(symbol, {
        category,
        source: entry.source ?? null,
        signatures: Array.isArray(entry.signatures) ? entry.signatures : [],
        kind: entry.kind ?? null
    });
    BUILTIN_DOCS.set(symbol, formatBuiltinMarkdown(symbol, entry, category));
}

export const BUILTIN_SYMBOLS = new Set<string>(BUILTIN_META.keys());

export function normalizeUri(uri: string): string {
    try {
        const parsed = new URL(uri);
        if (parsed.protocol === 'file:') {
            const filePath = uriToPath(uri);
            if (!filePath) return parsed.href.toLowerCase();

            let normalizedPath = path.normalize(filePath);
            if (process.platform === 'win32' && /^[A-Z]:/.test(normalizedPath)) {
                normalizedPath = normalizedPath[0].toLowerCase() + normalizedPath.slice(1);
            }

            const canonical = pathToFileURL(normalizedPath).href;
            return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
        }
        return uri;
    } catch {
        return uri;
    }
}

export function uriToPath(uri: string): string | null {
    try {
        const url = new URL(uri);
        if (url.protocol === 'file:') {
            let pathname = decodeURIComponent(url.pathname);
            if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return pathname;
        }
    } catch {
        // Keep null on malformed input.
    }
    return null;
}

export function isRangeEqual(range1: Range, range2: Range): boolean {
    return range1.start.line === range2.start.line &&
        range1.start.character === range2.start.character &&
        range1.end.line === range2.end.line &&
        range1.end.character === range2.end.character;
}
