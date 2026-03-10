import * as fs from 'node:fs';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import Metta from '../../../grammar';
import type { SemanticTokens, SemanticTokensParams } from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import { normalizeUri } from '../utils';

const queriesPath = path.resolve(__dirname, '../../../grammar/queries/metta/highlights.scm');
let highlightQuery: Parser.Query | null = null;

try {
    if (fs.existsSync(queriesPath)) {
        const queryContent = fs.readFileSync(queriesPath, 'utf8');
        highlightQuery = new Parser.Query(Metta, queryContent);
    }
} catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`Failed to load highlights.scm from ${queriesPath}: ${reason}`);
}

const tokenTypeMap: Record<string, number> = {
    comment: 0,
    string: 1,
    keyword: 2,
    number: 3,
    operator: 4,
    variable: 5,
    'function.call': 6,
    'function.definition': 6,
    boolean: 9,
    symbol: 5,
    'punctuation.bracket': 10,
    parameter: 11,
    constant: 12
};

export function handleSemanticTokens(
    params: SemanticTokensParams,
    documents: TextDocuments<TextDocument>,
    analyzer: Analyzer
): SemanticTokens {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { data: [] };

    const text = document.getText();
    const tree = analyzer.getTreeForDocument(normalizeUri(document.uri), text);
    if (!tree) return { data: [] };
    const tokens: number[] = [];

    if (highlightQuery) {
        const captures = highlightQuery.captures(tree.rootNode);
        captures.sort(
            (a, b) =>
                (a.node.startPosition.row - b.node.startPosition.row) ||
                (a.node.startPosition.column - b.node.startPosition.column) ||
                (a.node.endPosition.row - b.node.endPosition.row) ||
                (a.node.endPosition.column - b.node.endPosition.column)
        );

        let prevLine = 0;
        let prevChar = 0;

        for (const capture of captures) {
            const typeIndex = tokenTypeMap[capture.name];
            if (typeIndex === undefined) continue;

            const node = capture.node;
            const line = node.startPosition.row;
            const char = node.startPosition.column;
            const length = node.endPosition.column - node.startPosition.column;
            if (length <= 0) continue;

            const deltaLine = line - prevLine;
            const deltaChar = deltaLine === 0 ? char - prevChar : char;
            if (deltaLine < 0 || (deltaLine === 0 && deltaChar < 0)) continue;

            tokens.push(deltaLine, deltaChar, length, typeIndex, 0);
            prevLine = line;
            prevChar = char;
        }
    }

    return { data: tokens };
}
