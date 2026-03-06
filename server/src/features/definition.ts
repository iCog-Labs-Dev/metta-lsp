import type { DefinitionParams, Location } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';

export function handleDefinition(
    params: DefinitionParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): Location[] | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const tree = analyzer.parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) {
        return null;
    }

    const symbolName = nodeAtCursor.text;
    const entries = analyzer.globalIndex.get(symbolName);
    if (!entries || entries.length === 0) {
        return null;
    }

    return entries.map((entry) => ({ uri: entry.uri, range: entry.range }));
}
