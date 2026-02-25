const { BUILTIN_DOCS } = require('../utils');

function handleHover(params, documents, analyzer) {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const offset = document.offsetAt(params.position);
    const tree = analyzer.parser.parse(document.getText());
    const nodeAtCursor = tree.rootNode.descendantForIndex(offset);
    if (!nodeAtCursor || (nodeAtCursor.type !== 'symbol' && nodeAtCursor.type !== 'variable')) return null;
    let symbolName = nodeAtCursor.text;

    if (BUILTIN_DOCS.has(symbolName)) {
        return {
            contents: {
                kind: 'markdown',
                value: BUILTIN_DOCS.get(symbolName)
            }
        };
    }

    const entries = analyzer.globalIndex.get(symbolName);
    if (entries) {
        const typeEntry = entries.find(s => s.op === ':');
        const defEntry = entries.find(s => s.op === '=') || entries.find(s => s.op !== ':') || entries[0];

        let markdown = `**${symbolName}**\n\n`;

        const typeSig = typeEntry?.typeSignature;
        if (typeSig) {
            markdown += `**Type**\n${typeSig}\n\n`;
        }

        const description = defEntry?.description || typeEntry?.description;
        if (description) {
            markdown += `**Description**\n----\n${description}\n\n`;
        }

        const params = defEntry?.parameters || [];

        let typeParts = [];
        if (typeSig && typeSig.startsWith('(-> ')) {
            const inner = typeSig.slice(4, -1).trim();
            let current = '';
            let depth = 0;
            for (let i = 0; i < inner.length; i++) {
                const char = inner[i];
                if (char === '(') depth++;
                if (char === ')') depth--;
                if (char === ' ' && depth === 0) {
                    if (current.trim()) typeParts.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            if (current.trim()) typeParts.push(current.trim());
        }

        if (params.length > 0 || typeParts.length > 1) {
            markdown += `**Parameters**\n`;
            const paramCount = Math.max(params.length, typeParts.length > 0 ? typeParts.length - 1 : 0);

            for (let i = 0; i < paramCount; i++) {
                const pName = params[i] ? `${params[i]}` : `arg${i}`;
                const pType = typeParts[i] || 'Any';
                markdown += `${pType} - ${pName}\n`;
            }
            markdown += `\n`;
        }

        if (typeParts.length > 0) {
            const returnType = typeParts[typeParts.length - 1];
            markdown += `**Returns**\n${returnType}\n\n`;
        }

        if (!typeSig && !description && params.length === 0) {
            const bestMatch = typeEntry || defEntry;
            markdown += `\`\`\`metta\n${bestMatch.context}\n\`\`\``;
        }

        return { contents: { kind: 'markdown', value: markdown.trim() } };
    }
    return null;
}

module.exports = {
    handleHover
};
