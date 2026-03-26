import * as path from 'node:path';
import {
    CompletionItemKind,
    type CompletionItem,
    type CompletionParams
} from 'vscode-languageserver/node';
import type Analyzer from '../analyzer';
import type { SymbolEntry } from '../types';
import { BUILTIN_DOCS, BUILTIN_META, BUILTIN_SYMBOLS, normalizeUri, uriToPath } from '../utils';
import { collectAutoImportCandidates, buildAutoImportEdit } from './imports';
import { getLocalBindingsAtPosition } from './scoping';

function completionKindForCategory(category: string | undefined): CompletionItemKind {
    if (category === 'keyword') return CompletionItemKind.Keyword;
    if (category === 'constant') return CompletionItemKind.Constant;
    return CompletionItemKind.Function;
}

function splitTopLevelTypeParts(inner: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '(') depth++;
        if (ch === ')') depth--;

        if (ch === ' ' && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim()) parts.push(current.trim());
    return parts;
}

function arityFromTypeSignature(typeSignature: string): number | null {
    const sig = typeSignature.trim();
    if (!sig.startsWith('(->') || !sig.endsWith(')')) return null;

    const inner = sig.slice(3, -1).trim();
    if (!inner) return 0;
    const parts = splitTopLevelTypeParts(inner);
    if (parts.length === 0) return 0;
    return Math.max(0, parts.length - 1);
}

function inferEntryArity(entry: SymbolEntry): number | null {
    if (Array.isArray(entry.parameters)) {
        return entry.parameters.length;
    }
    const typeSig = entry.immediateTypeSignature ?? entry.typeSignature;
    if (!typeSig) return null;
    return arityFromTypeSignature(typeSig);
}

function autoImportDetail(
    entry: SymbolEntry,
    importSpec: string,
    registerModulePath: string | null
): string {
    const arity = inferEntryArity(entry);
    const typeSig = entry.immediateTypeSignature ?? entry.typeSignature;
    const sourcePath = uriToPath(entry.uri);
    const sourceLabel = sourcePath ? path.basename(sourcePath) : entry.uri;
    const fragments = registerModulePath
        ? [`Auto import ${importSpec} (register ${registerModulePath})`]
        : [`Auto import from ${importSpec}`];

    if (arity !== null) {
        fragments.push(`arity ${arity}`);
    }
    if (typeSig) {
        fragments.push(`type ${typeSig}`);
    }
    fragments.push(`source ${sourceLabel}`);

    return fragments.join(' | ');
}

export function handleCompletion(params: CompletionParams, analyzer: Analyzer): CompletionItem[] {
    const sourceUri = normalizeUri(params.textDocument.uri);
    const seen = new Set<string>();
    const all: CompletionItem[] = [];
    const cached = analyzer.parseCache.get(sourceUri);
    const sourceText = cached?.content ?? '';
    const lineText = sourceText.split(/\r?\n/u)[params.position.line] ?? '';
    const cursor = Math.max(0, Math.min(params.position.character, lineText.length));
    const prefix = lineText.slice(0, cursor).match(/[^\s()";]+$/u)?.[0] ?? '';

    // Local bindings visible at the cursor position
    if (cached) {
        const analysis = analyzer.getScopeAnalysis(sourceUri, cached.content);
        if (analysis) {
            const { line, character } = params.position;
            const localBindings = getLocalBindingsAtPosition(line, character, analysis.root);
            for (const binding of localBindings) {
                if (seen.has(binding.name)) continue;
                if (prefix && !binding.name.startsWith(prefix)) continue;
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
        .filter((symbol) => !prefix || symbol.startsWith(prefix))
        .map((symbol) => ({
            label: symbol,
            kind: completionKindForCategory(BUILTIN_META.get(symbol)?.category),
            documentation: BUILTIN_DOCS.has(symbol)
                ? { kind: 'markdown' as const, value: BUILTIN_DOCS.get(symbol) ?? '' }
                : undefined
        }));

    const projectSymbols: CompletionItem[] = [];
    const autoImports: CompletionItem[] = [];
    const callableImportOps = new Set(['=', 'macro', 'defmacro', ':', 'bind!']);
    const maxAutoImportCandidates = 6;
    for (const symbol of analyzer.globalIndex.keys()) {
        if (seen.has(symbol)) continue;
        if (prefix && !symbol.startsWith(prefix)) continue;

        const visible = analyzer.getVisibleEntries(symbol, sourceUri);
        if (visible.length > 0) {
            projectSymbols.push({ label: symbol, kind: CompletionItemKind.Function });
            continue;
        }

        if (!sourceText) continue;
        const candidates = collectAutoImportCandidates(
            analyzer,
            sourceUri,
            sourceText,
            symbol,
            { allowedOps: callableImportOps, maxResults: maxAutoImportCandidates }
        );
        if (candidates.length === 0) continue;

        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            const edit = buildAutoImportEdit(
                sourceText,
                candidate.importSpec,
                candidate.registerModulePath
            );
            if (!edit) continue;

            autoImports.push({
                label: symbol,
                kind: CompletionItemKind.Function,
                detail: autoImportDetail(
                    candidate.entry,
                    candidate.importSpec,
                    candidate.registerModulePath
                ),
                additionalTextEdits: [edit],
                sortText: `zz_${symbol}_${index.toString().padStart(2, '0')}`
            });
        }
    }

    const combined = [...all, ...keywords, ...projectSymbols, ...autoImports];
    const deduped = new Set<string>();
    return combined.filter((item) => {
        const editMarker = item.additionalTextEdits?.map((edit) => edit.newText).join('\n') ?? '';
        const key = `${item.label}\u0000${item.kind ?? ''}\u0000${item.detail ?? ''}\u0000${editMarker}`;
        if (deduped.has(key)) return false;
        deduped.add(key);
        return true;
    });
}
export function handleCompletionResolve(item: CompletionItem): CompletionItem {
    return item;
}
