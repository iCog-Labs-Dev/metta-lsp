import {
    CodeActionKind,
    type CodeAction,
    type CodeActionParams,
    type Diagnostic
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import { normalizeUri } from '../utils';
import { buildAutoImportEdit, collectAutoImportCandidates } from './imports';

type DiagnosticImportKind = 'function' | 'binding' | 'type' | 'space';

interface DiagnosticImportRequest {
    kind: DiagnosticImportKind;
    symbolName: string;
}

const FUNCTION_IMPORT_OPS = new Set(['=', 'macro', 'defmacro']);
const BINDING_IMPORT_OPS = new Set(['=', 'macro', 'defmacro', 'bind!']);
const TYPE_IMPORT_OPS = new Set([':']);
const SPACE_IMPORT_OPS = new Set(['bind!']);
const MAX_ACTIONS_PER_DIAGNOSTIC = 4;

function parseDiagnosticImportRequest(diagnostic: Diagnostic): DiagnosticImportRequest | null {
    const message = diagnostic.message ?? '';

    const functionMatch = /^Undefined function '([^']+)'/.exec(message);
    if (functionMatch && functionMatch[1]) {
        return { kind: 'function', symbolName: functionMatch[1] };
    }

    const symbolMatch = /^Undefined symbol '([^']+)'/.exec(message);
    if (symbolMatch && symbolMatch[1]) {
        return { kind: 'binding', symbolName: symbolMatch[1] };
    }

    const typeMatch = /^Undefined type '([^']+)'/.exec(message);
    if (typeMatch && typeMatch[1]) {
        return { kind: 'type', symbolName: typeMatch[1] };
    }

    const spaceMatch = /^Unbound space '([^']+)'/.exec(message);
    if (spaceMatch && spaceMatch[1]) {
        return { kind: 'space', symbolName: spaceMatch[1] };
    }

    return null;
}

function allowedOpsForKind(kind: DiagnosticImportKind): ReadonlySet<string> {
    switch (kind) {
        case 'function':
            return FUNCTION_IMPORT_OPS;
        case 'binding':
            return BINDING_IMPORT_OPS;
        case 'type':
            return TYPE_IMPORT_OPS;
        case 'space':
            return SPACE_IMPORT_OPS;
    }
}

function titleFor(kind: DiagnosticImportKind, symbolName: string, importSpec: string): string {
    if (kind === 'type') {
        return `Import type '${symbolName}' from ${importSpec}`;
    }
    if (kind === 'space') {
        return `Import space '${symbolName}' from ${importSpec}`;
    }
    return `Import '${symbolName}' from ${importSpec}`;
}

export function handleCodeActions(
    params: CodeActionParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): CodeAction[] {
    const sourceUri = normalizeUri(params.textDocument.uri);
    const document = documents.get(params.textDocument.uri) ?? documents.get(sourceUri);
    if (!document) return [];

    const sourceText = document.getText();
    if (!sourceText) return [];

    const quickFixes: CodeAction[] = [];
    const seen = new Set<string>();

    for (const diagnostic of params.context.diagnostics) {
        const request = parseDiagnosticImportRequest(diagnostic);
        if (!request) continue;

        const candidates = collectAutoImportCandidates(
            analyzer,
            sourceUri,
            sourceText,
            request.symbolName,
            {
                allowedOps: allowedOpsForKind(request.kind),
                maxResults: MAX_ACTIONS_PER_DIAGNOSTIC
            }
        );

        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            const edit = buildAutoImportEdit(sourceText, candidate.importSpec);
            if (!edit) continue;

            const dedupeKey = `${request.kind}:${request.symbolName}:${candidate.importSpec}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            quickFixes.push({
                title: titleFor(request.kind, request.symbolName, candidate.importSpec),
                kind: CodeActionKind.QuickFix,
                isPreferred: index === 0,
                diagnostics: [diagnostic],
                edit: {
                    changes: {
                        [sourceUri]: [edit]
                    }
                }
            });
        }
    }

    return quickFixes;
}
