const { CompletionItemKind } = require('vscode-languageserver/node');
const { BUILTIN_SYMBOLS, BUILTIN_DOCS, BUILTIN_META } = require('../utils');

function completionKindForCategory(category) {
    if (category === 'keyword') return CompletionItemKind.Keyword;
    if (category === 'constant') return CompletionItemKind.Constant;
    return CompletionItemKind.Function;
}

function handleCompletion(params, analyzer) {
    const keywords = Array.from(BUILTIN_SYMBOLS)
        .map(k => ({
            label: k,
            kind: completionKindForCategory(BUILTIN_META.get(k)?.category),
            documentation: BUILTIN_DOCS.has(k) ? {
                kind: 'markdown',
                value: BUILTIN_DOCS.get(k)
            } : undefined
        }));

    const projectSymbols = Array.from(analyzer.globalIndex.keys()).map(s => ({ label: s, kind: CompletionItemKind.Function }));
    const all = [...keywords, ...projectSymbols];
    const seen = new Set();
    return all.filter(item => {
        if (seen.has(item.label)) return false;
        seen.add(item.label);
        return true;
    });
}

function handleCompletionResolve(item) {
    return item;
}

module.exports = {
    handleCompletion,
    handleCompletionResolve
};
