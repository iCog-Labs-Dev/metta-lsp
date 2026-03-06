import type { DocumentSymbolParams, SymbolInformation } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';

export function handleDocumentSymbols(
    params: DocumentSymbolParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): SymbolInformation[] {
    const document = documents.get(params.textDocument.uri);
    if (!document || !analyzer.symbolQuery) return [];

    const tree = analyzer.parser.parse(document.getText());
    const matches = analyzer.symbolQuery.matches(tree.rootNode);
    const symbols: SymbolInformation[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
        const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
        const opNode = match.captures.find((capture) => capture.name === 'op')?.node ?? null;
        if (!nameNode) continue;

        const key = `${nameNode.startPosition.row}:${nameNode.startPosition.column}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let parent = nameNode.parent;
        while (parent && parent.type !== 'list') parent = parent.parent;

        const context = parent ? parent.text : nameNode.text;
        const kind = analyzer.detectSymbolKind(nameNode, opNode, context);

        symbols.push({
            name: nameNode.text,
            kind,
            location: {
                uri: params.textDocument.uri,
                range: {
                    start: {
                        line: nameNode.startPosition.row,
                        character: nameNode.startPosition.column
                    },
                    end: {
                        line: nameNode.endPosition.row,
                        character: nameNode.endPosition.column
                    }
                }
            }
        });
    }

    return symbols;
}
