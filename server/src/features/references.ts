import type { ReferenceParams, WorkspaceFolder } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import type { ReferenceLocation } from '../types';

export function handleReferences(
    params: ReferenceParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer,
    workspaceFolders: WorkspaceFolder[]
): ReferenceLocation[] {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const offset = document.offsetAt(params.position);
    const tree = analyzer.parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);

    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) {
        return [];
    }

    return analyzer.findAllReferences(
        nodeAtCursor.text,
        params.context?.includeDeclaration !== false,
        params.textDocument.uri,
        params.position,
        documents,
        workspaceFolders
    );
}
