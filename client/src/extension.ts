import * as path from 'node:path';
import { workspace, type ExtensionContext } from 'vscode';
import {
    LanguageClient,
    TransportKind,
    type LanguageClientOptions,
    type ServerOptions
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
    const serverModule = context.asAbsolutePath(
        path.join('server', 'dist', 'server.js')
    );

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.stdio },
        debug: { module: serverModule, transport: TransportKind.stdio }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'metta' }],
        synchronize: {
            configurationSection: 'metta',
            fileEvents: workspace.createFileSystemWatcher('**/*.metta')
        }
    };

    client = new LanguageClient(
        'mettaLanguageServer',
        'MeTTa Language Server',
        serverOptions,
        clientOptions
    );

    void client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
