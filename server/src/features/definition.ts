import type Parser from 'tree-sitter';
import type { DefinitionParams, Location } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import { normalizeUri } from '../utils';
import { resolveReference } from './scoping';

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

export function handleDefinition(
    params: DefinitionParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): Location[] | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const sourceUri = normalizeUri(document.uri);
    const text = document.getText();
    const tree = analyzer.getTreeForDocument(sourceUri, text);
    if (!tree) return null;
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable' && nodeAtCursor.type !== 'atom')) {
        return null;
    }

    let symbolName = nodeAtCursor.text;
    if (nodeAtCursor.type === 'atom') {
        const varChild = nodeAtCursor.children.find(c => c.type === 'variable');
        if (varChild) symbolName = varChild.text;
    }
    const { line, character } = params.position;
    const analysis = analyzer.getScopeAnalysis(sourceUri, text);
    if (analysis) {
        const resolved = resolveReference(symbolName, line, character, analysis.root);
        if (resolved) {

            return [{
                uri: sourceUri,
                range: resolved.binding.range
            }];
        }
    }
    const entries = analyzer.getVisibleEntries(symbolName, sourceUri);
    const resolvedEntries = isCallableLookupSite(nodeAtCursor)
        ? entries.filter((entry) => isCallableEntryOp(entry.op))
        : entries;
    if (!resolvedEntries || resolvedEntries.length === 0) {
        return null;
    }

    return resolvedEntries.map((entry) => ({ uri: entry.uri, range: entry.range }));
}
