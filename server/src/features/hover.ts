import type { Hover, HoverParams, MarkupContent } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import type { HoverSettings, SymbolEntry } from '../types';
import { BUILTIN_DOCS, normalizeUri } from '../utils';

function splitArrowTypeParts(typeSig: string): string[] {
    if (!typeSig.startsWith('(-> ')) return [];

    const inner = typeSig.slice(4, -1).trim();
    const parts: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < inner.length; i++) {
        const char = inner[i];
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ' ' && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

export function handleHover(
    params: HoverParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer,
    settings: HoverSettings = { userDefinitionComments: true }
): Hover | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const text = document.getText();
    const tree = analyzer.getTreeForDocument(normalizeUri(document.uri), text);
    if (!tree) return null;
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) {
        return null;
    }

    const symbolName = nodeAtCursor.text;

    if (BUILTIN_DOCS.has(symbolName)) {
        const contents: MarkupContent = {
            kind: 'markdown',
            value: BUILTIN_DOCS.get(symbolName) ?? ''
        };
        return { contents };
    }

    const entries = analyzer.globalIndex.get(symbolName);
    if (!entries || entries.length === 0) return null;

    const typeEntry = entries.find((entry) => entry.op === ':');
    const defEntry = entries.find((entry) => entry.op === '=') ??
        entries.find((entry) => entry.op !== ':') ??
        entries[0];

    const markdown: string[] = [`**${symbolName}**`, ''];

    const typeSig = typeEntry?.typeSignature;
    if (typeSig) {
        markdown.push('**Type**');
        markdown.push(typeSig);
        markdown.push('');
    }

    const description = settings.userDefinitionComments
        ? (defEntry?.description ?? typeEntry?.description)
        : null;
    if (description) {
        markdown.push('**Description**');
        markdown.push('----');
        markdown.push(description);
        markdown.push('');
    }

    const paramsList = defEntry?.parameters ?? [];
    const typeParts = typeSig ? splitArrowTypeParts(typeSig) : [];

    if (paramsList.length > 0 || typeParts.length > 1) {
        markdown.push('**Parameters**');
        const paramCount = Math.max(
            paramsList.length,
            typeParts.length > 0 ? typeParts.length - 1 : 0
        );

        for (let i = 0; i < paramCount; i++) {
            const name = paramsList[i] ?? `arg${i}`;
            const type = typeParts[i] ?? 'Any';
            markdown.push(`${type} - ${name}`);
        }
        markdown.push('');
    }

    if (typeParts.length > 0) {
        markdown.push('**Returns**');
        markdown.push(typeParts[typeParts.length - 1]);
        markdown.push('');
    }

    if (!typeSig && !description && paramsList.length === 0) {
        const bestMatch: SymbolEntry = typeEntry ?? defEntry;
        markdown.push('```metta');
        markdown.push(bestMatch.context);
        markdown.push('```');
    }

    return {
        contents: {
            kind: 'markdown',
            value: markdown.join('\n').trim()
        }
    };
}
