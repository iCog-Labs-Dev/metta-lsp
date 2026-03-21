import type {
    DocumentFormattingParams,
    DocumentOnTypeFormattingParams,
    DocumentRangeFormattingParams,
    Range,
    TextEdit
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function formatMettaText(text: string): string {
    const lines = text.split('\n');
    const formattedLines: string[] = [];
    let indentLevel = 0;
    const indentSize = 4;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            formattedLines.push('');
            continue;
        }

        // Count leading closing parens to de-indent BEFORE printing this line
        let leadingClose = 0;
        for (const char of trimmed) {
            if (char === ')') leadingClose++;
            else break;
        }
        indentLevel = Math.max(indentLevel - leadingClose, 0);

        formattedLines.push(' '.repeat(indentLevel * indentSize) + trimmed);

        // Update indent for NEXT line, ignoring brackets inside strings/comments
        let inString = false;
        let escaped = false;
        for (const char of trimmed) {
            if (escaped) { escaped = false; continue; }
            if (char === '\\' && inString) { escaped = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (char === ';' && !inString) break;
            if (!inString) {
                if (char === '(') indentLevel++;
                else if (char === ')') indentLevel = Math.max(indentLevel - 1, 0);
            }
        }
    }

    return formattedLines.join('\n');
}

export function handleDocumentFormatting(
    params: DocumentFormattingParams,
    documents: TextDocuments<TextDocument>
): TextEdit[] {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const text = doc.getText();
    const formatted = formatMettaText(text);

    return [{
        range: {
            start: { line: 0, character: 0 },
            end: { line: doc.lineCount, character: 0 }
        },
        newText: formatted
    }];
}

export function handleDocumentRangeFormatting(
    params: DocumentRangeFormattingParams,
    documents: TextDocuments<TextDocument>
): TextEdit[] {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const startOffset = document.offsetAt(params.range.start);
    const endOffset = document.offsetAt(params.range.end);
    const selectedText = document.getText().slice(startOffset, endOffset);
    return [{ range: params.range, newText: formatMettaText(selectedText) }];
}

export function handleDocumentOnTypeFormatting(
    params: DocumentOnTypeFormattingParams,
    documents: TextDocuments<TextDocument>
): TextEdit[] {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    if (!['\n', ')', ']'].includes(params.ch)) return [];

    let startLine = params.position.line;
    while (startLine > 0) {
        const line = document.getText({
            start: { line: startLine, character: 0 },
            end: { line: startLine, character: Number.MAX_SAFE_INTEGER }
        });
        if (!line.trim().startsWith(')') && !line.trim().startsWith(']')) break;
        startLine--;
    }

    const endLine = params.position.line;
    const range: Range = {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: Number.MAX_SAFE_INTEGER }
    };
    const textToFormat = document.getText(range);

    return [{ range, newText: formatMettaText(textToFormat) }];
}
