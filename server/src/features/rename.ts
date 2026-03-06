import {
    ErrorCodes,
    ResponseError,
    type PrepareRenameParams,
    type PrepareRenameResult,
    type Range,
    type RenameParams,
    type TextEdit,
    type WorkspaceEdit,
    type WorkspaceFolder
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import { BUILTIN_SYMBOLS, isRangeEqual, normalizeUri } from '../utils';

interface RenameValidation {
    valid: boolean;
    message?: string;
}

function validateRename(symbolName: string, newName: string, analyzer: Analyzer): RenameValidation {
    if (BUILTIN_SYMBOLS.has(symbolName)) {
        return { valid: false, message: `Cannot rename built-in symbol: ${symbolName}` };
    }

    if (BUILTIN_SYMBOLS.has(newName)) {
        return { valid: false, message: `Cannot rename to built-in symbol: ${newName}` };
    }

    const existingDefs = analyzer.globalIndex.get(newName);
    if (existingDefs && existingDefs.length > 0) {
        const currentDefs = analyzer.globalIndex.get(symbolName);
        const isSelfRename = !!currentDefs &&
            currentDefs.length === existingDefs.length &&
            currentDefs.every((def, index) =>
                def.uri === existingDefs[index].uri &&
                isRangeEqual(def.range, existingDefs[index].range)
            );

        if (!isSelfRename) {
            return {
                valid: false,
                message: `Symbol "${newName}" already exists. Rename would create a conflict.`
            };
        }
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName) && !/^[=:->!&|]+$/.test(newName)) {
        return { valid: false, message: `Invalid symbol name: ${newName}` };
    }

    return { valid: true };
}

export function handleRenameRequest(
    params: RenameParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer,
    workspaceFolders: WorkspaceFolder[]
): WorkspaceEdit | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const tree = analyzer.parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) {
        return null;
    }

    const symbolName = nodeAtCursor.text;
    const newName = params.newName;
    if (symbolName === newName) return null;

    const validation = validateRename(symbolName, newName, analyzer);
    if (!validation.valid) {
        throw new ResponseError(
            ErrorCodes.InvalidRequest,
            validation.message ?? 'Invalid rename request.'
        );
    }

    const references = analyzer.findAllReferences(
        symbolName,
        true,
        params.textDocument.uri,
        params.position,
        documents,
        workspaceFolders
    );
    if (references.length === 0) return null;

    const changes: Record<string, TextEdit[]> = {};
    for (const ref of references) {
        const normalizedUri = normalizeUri(ref.uri);
        if (!changes[normalizedUri]) {
            changes[normalizedUri] = [];
        }
        changes[normalizedUri].push({
            range: ref.range,
            newText: newName
        });
    }

    return { changes };
}

export function handlePrepareRename(
    params: PrepareRenameParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer,
    workspaceFolders: WorkspaceFolder[]
): PrepareRenameResult | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const tree = analyzer.parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) {
        return null;
    }

    const symbolName = nodeAtCursor.text;
    if (BUILTIN_SYMBOLS.has(symbolName)) {
        throw new ResponseError(
            ErrorCodes.InvalidRequest,
            `Cannot rename built-in symbol: ${symbolName}`
        );
    }

    const range: Range = {
        start: {
            line: nodeAtCursor.startPosition.row,
            character: nodeAtCursor.startPosition.column
        },
        end: {
            line: nodeAtCursor.endPosition.row,
            character: nodeAtCursor.endPosition.column
        }
    };

    const references = analyzer.findAllReferences(
        symbolName,
        true,
        params.textDocument.uri,
        params.position,
        documents,
        workspaceFolders
    );
    const placeholder = `${symbolName} (${references.length} reference${references.length !== 1 ? 's' : ''})`;

    return { range, placeholder };
}
