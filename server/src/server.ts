import * as nodeFs from 'node:fs/promises';
import { setImmediate as waitForEventLoop } from 'node:timers/promises';
import {
    DocumentDiagnosticReportKind,
    DocumentDiagnosticRequest,
    LSPErrorCodes,
    ProposedFeatures,
    ResponseError,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
    type CancellationToken,
    type Diagnostic,
    type DiagnosticOptions,
    type Disposable,
    type DocumentDiagnosticParams,
    type DocumentDiagnosticReport,
    type InitializeParams,
    type InitializeResult,
    type ResultProgressReporter,
    type WorkDoneProgressReporter,
    type WorkspaceDocumentDiagnosticReport,
    type WorkspaceDiagnosticParams,
    type WorkspaceDiagnosticReportPartialResult,
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
import { normalizeUri, uriToPath } from './utils';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analyzer = new Analyzer(connection);

interface DiagnosticSnapshot {
    uri: string;
    version: number | null;
    diagnostics: Diagnostic[];
    digest: string;
    resultId: string;
    settingsRevision: number;
    indexRevision: number;
    sourceToken: string;
}

interface LoadedDiagnosticDocument {
    document: TextDocument;
    version: number | null;
    sourceToken: string;
}

const DIAGNOSTIC_PROVIDER_OPTIONS: DiagnosticOptions = {
    identifier: 'metta',
    interFileDependencies: true,
    workspaceDiagnostics: true,
    workDoneProgress: true
};

const WORKSPACE_DIAGNOSTIC_CHUNK_SIZE = 20;
const WORKSPACE_DIAGNOSTIC_YIELD_INTERVAL = 8;
const WORKSPACE_DIAGNOSTIC_WARMUP_YIELD_INTERVAL = 1;

let hasWorkspaceFolderCapability = false;
let hasConfigurationCapability = false;
let workspaceFolders: WorkspaceFolder[] = [];
let supportsPullDiagnosticsCapability = false;
let supportsDiagnosticRefreshCapability = false;
let supportsDiagnosticDynamicRegistration = false;
let usePullDiagnostics = false;
let usePushDiagnostics = true;
let dynamicDiagnosticRegistration: Disposable | null = null;
let diagnosticResultCounter = 0;
let diagnosticSettingsRevision = 0;
let indexRevision = 0;
let pullDiagnosticRefreshTimer: NodeJS.Timeout | null = null;
let workspaceDiagnosticWarmupGeneration = 0;
let workspaceDiagnosticWarmupInProgress = false;
let workspaceDiagnosticWarmupPromise: Promise<void> | null = null;
let workspaceDiagnosticWarmupTimer: NodeJS.Timeout | null = null;

const diagnosticSnapshots = new Map<string, DiagnosticSnapshot>();
const diagnosticRequestVersions = new Map<string, number>();

const diagnosticSettings: DiagnosticSettings = {
    undefinedFunctions: true,
    undefinedVariables: true,
    undefinedBindings: true
};

function nextDiagnosticResultId(): string {
    diagnosticResultCounter += 1;
    return `metta-diagnostic-${diagnosticResultCounter}`;
}

function beginTrackedDiagnosticRequest(key: string): number {
    const next = (diagnosticRequestVersions.get(key) ?? 0) + 1;
    diagnosticRequestVersions.set(key, next);
    return next;
}

function createDiagnosticCancellationError(message: string): ResponseError<{ retriggerRequest: boolean }> {
    return new ResponseError(LSPErrorCodes.ServerCancelled, message, { retriggerRequest: true });
}

function ensureTrackedDiagnosticRequest(
    key: string,
    version: number,
    token: CancellationToken,
    message: string
): void {
    if (token.isCancellationRequested || diagnosticRequestVersions.get(key) !== version) {
        throw createDiagnosticCancellationError(message);
    }
}

function schedulePullDiagnosticsRefresh(): void {
    if (!usePullDiagnostics || !supportsDiagnosticRefreshCapability) return;

    if (pullDiagnosticRefreshTimer) {
        clearTimeout(pullDiagnosticRefreshTimer);
    }

    pullDiagnosticRefreshTimer = setTimeout(() => {
        pullDiagnosticRefreshTimer = null;
        try {
            connection.languages.diagnostics.refresh();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            connection.console.error(`workspace/diagnostic/refresh failed: ${message}`);
        }
    }, 75);
}

function scheduleWorkspaceDiagnosticWarmup(delayMs = 250): void {
    if (!usePullDiagnostics) return;

    if (workspaceDiagnosticWarmupTimer) {
        clearTimeout(workspaceDiagnosticWarmupTimer);
    }

    workspaceDiagnosticWarmupTimer = setTimeout(() => {
        workspaceDiagnosticWarmupTimer = null;
        startWorkspaceDiagnosticWarmup();
    }, delayMs);
}

async function refreshDiagnosticSettings(): Promise<void> {
    if (!hasConfigurationCapability) return;

    const config = await connection.workspace.getConfiguration('metta');
    const diagnosticsConfig = config && typeof config.diagnostics === 'object'
        ? config.diagnostics as Partial<DiagnosticSettings>
        : {};

    const nextUndefinedFunctions = diagnosticsConfig.undefinedFunctions !== false;
    const nextUndefinedVariables = diagnosticsConfig.undefinedVariables !== false;
    const nextUndefinedBindings = diagnosticsConfig.undefinedBindings !== false;

    const changed =
        diagnosticSettings.undefinedFunctions !== nextUndefinedFunctions ||
        diagnosticSettings.undefinedVariables !== nextUndefinedVariables ||
        diagnosticSettings.undefinedBindings !== nextUndefinedBindings;

    diagnosticSettings.undefinedFunctions = nextUndefinedFunctions;
    diagnosticSettings.undefinedVariables = nextUndefinedVariables;
    diagnosticSettings.undefinedBindings = nextUndefinedBindings;

    if (changed) {
        diagnosticSettingsRevision += 1;
    }
}

function indexDocument(uri: string, content: string): boolean {
    const normalizedUri = normalizeUri(uri);
    try {
        const changed = analyzer.indexFile(normalizedUri, content);
        if (changed) {
            indexRevision += 1;
        }
        return changed;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        connection.console.error(`Failed to index ${normalizedUri}: ${message}`);
        return false;
    }
}

async function getDocumentForDiagnostics(uri: string): Promise<LoadedDiagnosticDocument | null> {
    const openDocument = documents.get(uri);
    if (openDocument) {
        const version = typeof openDocument.version === 'number' ? openDocument.version : null;
        return {
            document: openDocument,
            version,
            sourceToken: `open:${version ?? 'null'}`
        };
    }

    const normalizedUri = normalizeUri(uri);
    const normalizedDocument = normalizedUri === uri ? null : documents.get(normalizedUri);
    if (normalizedDocument) {
        const version = typeof normalizedDocument.version === 'number' ? normalizedDocument.version : null;
        return {
            document: normalizedDocument,
            version,
            sourceToken: `open:${version ?? 'null'}`
        };
    }

    const filePath = uriToPath(normalizedUri);
    if (!filePath) return null;

    try {
        const [stats, content] = await Promise.all([
            nodeFs.stat(filePath),
            nodeFs.readFile(filePath, 'utf8')
        ]);
        const mtimeMs = Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : 0;
        return {
            document: TextDocument.create(normalizedUri, 'metta', 0, content),
            version: null,
            sourceToken: `file:${mtimeMs}:${content.length}`
        };
    } catch {
        return null;
    }
}

function createDiagnosticSnapshot(
    document: TextDocument,
    reportedVersion: number | null,
    sourceToken: string
): DiagnosticSnapshot {
    const normalizedUri = normalizeUri(document.uri);
    const version = reportedVersion;
    const diagnostics = validateTextDocument(document, analyzer, diagnosticSettings);
    const digest = `${diagnosticSettingsRevision}:${indexRevision}:${sourceToken}:${version ?? 'null'}:${JSON.stringify(diagnostics)}`;

    const existing = diagnosticSnapshots.get(normalizedUri);
    const resultId = existing && existing.digest === digest
        ? existing.resultId
        : nextDiagnosticResultId();

    const snapshot: DiagnosticSnapshot = {
        uri: normalizedUri,
        version,
        diagnostics,
        digest,
        resultId,
        settingsRevision: diagnosticSettingsRevision,
        indexRevision,
        sourceToken
    };

    diagnosticSnapshots.set(normalizedUri, snapshot);
    return snapshot;
}

function createEmptyDiagnosticSnapshot(uri: string): DiagnosticSnapshot {
    const normalizedUri = normalizeUri(uri);
    const sourceToken = 'missing';
    const digest = `${diagnosticSettingsRevision}:${indexRevision}:${sourceToken}`;
    const existing = diagnosticSnapshots.get(normalizedUri);
    const resultId = existing && existing.digest === digest
        ? existing.resultId
        : nextDiagnosticResultId();

    const snapshot: DiagnosticSnapshot = {
        uri: normalizedUri,
        version: null,
        diagnostics: [],
        digest,
        resultId,
        settingsRevision: diagnosticSettingsRevision,
        indexRevision,
        sourceToken
    };

    diagnosticSnapshots.set(normalizedUri, snapshot);
    return snapshot;
}

function isSnapshotCurrent(snapshot: DiagnosticSnapshot, sourceToken?: string): boolean {
    if (snapshot.settingsRevision !== diagnosticSettingsRevision) return false;
    if (snapshot.indexRevision !== indexRevision) return false;
    if (sourceToken !== undefined && snapshot.sourceToken !== sourceToken) return false;
    return true;
}

async function computeDocumentDiagnosticSnapshotUntracked(uri: string): Promise<DiagnosticSnapshot> {
    const loaded = await getDocumentForDiagnostics(uri);
    if (!loaded) {
        return createEmptyDiagnosticSnapshot(uri);
    }

    const normalizedUri = normalizeUri(loaded.document.uri);
    const existing = diagnosticSnapshots.get(normalizedUri);
    if (existing && isSnapshotCurrent(existing, loaded.sourceToken)) {
        return existing;
    }

    indexDocument(loaded.document.uri, loaded.document.getText());
    return createDiagnosticSnapshot(loaded.document, loaded.version, loaded.sourceToken);
}

async function computeDocumentDiagnosticSnapshot(
    uri: string,
    requestKey: string,
    requestVersion: number,
    token: CancellationToken
): Promise<DiagnosticSnapshot> {
    ensureTrackedDiagnosticRequest(
        requestKey,
        requestVersion,
        token,
        `Diagnostic request for ${uri} was cancelled`
    );

    const snapshot = await computeDocumentDiagnosticSnapshotUntracked(uri);
    ensureTrackedDiagnosticRequest(
        requestKey,
        requestVersion,
        token,
        `Diagnostic request for ${uri} was superseded`
    );

    return snapshot;
}

function toDocumentDiagnosticReport(
    snapshot: DiagnosticSnapshot,
    previousResultId?: string
): DocumentDiagnosticReport {
    if (previousResultId && previousResultId === snapshot.resultId) {
        return {
            kind: DocumentDiagnosticReportKind.Unchanged,
            resultId: snapshot.resultId
        };
    }

    return {
        kind: DocumentDiagnosticReportKind.Full,
        resultId: snapshot.resultId,
        items: snapshot.diagnostics
    };
}

function collectWorkspaceDiagnosticUris(): string[] {
    const uris = new Set<string>();

    for (const document of documents.all()) {
        if (document.languageId === 'metta' || document.uri.endsWith('.metta')) {
            uris.add(normalizeUri(document.uri));
        }
    }

    for (const folder of workspaceFolders) {
        const rootPath = uriToPath(folder.uri);
        if (!rootPath) continue;
        analyzer.findAllMettaFiles(rootPath, uris);
    }

    return Array.from(uris).sort();
}

function startWorkspaceDiagnosticWarmup(): void {
    if (!usePullDiagnostics) return;

    if (workspaceDiagnosticWarmupTimer) {
        clearTimeout(workspaceDiagnosticWarmupTimer);
        workspaceDiagnosticWarmupTimer = null;
    }

    const generation = ++workspaceDiagnosticWarmupGeneration;
    workspaceDiagnosticWarmupInProgress = true;

    workspaceDiagnosticWarmupPromise = (async () => {
        try {
            await refreshDiagnosticSettings();
            const uris = collectWorkspaceDiagnosticUris();

            for (let index = 0; index < uris.length; index++) {
                if (generation !== workspaceDiagnosticWarmupGeneration) return;

                const uri = uris[index];
                const existing = diagnosticSnapshots.get(uri);
                if (!existing || !isSnapshotCurrent(existing)) {
                    try {
                        await computeDocumentDiagnosticSnapshotUntracked(uri);
                    } catch (error: unknown) {
                        const message = error instanceof Error ? error.message : String(error);
                        connection.console.error(`Warmup diagnostics failed for ${uri}: ${message}`);
                    }
                }

                if ((index + 1) % WORKSPACE_DIAGNOSTIC_WARMUP_YIELD_INTERVAL === 0) {
                    await waitForEventLoop();
                }
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            connection.console.error(`Workspace diagnostic warmup failed: ${message}`);
        } finally {
            if (generation !== workspaceDiagnosticWarmupGeneration) return;
            workspaceDiagnosticWarmupInProgress = false;
            workspaceDiagnosticWarmupPromise = null;
            schedulePullDiagnosticsRefresh();
        }
    })();
}

function toWorkspaceDiagnosticReportItem(
    snapshot: DiagnosticSnapshot,
    previousResultId?: string
): WorkspaceDocumentDiagnosticReport {
    if (previousResultId && previousResultId === snapshot.resultId) {
        return {
            kind: DocumentDiagnosticReportKind.Unchanged,
            uri: snapshot.uri,
            version: snapshot.version,
            resultId: snapshot.resultId
        };
    }

    return {
        kind: DocumentDiagnosticReportKind.Full,
        uri: snapshot.uri,
        version: snapshot.version,
        resultId: snapshot.resultId,
        items: snapshot.diagnostics
    };
}

async function runDocumentDiagnosticPull(
    params: DocumentDiagnosticParams,
    token: CancellationToken,
    workDoneProgress: WorkDoneProgressReporter
): Promise<DocumentDiagnosticReport> {
    const uri = normalizeUri(params.textDocument.uri);
    const requestVersion = beginTrackedDiagnosticRequest(uri);
    workDoneProgress.begin('Computing diagnostics', 0, uri, true);

    try {
        await refreshDiagnosticSettings();
        const snapshot = await computeDocumentDiagnosticSnapshot(uri, uri, requestVersion, token);
        ensureTrackedDiagnosticRequest(uri, requestVersion, token, `Diagnostic request for ${uri} was superseded`);
        workDoneProgress.report(100, 'Completed');
        return toDocumentDiagnosticReport(snapshot, params.previousResultId);
    } catch (error: unknown) {
        if (error instanceof ResponseError) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        connection.console.error(`Document diagnostic pull failed for ${uri}: ${message}`);
        const fallbackSnapshot = createEmptyDiagnosticSnapshot(uri);
        return toDocumentDiagnosticReport(fallbackSnapshot, params.previousResultId);
    } finally {
        workDoneProgress.done();
    }
}

async function runWorkspaceDiagnosticPull(
    params: WorkspaceDiagnosticParams,
    token: CancellationToken,
    workDoneProgress: WorkDoneProgressReporter,
    resultProgress?: ResultProgressReporter<WorkspaceDiagnosticReportPartialResult>
): Promise<{ items: WorkspaceDocumentDiagnosticReport[] }> {
    const requestKey = '__workspace__';
    const requestVersion = beginTrackedDiagnosticRequest(requestKey);
    workDoneProgress.begin('Computing workspace diagnostics', 0, 'Collecting files', true);

    try {
        await refreshDiagnosticSettings();
        ensureTrackedDiagnosticRequest(
            requestKey,
            requestVersion,
            token,
            'Workspace diagnostics request was cancelled'
        );

        const previousResultIds = new Map<string, string>();
        for (const entry of params.previousResultIds) {
            previousResultIds.set(normalizeUri(entry.uri), entry.value);
        }

        const uris = collectWorkspaceDiagnosticUris();
        const buffered: WorkspaceDocumentDiagnosticReport[] = [];
        const results: WorkspaceDocumentDiagnosticReport[] = [];
        const canServeWarmupCacheOnly = typeof resultProgress !== 'undefined';
        if (canServeWarmupCacheOnly && !workspaceDiagnosticWarmupInProgress) {
            startWorkspaceDiagnosticWarmup();
        }

        for (let index = 0; index < uris.length; index++) {
            if (index > 0 && index % WORKSPACE_DIAGNOSTIC_YIELD_INTERVAL === 0) {
                await waitForEventLoop();
            }

            ensureTrackedDiagnosticRequest(
                requestKey,
                requestVersion,
                token,
                'Workspace diagnostics request was superseded'
            );

            const uri = uris[index];
            let snapshot: DiagnosticSnapshot | null = null;

            if (canServeWarmupCacheOnly) {
                const cached = diagnosticSnapshots.get(uri);
                if (cached && isSnapshotCurrent(cached)) {
                    snapshot = cached;
                }
            } else {
                try {
                    snapshot = await computeDocumentDiagnosticSnapshot(uri, requestKey, requestVersion, token);
                } catch (error: unknown) {
                    if (error instanceof ResponseError) {
                        throw error;
                    }

                    const message = error instanceof Error ? error.message : String(error);
                    connection.console.error(`Skipping diagnostics for ${uri}: ${message}`);
                    snapshot = createEmptyDiagnosticSnapshot(uri);
                }
            }
            ensureTrackedDiagnosticRequest(
                requestKey,
                requestVersion,
                token,
                'Workspace diagnostics request was superseded'
            );

            if (snapshot) {
                const reportItem = toWorkspaceDiagnosticReportItem(snapshot, previousResultIds.get(uri));
                if (resultProgress) {
                    buffered.push(reportItem);
                    if (buffered.length >= WORKSPACE_DIAGNOSTIC_CHUNK_SIZE) {
                        resultProgress.report({ items: buffered.splice(0) });
                    }
                } else {
                    results.push(reportItem);
                }
            }

            const percentage = uris.length === 0 ? 100 : Math.round(((index + 1) / uris.length) * 100);
            workDoneProgress.report(percentage, `Processed ${index + 1}/${uris.length}`);
        }

        if (resultProgress && buffered.length > 0) {
            resultProgress.report({ items: buffered.splice(0) });
        }

        return { items: resultProgress ? [] : results };
    } catch (error: unknown) {
        if (error instanceof ResponseError) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        connection.console.error(`Workspace diagnostic pull failed: ${message}`);
        return { items: [] };
    } finally {
        workDoneProgress.done();
    }
}

async function registerDiagnosticProviderDynamically(): Promise<void> {
    if (!usePullDiagnostics || !supportsDiagnosticDynamicRegistration || dynamicDiagnosticRegistration) {
        return;
    }

    try {
        dynamicDiagnosticRegistration = await connection.client.register(DocumentDiagnosticRequest.type, {
            documentSelector: [{ language: 'metta', scheme: 'file' }],
            ...DIAGNOSTIC_PROVIDER_OPTIONS
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        connection.console.error(`Dynamic diagnostic registration failed; falling back to push diagnostics: ${message}`);
        usePullDiagnostics = false;
        usePushDiagnostics = true;
        void refreshDiagnosticSettings().then(() => {
            for (const document of documents.all()) {
                indexDocument(document.uri, document.getText());
                sendPushDiagnostics(document);
            }
        });
    }
}

async function scanWorkspaceAndRefreshDiagnostics(folders: WorkspaceFolder[]): Promise<void> {
    await analyzer.scanWorkspace(folders);

    if (usePullDiagnostics) {
        startWorkspaceDiagnosticWarmup();
        schedulePullDiagnosticsRefresh();
    }
}

function sendPushDiagnostics(document: TextDocument): void {
    const diagnostics = validateTextDocument(document, analyzer, diagnosticSettings);
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
    const capabilities = params.capabilities;
    hasWorkspaceFolderCapability = !!(capabilities.workspace?.workspaceFolders);
    hasConfigurationCapability = !!(capabilities.workspace?.configuration);
    supportsPullDiagnosticsCapability = !!(capabilities.textDocument?.diagnostic);
    supportsDiagnosticDynamicRegistration = !!(capabilities.textDocument?.diagnostic?.dynamicRegistration);
    supportsDiagnosticRefreshCapability = !!(capabilities.workspace?.diagnostics?.refreshSupport);
    usePullDiagnostics = supportsPullDiagnosticsCapability;
    usePushDiagnostics = !usePullDiagnostics;

    connection.console.log('MeTTa LSP Server Initialized');
    if (params.workspaceFolders) {
        workspaceFolders = params.workspaceFolders;
        setTimeout(() => {
            void scanWorkspaceAndRefreshDiagnostics(params.workspaceFolders ?? []);
        }, 0);
    }

    const supportsSemanticTokens = !!capabilities.textDocument?.semanticTokens;

    const serverCapabilities: InitializeResult['capabilities'] = {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        workspace: {
            workspaceFolders: {
                supported: true
            }
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
    };

    if (supportsSemanticTokens) {
        serverCapabilities.semanticTokensProvider = {
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
        };
    }

    if (usePullDiagnostics && !supportsDiagnosticDynamicRegistration) {
        serverCapabilities.diagnosticProvider = DIAGNOSTIC_PROVIDER_OPTIONS;
    }

    return {
        capabilities: serverCapabilities
    };
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        void refreshDiagnosticSettings();
    }

    void registerDiagnosticProviderDynamically();

    if (!hasWorkspaceFolderCapability) return;

    connection.workspace.onDidChangeWorkspaceFolders((params) => {
        for (const folder of params.added) {
            workspaceFolders.push(folder);
            setTimeout(() => {
                void scanWorkspaceAndRefreshDiagnostics([folder]);
            }, 0);
        }
        for (const folder of params.removed) {
            workspaceFolders = workspaceFolders.filter((workspaceFolder) => workspaceFolder.uri !== folder.uri);
        }
        schedulePullDiagnosticsRefresh();
    });
});

connection.onDidChangeConfiguration(async () => {
    await refreshDiagnosticSettings();

    if (usePushDiagnostics) {
        for (const document of documents.all()) {
            indexDocument(document.uri, document.getText());
            sendPushDiagnostics(document);
        }
    } else {
        startWorkspaceDiagnosticWarmup();
        schedulePullDiagnosticsRefresh();
    }
});

documents.onDidOpen(async (event) => {
    indexDocument(event.document.uri, event.document.getText());

    if (usePushDiagnostics) {
        await refreshDiagnosticSettings();
        sendPushDiagnostics(event.document);
    } else {
        scheduleWorkspaceDiagnosticWarmup();
    }
});

documents.onDidChangeContent(async (change) => {
    indexDocument(change.document.uri, change.document.getText());

    if (usePushDiagnostics) {
        await refreshDiagnosticSettings();
        sendPushDiagnostics(change.document);
    } else {
        scheduleWorkspaceDiagnosticWarmup();
    }
});

documents.onDidClose((event) => {
    const normalizedUri = normalizeUri(event.document.uri);
    analyzer.parseCache.delete(normalizedUri);

    if (usePushDiagnostics) {
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    }
});

connection.onCompletion((params) => handleCompletion(params, analyzer));
connection.onCompletionResolve(handleCompletionResolve);
connection.onDefinition((params) => handleDefinition(params, documents, analyzer));
connection.onHover((params) => handleHover(params, documents, analyzer));
connection.onReferences((params, token, workDoneProgress, resultProgress) =>
    handleReferences(params, documents, analyzer, workspaceFolders, token, workDoneProgress, resultProgress)
);
connection.onDocumentSymbol((params) => handleDocumentSymbols(params, documents, analyzer));
connection.languages.semanticTokens.on((params) => handleSemanticTokens(params, documents, analyzer));
connection.onSignatureHelp((params) => handleSignatureHelp(params, documents, analyzer));

connection.onRenameRequest((params) => handleRenameRequest(params, documents, analyzer, workspaceFolders));
connection.onPrepareRename((params) => handlePrepareRename(params, documents, analyzer, workspaceFolders));

connection.onDocumentFormatting((params) => handleDocumentFormatting(params, documents));
connection.onDocumentRangeFormatting((params) => handleDocumentRangeFormatting(params, documents));
connection.onDocumentOnTypeFormatting((params) => handleDocumentOnTypeFormatting(params, documents));

connection.languages.diagnostics.on((params, token, workDoneProgress) =>
    runDocumentDiagnosticPull(params, token, workDoneProgress)
);
connection.languages.diagnostics.onWorkspace((params, token, workDoneProgress, resultProgress) =>
    runWorkspaceDiagnosticPull(params, token, workDoneProgress, resultProgress)
);

documents.listen(connection);
connection.listen();
