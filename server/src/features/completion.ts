import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionParams
} from 'vscode-languageserver/node';
import type Analyzer from '../analyzer';
import { BUILTIN_DOCS, BUILTIN_META, BUILTIN_SYMBOLS } from '../utils';

function completionKindForCategory(category: string | undefined): CompletionItemKind {
    if (category === 'keyword') return CompletionItemKind.Keyword;
    if (category === 'constant') return CompletionItemKind.Constant;
    return CompletionItemKind.Function;
}

export function handleCompletion(_params: CompletionParams, analyzer: Analyzer): CompletionItem[] {
    const keywords: CompletionItem[] = Array.from(BUILTIN_SYMBOLS).map((symbol) => ({
        label: symbol,
        kind: completionKindForCategory(BUILTIN_META.get(symbol)?.category),
        documentation: BUILTIN_DOCS.has(symbol)
            ? {
                kind: 'markdown',
                value: BUILTIN_DOCS.get(symbol) ?? ''
            }
            : undefined
    }));

    const projectSymbols: CompletionItem[] = Array.from(analyzer.globalIndex.keys()).map((symbol) => ({
        label: symbol,
        kind: CompletionItemKind.Function
    }));

    const all = [...keywords, ...projectSymbols];
    const seen = new Set<string>();

    return all.filter((item) => {
        if (seen.has(item.label)) return false;
        seen.add(item.label);
        return true;
    });
}

export function handleCompletionResolve(item: CompletionItem): CompletionItem {
    return item;
}
