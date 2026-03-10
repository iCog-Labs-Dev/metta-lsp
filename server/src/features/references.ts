import {
    LSPErrorCodes,
    ResponseError,
    type CancellationToken,
    type Location,
    type ReferenceParams,
    type ResultProgressReporter,
    type WorkDoneProgressReporter,
    type WorkspaceFolder
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import type { ReferenceLocation } from '../types';
import { normalizeUri } from '../utils';

const REFERENCE_PARTIAL_CHUNK_SIZE = 150;

function ensureReferenceRequestActive(token: CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Reference request cancelled');
    }
}

export function handleReferences(
    params: ReferenceParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer,
    workspaceFolders: WorkspaceFolder[],
    token: CancellationToken,
    workDoneProgress: WorkDoneProgressReporter,
    resultProgress?: ResultProgressReporter<Location[]>
): ReferenceLocation[] {
    workDoneProgress.begin('Finding references', 0, params.textDocument.uri, true);

    try {
        ensureReferenceRequestActive(token);

        const document = documents.get(params.textDocument.uri);
        if (!document) return [];

        const offset = document.offsetAt(params.position);
        const text = document.getText();
        const tree = analyzer.getTreeForDocument(normalizeUri(document.uri), text);
        if (!tree) return [];
        const nodeAtCursor = tree.rootNode.descendantForIndex(offset);

        if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) {
            return [];
        }

        workDoneProgress.report(25, 'Scanning workspace');
        const references = analyzer.findAllReferences(
            nodeAtCursor.text,
            params.context?.includeDeclaration !== false,
            params.textDocument.uri,
            params.position,
            documents,
            workspaceFolders,
            token
        );

        ensureReferenceRequestActive(token);

        if (resultProgress && references.length > REFERENCE_PARTIAL_CHUNK_SIZE) {
            workDoneProgress.report(75, 'Streaming partial reference results');

            for (let index = 0; index < references.length; index += REFERENCE_PARTIAL_CHUNK_SIZE) {
                ensureReferenceRequestActive(token);
                resultProgress.report(references.slice(index, index + REFERENCE_PARTIAL_CHUNK_SIZE));
            }

            workDoneProgress.report(100, 'Completed');
            return [];
        }

        workDoneProgress.report(100, 'Completed');
        return references;
    } finally {
        workDoneProgress.done();
    }
}
