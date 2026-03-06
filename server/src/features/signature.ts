import * as path from 'node:path';
import Parser from 'tree-sitter';
import type {
    MarkupContent,
    ParameterInformation,
    SignatureHelp,
    SignatureHelpParams,
    SignatureInformation
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';

function findArrowNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'list') {
        const head = node.childForFieldName('head');
        if (head && head.text === '->') {
            return node;
        }
    }

    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        const found = findArrowNode(child);
        if (found) return found;
    }

    return null;
}

export function handleSignatureHelp(
    params: SignatureHelpParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): SignatureHelp | null {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const offset = document.offsetAt(params.position);
    const tree = analyzer.parser.parse(document.getText());

    let node: Parser.SyntaxNode | null = tree.rootNode.descendantForIndex(offset);
    while (node && node.type !== 'list') {
        node = node.parent;
    }
    if (!node) return null;

    const headNode = node.childForFieldName('head');
    if (!headNode) return null;

    const headName = headNode.text;
    const entries = analyzer.globalIndex.get(headName);
    if (!entries || entries.length === 0) return null;

    const signatures: SignatureInformation[] = entries
        .filter((entry) => entry.op === ':')
        .map((entry) => {
            const label = entry.context;
            const parameters: ParameterInformation[] = [];
            const sigTree = analyzer.parser.parse(label);
            const arrowNode = findArrowNode(sigTree.rootNode);

            if (arrowNode) {
                const children = arrowNode.children.filter(
                    (child) => child.isNamed && child.text !== '->'
                );
                if (children.length > 1) {
                    const paramNodes = children.slice(0, -1);
                    for (const paramNode of paramNodes) {
                        parameters.push({
                            label: [paramNode.startIndex, paramNode.endIndex]
                        });
                    }
                }
            }

            const documentation: MarkupContent = {
                kind: 'markdown',
                value: `Defined in [${path.basename(entry.uri)}](${entry.uri})`
            };

            return {
                label,
                documentation,
                parameters
            };
        });

    if (signatures.length === 0) return null;

    let activeParameter = 0;
    let current = node.firstChild;
    while (current && current.endIndex < offset) {
        if (current.isNamed && current !== headNode) {
            activeParameter++;
        }
        current = current.nextSibling;
    }

    return {
        signatures,
        activeSignature: 0,
        activeParameter
    };
}
