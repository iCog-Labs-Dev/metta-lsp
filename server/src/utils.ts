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
    types?: string[];
    params?: BuiltinParam[];
    returns?: BuiltinReturn;
    examples?: BuiltinExample[];
    overloads?: BuiltinOverload[];
    source?: string;
}

interface BuiltinOverload {
    type?: string;
    signature?: string;
    params?: BuiltinParam[];
    returns?: BuiltinReturn;
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
const DEFAULT_KEYWORDS = ['if', 'let', 'let*', 'match', 'case', 'collapse', 'superpose'];
const DEFAULT_CONSTANTS = ['True', 'False', 'Nil', 'empty', 'Cons', 'Error'];
const DEFAULT_TYPE_NAMES = [
    'Type',
    'Atom',
    'Expression',
    'Symbol',
    'Variable',
    'Grounded',
    'Number',
    'String',
    'Bool',
    'Char',
    'Integer',
    'Decimal',
    'Rational',
    'Any',
    'AnyRet',
    'EagerAny',
    'LazyAny',
    'ErrorType',
    'Unknown'
];

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

function collectTypeTokens(text: string | undefined, out: Set<string>): void {
    if (typeof text !== 'string' || text.length === 0) return;
    const tokens = text.match(/[^()\s;]+/gu) ?? [];
    for (const token of tokens) {
        if (!token || token === '->' || token === ':') continue;
        if (token.startsWith('$')) continue;
        if (token.startsWith('"') && token.endsWith('"')) continue;
        out.add(token);
    }
}

export const BUILTIN_META = new Map<string, BuiltinMeta>();
export const BUILTIN_DOCS = new Map<string, string>();
export const BUILTIN_KEYWORDS = new Set<string>();
export const BUILTIN_CONSTANTS = new Set<string>();
export const BUILTIN_TYPE_NAMES = new Set<string>(DEFAULT_TYPE_NAMES);

for (const [symbol, entry] of Object.entries(BUILTIN_ENTRIES)) {
    const category = getCategory(entry);
    if (category === 'keyword') BUILTIN_KEYWORDS.add(symbol);
    if (category === 'constant') BUILTIN_CONSTANTS.add(symbol);

    if (Array.isArray(entry.signatures)) {
        for (const signature of entry.signatures) collectTypeTokens(signature, BUILTIN_TYPE_NAMES);
    }
    if (Array.isArray(entry.types)) {
        for (const typeText of entry.types) collectTypeTokens(typeText, BUILTIN_TYPE_NAMES);
    }
    if (Array.isArray(entry.params)) {
        for (const param of entry.params) collectTypeTokens(param.type, BUILTIN_TYPE_NAMES);
    }
    collectTypeTokens(entry.returns?.type, BUILTIN_TYPE_NAMES);
    if (Array.isArray(entry.overloads)) {
        for (const overload of entry.overloads) {
            collectTypeTokens(overload.type, BUILTIN_TYPE_NAMES);
            collectTypeTokens(overload.signature, BUILTIN_TYPE_NAMES);
            if (Array.isArray(overload.params)) {
                for (const param of overload.params) collectTypeTokens(param.type, BUILTIN_TYPE_NAMES);
            }
            collectTypeTokens(overload.returns?.type, BUILTIN_TYPE_NAMES);
        }
    }

    BUILTIN_META.set(symbol, {
        category,
        source: entry.source ?? null,
        signatures: Array.isArray(entry.signatures) ? entry.signatures : [],
        kind: entry.kind ?? null
    });
    BUILTIN_DOCS.set(symbol, formatBuiltinMarkdown(symbol, entry, category));
}

for (const keyword of DEFAULT_KEYWORDS) BUILTIN_KEYWORDS.add(keyword);
for (const constant of DEFAULT_CONSTANTS) BUILTIN_CONSTANTS.add(constant);

export const BUILTIN_SYMBOLS = new Set<string>([
    ...BUILTIN_META.keys(),
    ...BUILTIN_KEYWORDS,
    ...BUILTIN_CONSTANTS
]);

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
