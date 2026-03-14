import type Parser from 'tree-sitter';
import type { Hover, HoverParams, MarkupContent } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import type { HoverSettings, SymbolEntry } from '../types';
import { BUILTIN_DOCS, normalizeUri } from '../utils';

type SyntaxNode = Parser.SyntaxNode;

function getNamedChildren(node: SyntaxNode): SyntaxNode[] {
    return node.children.filter((child) => child.type === 'atom' || child.type === 'list');
}

function getHeadSymbol(listNode: SyntaxNode): string | null {
    if (listNode.type !== 'list') return null;
    const named = getNamedChildren(listNode);
    if (named.length === 0 || named[0].type !== 'atom') return null;
    const symbolNode = named[0].children.find((child) => child.type === 'symbol');
    return symbolNode ? symbolNode.text : null;
}

function isDescendantOf(node: SyntaxNode | null, ancestor: SyntaxNode | null): boolean {
    if (!node || !ancestor) return false;
    let current: SyntaxNode | null = node;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

function isInsideTypeExpression(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current) {
        const parent: SyntaxNode | null = current.parent;
        if (!parent || parent.type !== 'list') {
            current = parent;
            continue;
        }

        const named = getNamedChildren(parent);
        if (named.length >= 3 && getHeadSymbol(parent) === ':' && isDescendantOf(node, named[2])) {
            return true;
        }
        current = parent;
    }
    return false;
}

function isCallableEntryOp(op: string): boolean {
    return op === '=' || op === 'macro' || op === 'defmacro';
}

function isCallableLookupSite(node: SyntaxNode): boolean {
    if (node.type !== 'symbol') return false;

    const atom = node.parent;
    if (!atom || atom.type !== 'atom') return false;

    const list = atom.parent;
    if (!list || list.type !== 'list') return false;

    const named = getNamedChildren(list);
    const atomIndex = named.indexOf(atom);
    if (atomIndex < 0) return false;
    if (isInsideTypeExpression(list)) return false;

    const head = getHeadSymbol(list);
    if (atomIndex === 0) {
        if (!head) return false;
        const nonCallableHeads = new Set(['=', ':', '->', 'macro', 'defmacro', 'let', 'let*', 'match', 'case', 'if']);
        return !nonCallableHeads.has(head);
    }
    return false;
}

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
    const sourceUri = normalizeUri(document.uri);
    const text = document.getText();
    const tree = analyzer.getTreeForDocument(sourceUri, text);
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

    const entries = analyzer.getVisibleEntries(symbolName, sourceUri);
    const callableEntries = entries.filter((entry) => isCallableEntryOp(entry.op));
    const effectiveEntries = isCallableLookupSite(nodeAtCursor)
        ? callableEntries
        : entries;
    if (!effectiveEntries || effectiveEntries.length === 0) return null;

    const typeEntry = entries.find((entry) => entry.op === ':');
    const defEntry = effectiveEntries.find((entry) => entry.op === '=') ??
        effectiveEntries.find((entry) => entry.op !== ':') ??
        effectiveEntries[0];

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
