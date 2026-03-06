import {
    ProposedFeatures,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
    type InitializeParams,
    type InitializeResult,
    type WorkspaceFolder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import Analyzer from './analyzer';
import { handleCompletion, handleCompletionResolve } from './features/completion';
import { handleDefinition } from './features/definition';
import { validateTextDocument } from './features/diagnostics';
import {
    handleDocumentFormatting,
    handleDocumentOnTypeFormatting,
    handleDocumentRangeFormatting
} from './features/formatting';
import { handleHover } from './features/hover';
import { handleReferences } from './features/references';
import { handlePrepareRename, handleRenameRequest } from './features/rename';
import { handleSemanticTokens } from './features/semantics';
import { handleSignatureHelp } from './features/signature';
import { handleDocumentSymbols } from './features/symbols';
import type { DiagnosticSettings } from './types';
import { normalizeUri } from './utils';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analyzer = new Analyzer(connection);

let hasWorkspaceFolderCapability = false;
let hasConfigurationCapability = false;
let workspaceFolders: WorkspaceFolder[] = [];
const diagnosticSettings: DiagnosticSettings = {
    undefinedFunctions: true,
    undefinedVariables: true,
    undefinedBindings: true
};

async function refreshDiagnosticSettings(): Promise<void> {
    if (!hasConfigurationCapability) return;

    const config = await connection.workspace.getConfiguration('metta');
    const diagnosticsConfig = config && typeof config.diagnostics === 'object'
        ? config.diagnostics as Partial<DiagnosticSettings>
        : {};

    diagnosticSettings.undefinedFunctions = diagnosticsConfig.undefinedFunctions !== false;
    diagnosticSettings.undefinedVariables = diagnosticsConfig.undefinedVariables !== false;
    diagnosticSettings.undefinedBindings = diagnosticsConfig.undefinedBindings !== false;
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    const capabilities = params.capabilities;
    hasWorkspaceFolderCapability = !!(capabilities.workspace?.workspaceFolders);
    hasConfigurationCapability = !!(capabilities.workspace?.configuration);

    connection.console.log('MeTTa LSP Server Initialized');
    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders;
        setTimeout(() => {
            void analyzer.scanWorkspace(params.workspaceFolders ?? []);
        }, 0);
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            workspace: {
                workspaceFolders: {
                    supported: true
                }
            },
            semanticTokensProvider: {
                legend: {
                    tokenTypes: [
                        'comment',
                        'string',
                        'keyword',
                        'number',
                        'operator',
                        'variable',
                        'function',
                        'regexp',
                        'type',
                        'boolean',
                        'punctuation',
                        'parameter',
                        'property'
                    ],
                    tokenModifiers: []
                },
                full: true
            },
            documentSymbolProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentFormattingProvider: true,
            documentOnTypeFormattingProvider: {
                firstTriggerCharacter: '\n',
                moreTriggerCharacter: [')', ']']
            },
            renameProvider: {
                prepareProvider: true
            },
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(', ' ']
            },
            completionProvider: {
                resolveProvider: true
            }
        }
    };
});

connection.onInitialized(() => {
    if (!hasWorkspaceFolderCapability) return;

    connection.workspace.onDidChangeWorkspaceFolders((params) => {
        for (const folder of params.added) {
            workspaceFolders.push(folder);
            setTimeout(() => {
                void analyzer.scanWorkspace([folder]);
            }, 0);
        }
        for (const folder of params.removed) {
            workspaceFolders = workspaceFolders.filter((workspaceFolder) => workspaceFolder.uri !== folder.uri);
        }
    });
});

connection.onDidChangeConfiguration(async () => {
    await refreshDiagnosticSettings();

    for (const document of documents.all()) {
        const diagnostics = validateTextDocument(document, analyzer, diagnosticSettings);
        connection.sendDiagnostics({ uri: document.uri, diagnostics });
    }
});

documents.onDidChangeContent(async (change) => {
    const normalizedUri = normalizeUri(change.document.uri);
    const oldContent = analyzer.parseCache.get(normalizedUri)?.content ?? null;
    analyzer.indexFile(normalizedUri, change.document.getText());
    analyzer.getOrParseFile(normalizedUri, change.document.getText(), oldContent);

    await refreshDiagnosticSettings();
    const diagnostics = validateTextDocument(change.document, analyzer, diagnosticSettings);
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

documents.onDidClose((event) => {
    analyzer.parseCache.delete(normalizeUri(event.document.uri));
});

connection.onCompletion((params) => handleCompletion(params, analyzer));
connection.onCompletionResolve(handleCompletionResolve);
connection.onDefinition((params) => handleDefinition(params, documents, analyzer));
connection.onHover((params) => handleHover(params, documents, analyzer));
connection.onReferences((params) => handleReferences(params, documents, analyzer, workspaceFolders));
connection.onDocumentSymbol((params) => handleDocumentSymbols(params, documents, analyzer));
connection.languages.semanticTokens.on((params) => handleSemanticTokens(params, documents, analyzer));
connection.onSignatureHelp((params) => handleSignatureHelp(params, documents, analyzer));

connection.onRenameRequest((params) => handleRenameRequest(params, documents, analyzer, workspaceFolders));
connection.onPrepareRename((params) => handlePrepareRename(params, documents, analyzer, workspaceFolders));

connection.onDocumentFormatting((params) => handleDocumentFormatting(params, documents));
connection.onDocumentRangeFormatting((params) => handleDocumentRangeFormatting(params, documents));
connection.onDocumentOnTypeFormatting((params) => handleDocumentOnTypeFormatting(params, documents));

documents.listen(connection);
connection.listen();
