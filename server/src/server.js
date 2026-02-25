const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    TextDocumentSyncKind
} = require('vscode-languageserver/node');

const { TextDocument } = require('vscode-languageserver-textdocument');
const Analyzer = require('./analyzer');
const { validateTextDocument } = require('./features/diagnostics');
const { handleCompletion, handleCompletionResolve } = require('./features/completion');
const { handleDefinition } = require('./features/definition');
const { handleHover } = require('./features/hover');
const { handleReferences } = require('./features/references');
const { handleRenameRequest, handlePrepareRename } = require('./features/rename');
const {
    handleDocumentFormatting,
    handleDocumentRangeFormatting,
    handleDocumentOnTypeFormatting
} = require('./features/formatting');
const { handleDocumentSymbols } = require('./features/symbols');
const { handleSemanticTokens } = require('./features/semantics');
const { handleSignatureHelp } = require('./features/signature');
const { normalizeUri } = require('./utils');

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);

const analyzer = new Analyzer(connection);

let hasWorkspaceFolderCapability = false;
let workspaceFolders = [];

connection.onInitialize(async (params) => {
    const capabilities = params.capabilities;

    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );

    connection.console.log('MeTTa LSP Server Initialized');
    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders;
        setTimeout(() => analyzer.scanWorkspace(params.workspaceFolders), 0);
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
                    tokenTypes: ['comment', 'string', 'keyword', 'number', 'operator', 'variable', 'function', 'regexp', 'type', 'boolean', 'punctuation', 'parameter', 'property'],
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
        },
    };
});

connection.onInitialized(() => {
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((params) => {
            for (const folder of params.event.added) {
                workspaceFolders.push(folder);
                setTimeout(() => analyzer.scanWorkspace([folder]), 0);
            }
            for (const folder of params.event.removed) {
                workspaceFolders = workspaceFolders.filter(f => f.uri !== folder.uri);
            }
        });
    }
});

// Document changes
documents.onDidChangeContent((change) => {
    const normalizedUri = normalizeUri(change.document.uri);
    const oldContent = analyzer.parseCache.get(normalizedUri)?.content || null;
    analyzer.indexFile(normalizedUri, change.document.getText());
    analyzer.getOrParseFile(normalizedUri, change.document.getText(), oldContent);

    const diagnostics = validateTextDocument(change.document, analyzer);
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

documents.onDidClose((event) => {
    analyzer.parseCache.delete(normalizeUri(event.document.uri));
});

// Feature handlers
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

// Listening
documents.listen(connection);
connection.listen();
