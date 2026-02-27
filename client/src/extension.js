const path = require('path');
const { workspace } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {

    const serverModule = context.asAbsolutePath(
        path.join('server', 'src', 'server.js')
    );


    const serverOptions = {
        run: { module: serverModule, transport: TransportKind.stdio },
        debug: {
            module: serverModule,
            transport: TransportKind.stdio,
        }
    };

    const clientOptions = {
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

    client.start();
}

function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

module.exports = {
    activate,
    deactivate
};
