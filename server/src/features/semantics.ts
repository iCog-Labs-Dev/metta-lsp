import * as fs from 'node:fs';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import Metta from '../../../grammar';
import type { SemanticTokens, SemanticTokensParams } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import { validateTextDocument } from './diagnostics';
import { BUILTIN_SYMBOLS, normalizeUri } from '../utils';

const queriesPath = path.resolve(__dirname, '../../../grammar/queries/metta/highlights.scm');
let highlightQuery: Parser.Query | null = null;

try {
    if (fs.existsSync(queriesPath)) {
        const queryContent = fs.readFileSync(queriesPath, 'utf8');
        highlightQuery = new Parser.Query(Metta, queryContent);
    }
} catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`Failed to load highlights.scm from ${queriesPath}: ${reason}`);
}

export const SEMANTIC_TOKEN_TYPES = [
    'comment',
    'string',
    'keyword',
    'number',
    'operator',
    'variable',
    'function',
    'macro',
    'regexp',
    'type',
    'boolean',
    'punctuation',
    'parameter',
    'property'
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = [
    'defaultLibrary',
    'undefined'
] as const;

interface TokenStyle {
    type: (typeof SEMANTIC_TOKEN_TYPES)[number];
    modifierMask: number;
    priority: number;
}

interface PendingToken {
    line: number;
    char: number;
    length: number;
    typeIndex: number;
    modifierMask: number;
    priority: number;
}

const tokenTypeIndex = SEMANTIC_TOKEN_TYPES.reduce<Record<string, number>>((index, type, i) => {
    index[type] = i;
    return index;
}, {});

const modifierBit = (modifier: (typeof SEMANTIC_TOKEN_MODIFIERS)[number]): number => {
    const index = SEMANTIC_TOKEN_MODIFIERS.indexOf(modifier);
    return index >= 0 ? (1 << index) : 0;
};

const defaultLibraryModifier = modifierBit('defaultLibrary');
const undefinedModifier = modifierBit('undefined');

const captureStyles: Partial<Record<string, TokenStyle>> = {
    comment: { type: 'comment', modifierMask: 0, priority: 20 },
    string: { type: 'string', modifierMask: 0, priority: 20 },
    keyword: { type: 'keyword', modifierMask: 0, priority: 30 },
    number: { type: 'number', modifierMask: 0, priority: 20 },
    operator: { type: 'operator', modifierMask: 0, priority: 25 },
    variable: { type: 'variable', modifierMask: 0, priority: 20 },
    'function.call': { type: 'function', modifierMask: 0, priority: 40 },
    'function.definition': { type: 'function', modifierMask: 0, priority: 45 },
    boolean: { type: 'boolean', modifierMask: 0, priority: 20 },
    symbol: { type: 'variable', modifierMask: 0, priority: 10 },
    'punctuation.bracket': { type: 'punctuation', modifierMask: 0, priority: 35 },
    parameter: { type: 'parameter', modifierMask: 0, priority: 30 },
    constant: { type: 'property', modifierMask: 0, priority: 30 }
};

function appendToken(
    pending: PendingToken[],
    line: number,
    char: number,
    length: number,
    style: TokenStyle
): void {
    if (length <= 0) return;
    const typeIndex = tokenTypeIndex[style.type];
    if (typeIndex === undefined) return;
    pending.push({
        line,
        char,
        length,
        typeIndex,
        modifierMask: style.modifierMask,
        priority: style.priority
    });
}

function dedupeAndSortTokens(tokens: PendingToken[]): PendingToken[] {
    const byRange = new Map<string, PendingToken>();

    for (const token of tokens) {
        const key = `${token.line}:${token.char}:${token.length}`;
        const existing = byRange.get(key);
        if (!existing || token.priority > existing.priority) {
            byRange.set(key, token);
        }
    }

    const deduped = Array.from(byRange.values());
    deduped.sort((a, b) => {
        if (a.line !== b.line) return a.line - b.line;
        if (a.char !== b.char) return a.char - b.char;
        if (a.length !== b.length) return a.length - b.length;
        return 0;
    });
    return deduped;
}

export function handleSemanticTokens(
    params: SemanticTokensParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): SemanticTokens {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { data: [] };

    const text = document.getText();
    const tree = analyzer.getTreeForDocument(normalizeUri(document.uri), text);
    if (!tree) return { data: [] };
    const tokens: number[] = [];
    const pending: PendingToken[] = [];

    if (highlightQuery) {
        const captures = highlightQuery.captures(tree.rootNode);
        captures.sort(
            (a, b) =>
                (a.node.startPosition.row - b.node.startPosition.row) ||
                (a.node.startPosition.column - b.node.startPosition.column) ||
                (a.node.endPosition.row - b.node.endPosition.row) ||
                (a.node.endPosition.column - b.node.endPosition.column)
        );

        for (const capture of captures) {
            const defaultStyle = captureStyles[capture.name];
            if (!defaultStyle) continue;

            const node = capture.node;
            const line = node.startPosition.row;
            const char = node.startPosition.column;
            const length = node.endPosition.column - node.startPosition.column;
            if (length <= 0) continue;

            if (capture.name === 'function.call' && BUILTIN_SYMBOLS.has(node.text)) {
                appendToken(pending, line, char, length, {
                    type: 'macro',
                    modifierMask: 0,
                    priority: 50
                });
                continue;
            }

            appendToken(pending, line, char, length, defaultStyle);
        }
    }

    const unresolvedDiagnostics = validateTextDocument(document, analyzer, {
        duplicateDefinitions: false,
        typeMismatchEnabled: false,
        undefinedFunctions: true,
        undefinedVariables: true,
        undefinedBindings: true
    });

    for (const diagnostic of unresolvedDiagnostics) {
        const message = diagnostic.message ?? '';
        const range = diagnostic.range;
        const line = range.start.line;
        const char = range.start.character;
        const length = range.end.character - range.start.character;
        if (length <= 0) continue;

        if (message.startsWith('Undefined function ')) {
            appendToken(pending, line, char, length, {
                type: 'function',
                modifierMask: undefinedModifier,
                priority: 90
            });
            continue;
        }

        if (message.startsWith('Undefined variable ')) {
            appendToken(pending, line, char, length, {
                type: 'variable',
                modifierMask: undefinedModifier,
                priority: 90
            });
            continue;
        }

        if (message.startsWith('Undefined binding variable or function ')) {
            appendToken(pending, line, char, length, {
                type: 'property',
                modifierMask: undefinedModifier,
                priority: 90
            });
        }
    }

    const sorted = dedupeAndSortTokens(pending);
    let prevLine = 0;
    let prevChar = 0;

    for (const token of sorted) {
        const deltaLine = token.line - prevLine;
        const deltaChar = deltaLine === 0 ? token.char - prevChar : token.char;
        if (deltaLine < 0 || (deltaLine === 0 && deltaChar < 0)) continue;

        tokens.push(deltaLine, deltaChar, token.length, token.typeIndex, token.modifierMask);
        prevLine = token.line;
        prevChar = token.char;
    }

    return { data: tokens };
}
