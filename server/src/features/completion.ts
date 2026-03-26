import {
    CompletionItemKind,
    InsertTextFormat,
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

function fuzzyMatch(query: string, target: string): boolean {
    if (query.length === 0) return true;
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    // Fast path: prefix match
    if (t.startsWith(q)) return true;
    // Fuzzy path: subsequence match
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length;
}

function scoreMatch(query: string, label: string, isUserDefined: boolean): number {
    const q = query.toLowerCase();
    const l = label.toLowerCase();
    let score = 0;
    if (l === q) score += 100;                    // exact
    else if (l.startsWith(q)) score += 50;        // prefix
    else score += 10;                              // fuzzy
    if (isUserDefined) score += 20;               // prefer user symbols
    score -= Math.min(label.length, 30);           // shorter = more specific
    return score;
}

type CursorContext =
    | 'definition'        // inside (= ...)
    | 'type-annotation'   // inside (: ...)
    | 'let'               // inside (let ...) or (let* ...)
    | 'match'             // inside (match ...)
    | 'variable'          // user typed $
    | 'function-call'     // generic call position
    | 'top-level';        // top level, nothing special

function detectContext(content: string, offset: number): CursorContext {
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
        const ch = content[i];
        if (ch === ')') { depth++; continue; }
        if (ch === '(') {
            if (depth > 0) { depth--; continue; }
            // Found the opening paren – grab the head token
            const rest = content.slice(i + 1).trimStart();
            const headMatch = rest.match(/^([^\s()]+)/);
            const head = headMatch ? headMatch[1] : '';
            if (head === '=') return 'definition';
            if (head === ':') return 'type-annotation';
            if (head === 'let' || head === 'let*') return 'let';
            if (head === 'match') return 'match';
            return 'function-call';
        }
    }
    return 'top-level';
}

function getCurrentToken(content: string, offset: number): string {
    let start = offset - 1;
    while (start >= 0) {
        const ch = content[start];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
            ch === '(' || ch === ')') {
            break;
        }
        start--;
    }
    return content.slice(start + 1, offset);
}

const SNIPPET_TEMPLATES: CompletionItem[] = [
    {
        label: '(= (fn args) body)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(= (${1:function-name} ${2:$arg})\n   ${3:body})',
        detail: 'Function definition',
        documentation: {
            kind: 'markdown',
            value: 'Define a new function:\n```metta\n(= (fn-name $arg)\n   body)\n```'
        },
        sortText: '0000'
    },
    {
        label: '(: name type)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(: ${1:name} (-> ${2:ArgType} ${3:ReturnType}))',
        detail: 'Type annotation',
        documentation: {
            kind: 'markdown',
            value: 'Annotate a symbol with a type:\n```metta\n(: my-fn (-> Number Number))\n```'
        },
        sortText: '0001'
    },
    {
        label: '(let $var val body)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(let $${1:var} ${2:value}\n   ${3:body})',
        detail: 'Let binding',
        documentation: {
            kind: 'markdown',
            value: 'Bind a value to a variable:\n```metta\n(let $x 42\n   (+ $x 1))\n```'
        },
        sortText: '0002'
    },
    {
        label: '(let* bindings body)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(let* (($${1:x} ${2:val1})\n       ($${3:y} ${4:val2}))\n   ${5:body})',
        detail: 'Sequential let bindings',
        documentation: {
            kind: 'markdown',
            value: 'Bind multiple variables sequentially:\n```metta\n(let* (($x 1)\n       ($y 2))\n   (+ $x $y))\n```'
        },
        sortText: '0003'
    },
    {
        label: '(match space pattern body)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(match ${1:&self} ${2:pattern}\n   ${3:body})',
        detail: 'Pattern match against space',
        documentation: {
            kind: 'markdown',
            value: 'Match a pattern against a space:\n```metta\n(match &self (parent $x $y)\n   $x)\n```'
        },
        sortText: '0004'
    },
    {
        label: '(if cond then else)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(if ${1:condition}\n   ${2:then-branch}\n   ${3:else-branch})',
        detail: 'Conditional expression',
        documentation: {
            kind: 'markdown',
            value: '```metta\n(if (> $x 0)\n   $x\n   (- $x))\n```'
        },
        sortText: '0005'
    },
    {
        label: '(import! space module)',
        kind: CompletionItemKind.Snippet,
        insertTextFormat: InsertTextFormat.Snippet,
        insertText: '(import! ${1:&self} ${2:module-path})',
        detail: 'Import a module',
        documentation: {
            kind: 'markdown',
            value: '```metta\n(import! &self ./my-module)\n```'
        },
        sortText: '0006'
    }
];

