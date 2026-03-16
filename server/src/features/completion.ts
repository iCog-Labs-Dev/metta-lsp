import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionParams
} from 'vscode-languageserver/node';
import type Analyzer from '../analyzer';
import { BUILTIN_DOCS, BUILTIN_META, BUILTIN_SYMBOLS, normalizeUri } from '../utils';
import { getLocalBindingsAtPosition } from './scoping';

function completionKindForCategory(category: string | undefined): CompletionItemKind {
    if (category === 'keyword') return CompletionItemKind.Keyword;
    if (category === 'constant') return CompletionItemKind.Constant;
    return CompletionItemKind.Function;
}

export function handleCompletion(params: CompletionParams, analyzer: Analyzer): CompletionItem[] {
    const sourceUri = normalizeUri(params.textDocument.uri);
    const seen = new Set<string>();
    const all: CompletionItem[] = [];

    // Local bindings visible at the cursor position
    const cached = analyzer.parseCache.get(sourceUri);
    if (cached) {
        const analysis = analyzer.getScopeAnalysis(sourceUri, cached.content);
        if (analysis) {
            const { line, character } = params.position;
            const { getLocalBindingsAtPosition } = require('./scoping');
            const localBindings = getLocalBindingsAtPosition(line, character, analysis.root);
            for (const binding of localBindings) {
                if (seen.has(binding.name)) continue;
                seen.add(binding.name);
                all.push({
                    label: binding.name,
                    kind: CompletionItemKind.Variable
                });
            }
        }
    }

    // Existing builtin keywords
    const keywords: CompletionItem[] = Array.from(BUILTIN_SYMBOLS)
        .filter(s => !seen.has(s))
        .map((symbol) => ({
            label: symbol,
            kind: completionKindForCategory(BUILTIN_META.get(symbol)?.category),
            documentation: BUILTIN_DOCS.has(symbol)
                ? { kind: 'markdown' as const, value: BUILTIN_DOCS.get(symbol) ?? '' }
                : undefined
        }));

    const projectSymbols: CompletionItem[] = [];
    for (const symbol of analyzer.globalIndex.keys()) {
        if (seen.has(symbol)) continue;
        const visible = analyzer.getVisibleEntries(symbol, sourceUri);
        if (visible.length === 0) continue;
        projectSymbols.push({ label: symbol, kind: CompletionItemKind.Function });
    }

    const combined = [...all, ...keywords, ...projectSymbols];
    const deduped = new Set<string>();
    return combined.filter((item) => {
        if (deduped.has(item.label)) return false;
        deduped.add(item.label);
        return true;
    });
}
export function handleCompletionResolve(item: CompletionItem): CompletionItem {
    return item;
}