export function handleCompletion(params: CompletionParams, analyzer: Analyzer): CompletionItem[] {
    const sourceUri = normalizeUri(params.textDocument.uri);
    const { line, character } = params.position;

    const cached = analyzer.parseCache.get(sourceUri);
    const content = cached?.content ?? '';

    const lines = content.split('\n');
    let cursorOffset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
        cursorOffset += (lines[i]?.length ?? 0) + 1; // +1 for \n
    }
    cursorOffset += character;

    const currentToken = getCurrentToken(content, cursorOffset);
    const isTypingVariable = currentToken.startsWith('$');
    const queryToken = isTypingVariable ? currentToken.slice(1) : currentToken;

    const context = isTypingVariable ? 'variable' : detectContext(content, cursorOffset);

    const seen = new Set<string>();
    const all: CompletionItem[] = [];

    if (context === 'top-level' || currentToken === '' || currentToken === '(') {
        for (const snippet of SNIPPET_TEMPLATES) {
            if (currentToken === '' || fuzzyMatch(currentToken.replace(/^\(/, ''), snippet.label)) {
                all.push(snippet);
                seen.add(snippet.label);
            }
        }
    }

    if (cached) {
        const analysis = analyzer.getScopeAnalysis(sourceUri, cached.content);
        if (analysis) {
            const localBindings = getLocalBindingsAtPosition(line, character, analysis.root);
            for (const binding of localBindings) {
                const name = binding.name; // e.g. "$x"
                if (seen.has(name)) continue;

                // Filter: if typing a variable, only show variables
                if (isTypingVariable) {
                    const varName = name.startsWith('$') ? name.slice(1) : name;
                    if (!fuzzyMatch(queryToken, varName)) continue;
                } else if (currentToken !== '') {
                    if (!fuzzyMatch(currentToken, name)) continue;
                }

                seen.add(name);
                const originLabel = binding.introducedBy === 'definition-param'
                    ? 'parameter'
                    : binding.introducedBy.replace(/-/g, ' ');
                all.push({
                    label: name,
                    kind: CompletionItemKind.Variable,
                    detail: `Local ${originLabel}`,
                    sortText: `1_${name}`,
                    documentation: {
                        kind: 'markdown',
                        value: `Local binding introduced by \`${binding.introducedBy}\``
                    }
                });
            }
        }
    }

    if (!isTypingVariable) {
        for (const symbol of analyzer.globalIndex.keys()) {
            if (seen.has(symbol)) continue;
            const visible = analyzer.getVisibleEntries(symbol, sourceUri);
            if (visible.length === 0) continue;
            if (currentToken !== '' && !fuzzyMatch(currentToken, symbol)) continue;

            // Build rich detail from the first visible entry
            const entry = visible[0];
            let detail = 'User-defined';
            let docLines: string[] = [];

            if (entry.op === ':') {
                detail = `Type: ${entry.typeSignature ?? entry.context}`;
            } else if (entry.op === '=') {
                const params = entry.parameters?.join(' ') ?? '';
                detail = params ? `(${symbol} ${params})` : `(${symbol})`;
            } else if (entry.op === 'bind!') {
                detail = 'Space binding';
            }

            if (entry.immediateTypeSignature) {
                docLines.push(`**Type:** \`${entry.immediateTypeSignature}\``);
            }
            if (entry.description) {
                docLines.push('', entry.description);
            }
            if (entry.context && entry.context !== symbol) {
                docLines.push('', '```metta', entry.context, '```');
            }

            const score = scoreMatch(currentToken, symbol, true);
            seen.add(symbol);
            all.push({
                label: symbol,
                kind: entry.op === ':' ? CompletionItemKind.Interface : CompletionItemKind.Function,
                detail,
                sortText: `2_${String(999 - score).padStart(3, '0')}_${symbol}`,
                documentation: docLines.length > 0
                    ? { kind: 'markdown', value: docLines.join('\n') }
                    : undefined
            });
        }
    }

    if (!isTypingVariable) {
        for (const symbol of BUILTIN_SYMBOLS) {
            if (seen.has(symbol)) continue;
            if (currentToken !== '' && !fuzzyMatch(currentToken, symbol)) continue;

            const meta = BUILTIN_META.get(symbol);
            const score = scoreMatch(currentToken, symbol, false);
            seen.add(symbol);
            all.push({
                label: symbol,
                kind: completionKindForCategory(meta?.category),
                detail: meta?.category === 'keyword' ? 'Built-in keyword'
                    : meta?.category === 'constant' ? 'Built-in constant'
                    : 'Built-in function',
                sortText: `3_${String(999 - score).padStart(3, '0')}_${symbol}`,
                documentation: BUILTIN_DOCS.has(symbol)
                    ? { kind: 'markdown' as const, value: BUILTIN_DOCS.get(symbol) ?? '' }
                    : undefined
            });
        }
    }

    if (context === 'function-call' && !isTypingVariable) {
        const callHeadMatch = content
            .slice(0, cursorOffset)
            .match(/\(\s*([^\s()]+)\s+[^)]*$/);
        if (callHeadMatch) {
            const calledFn = callHeadMatch[1];
            const entries = analyzer.getVisibleEntries(calledFn, sourceUri);
            for (const entry of entries) {
                if (!entry.parameters || entry.parameters.length === 0) continue;
                const patternLabel = `${calledFn} ${entry.parameters.join(' ')}`;
                if (seen.has(patternLabel)) continue;
                seen.add(patternLabel);
                all.push({
                    label: patternLabel,
                    kind: CompletionItemKind.Snippet,
                    insertTextFormat: InsertTextFormat.PlainText,
                    insertText: entry.parameters.join(' '),
                    detail: 'Pattern from definition',
                    sortText: `0_pattern_${patternLabel}`,
                    documentation: {
                        kind: 'markdown',
                        value: `Argument pattern from:\n\`\`\`metta\n${entry.context}\n\`\`\``
                    }
                });
            }
        }
    }

    const deduped = new Set<string>();
    return all.filter((item) => {
        if (deduped.has(item.label)) return false;
        deduped.add(item.label);
        return true;
    });
}

export function handleCompletionResolve(item: CompletionItem): CompletionItem {
    return item;
}