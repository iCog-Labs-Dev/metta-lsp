import Parser from 'tree-sitter';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import type { DiagnosticSettings, SymbolEntry } from '../types';
import { BUILTIN_META, BUILTIN_SYMBOLS, normalizeUri, type BuiltinMeta } from '../utils';

type SyntaxNode = Parser.SyntaxNode;

interface TypedOverload {
    paramTypes: string[];
    returnType: string | null;
    paramTerms: TypeTerm[];
    returnTerm: TypeTerm | null;
}

type TypeMismatchMode = 'runtime' | 'strict';

type TypeTerm =
    | { kind: 'name'; name: string }
    | { kind: 'var'; name: string }
    | { kind: 'compound'; head: TypeTerm; args: TypeTerm[] };

type MetaTypeKind = 'Atom' | 'Expression' | 'Symbol' | 'Variable' | 'Grounded';

interface TypeEvidence {
    candidates: TypeTerm[];
    metaKinds: Set<MetaTypeKind>;
    unknown: boolean;
}

function getNamedChildren(node: SyntaxNode): SyntaxNode[] {
    return node.children.filter((child) => child.type === 'atom' || child.type === 'list');
}

function getHeadSymbol(listNode: SyntaxNode): string | null {
    if (listNode.type !== 'list') return null;
    const children = getNamedChildren(listNode);
    if (children.length === 0 || children[0].type !== 'atom') return null;
    const symbolNode = children[0].children.find((child) => child.type === 'symbol');
    return symbolNode ? symbolNode.text : null;
}

export function validateTextDocument(
    document: TextDocument,
    analyzer: Analyzer,
    settings: Partial<DiagnosticSettings> = {}
): Diagnostic[] {
    const diagnosticsSettings: DiagnosticSettings = {
        duplicateDefinitions: settings.duplicateDefinitions !== false,
        duplicateDefinitionsMode: settings.duplicateDefinitionsMode === 'global' ? 'global' : 'local',
        undefinedFunctions: settings.undefinedFunctions !== false,
        undefinedVariables: settings.undefinedVariables !== false,
        undefinedBindings: settings.undefinedBindings !== false,
        typeMismatchEnabled: settings.typeMismatchEnabled !== false,
        typeMismatchMode: settings.typeMismatchMode === 'strict' ? 'strict' : 'runtime'
    };

    const text = document.getText();
    const sourceUri = normalizeUri(document.uri);
    const tree = analyzer.getTreeForDocument(sourceUri, text);
    if (!tree) {
        return [];
    }
    const diagnostics: Diagnostic[] = [];
    const boundSymbols = collectBoundSymbols(tree.rootNode);
    const visibleEntriesCache = new Map<string, SymbolEntry[]>();
    const typedOverloadCache = new Map<string, TypedOverload[]>();

    const getVisibleEntries = (name: string): SymbolEntry[] => {
        const cached = visibleEntriesCache.get(name);
        if (cached) {
            return cached;
        }
        const entries = analyzer.getVisibleEntries(name, sourceUri);
        visibleEntriesCache.set(name, entries);
        return entries;
    };

    const getTypedOverloads = (name: string): TypedOverload[] => {
        const cached = typedOverloadCache.get(name);
        if (cached) {
            return cached;
        }
        const overloads = collectTypedOverloads(name, getVisibleEntries, BUILTIN_META);
        typedOverloadCache.set(name, overloads);
        return overloads;
    };

    traverseTree(tree.rootNode, (node) => {
        if (node.isMissing) {
            if (isInsideModuleDirective(node)) return;
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column }
                },
                message: `Syntax error: missing ${node.type}`,
                source: 'metta-lsp'
            });
        } else if (node.type === 'ERROR') {
            if (isInsideModuleDirective(node)) return;
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column }
                },
                message: 'Syntax error',
                source: 'metta-lsp'
            });
        }
    });

    const definitionsBySignature = new Map<string, SyntaxNode[]>();
    const matches = analyzer.symbolQuery?.matches(tree.rootNode) ?? [];

    for (const match of matches) {
        const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
        const opNode = match.captures.find((capture) => capture.name === 'op')?.node;
        if (!nameNode || !opNode || opNode.text !== '=') continue;

        let innerList: SyntaxNode | null = nameNode.parent;
        while (innerList && innerList.type !== 'list') innerList = innerList.parent;
        if (!innerList) continue;

        let definitionNode: SyntaxNode | null = innerList;
        let outer: SyntaxNode | null = innerList.parent;
        while (outer && outer.type !== 'list') outer = outer.parent;
        if (!outer) continue;
        definitionNode = outer;

        const namedArgs = getNamedChildren(definitionNode);
        if (namedArgs.indexOf(innerList) !== 1) continue;

        const isTopLevel = definitionNode.parent?.type === 'source_file';
        if (!isTopLevel) continue;

        const name = nameNode.text;
        const arity = inferDefinitionArity(nameNode);
        const key = `${name}::${arity}`;
        if (!definitionsBySignature.has(key)) {
            definitionsBySignature.set(key, []);
        }
        definitionsBySignature.get(key)?.push(nameNode);
    }

    if (diagnosticsSettings.duplicateDefinitions) {
        for (const [key, nodes] of definitionsBySignature.entries()) {
            const [name, arity] = key.split('::');
            const parsedArity = Number.parseInt(arity ?? '0', 10);
            const duplicateCount = diagnosticsSettings.duplicateDefinitionsMode === 'global'
                ? getVisibleEntries(name)
                    .filter((entry) => entry.op === '=' && getDefinitionEntryArity(entry) === parsedArity)
                    .length
                : nodes.length;

            if (duplicateCount <= 1) continue;

            const message = diagnosticsSettings.duplicateDefinitionsMode === 'global'
                ? `Duplicate definition of '${name}' with ${arity} argument(s) (${duplicateCount} visible definitions across current and imported files)`
                : `Duplicate definition of '${name}' with ${arity} argument(s) (${duplicateCount} definitions in this file)`;

            for (const nameNode of nodes) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
                        end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column }
                    },
                    message,
                    source: 'metta-lsp'
                });
            }
        }
    }

    const validOperators = new Set([
        '=',
        ':',
        '->',
        'macro',
        'defmacro',
        '==',
        '~=',
        '+',
        '-',
        '*',
        '/',
        '>',
        '<',
        '>=',
        '<='
    ]);

    if (diagnosticsSettings.undefinedFunctions) {
        traverseTree(tree.rootNode, (node) => {
            if (node.type !== 'list') return;

            const namedChildren = getNamedChildren(node);
            if (namedChildren.length === 0) return;

            const head = namedChildren[0];
            if (head.type !== 'atom') return;
            const symbolNode = head.children.find((child) => child.type === 'symbol');
            if (!symbolNode) return;

            const name = symbolNode.text;
            if (boundSymbols.has(name)) return;
            if (BUILTIN_SYMBOLS.has(name)) return;
            if (validOperators.has(name)) return;
            if (name.startsWith('$')) return;
            if (isInsideCaseBranches(node)) return;

            const parent = node.parent;
            if (parent && parent.type === 'list') {
                const parentNamed = getNamedChildren(parent);
                if (parentNamed[0]?.text === '=' && parentNamed[1] === node) {
                    return;
                }
            }

            const grandParent = node.parent;
            if (grandParent && grandParent.type === 'list') {
                const grandParentNamed = getNamedChildren(grandParent);
                if (grandParentNamed[0]?.text === ':' && grandParentNamed[1] === head) {
                    return;
                }
            }

            const definitions = getVisibleEntries(name);
            if (!definitions || definitions.length === 0) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Undefined function '${name}'`,
                    source: 'metta-lsp'
                });
                return;
            }

            const callArity = namedChildren.length - 1;
            const callableDefinitions = definitions.filter((definition) => definition.op !== ':');
            const matchingDefinitions = callableDefinitions.filter((definition) => {
                const arity = getEntryArity(definition);
                return arity === null || arity === callArity;
            });

            const concreteArities = Array.from(
                new Set(
                    callableDefinitions
                        .map(getEntryArity)
                        .filter((arity): arity is number => arity !== null)
                )
            ).sort((a, b) => a - b);

            if (
                callableDefinitions.length > 0 &&
                concreteArities.length > 0 &&
                matchingDefinitions.length === 0
            ) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Argument count mismatch for '${name}': expected ${formatExpectedArities(concreteArities)}, got ${callArity}`,
                    source: 'metta-lsp'
                });
            } else if (
                matchingDefinitions.length > 1 &&
                !hasTypedOverloadForArity(name, callArity, getTypedOverloads)
            ) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Ambiguous reference '${name}': ${matchingDefinitions.length} matching definitions for ${callArity} argument(s)`,
                    source: 'metta-lsp'
                });
            }
        });
    }

    if (diagnosticsSettings.undefinedBindings) {
        traverseTree(tree.rootNode, (node) => {
            if (node.type !== 'list') return;
            if (isInsideCaseBranches(node)) return;

            const namedChildren = getNamedChildren(node);
            if (namedChildren.length === 0) return;

            const head = namedChildren[0];
            const headSymbolNode = head.type === 'atom'
                ? head.children.find((child) => child.type === 'symbol')
                : undefined;
            const headName = headSymbolNode?.text ?? null;

            if (headName === 'import!' || headName === 'register-module!') {
                return;
            }

            for (let i = 1; i < namedChildren.length; i++) {
                const child = namedChildren[i];
                if (child.type !== 'atom') continue;

                const symbolNode = child.children.find((nodeChild) => nodeChild.type === 'symbol');
                if (!symbolNode) continue;

                const name = symbolNode.text;
                if (validOperators.has(name)) continue;
                if (BUILTIN_SYMBOLS.has(name)) continue;
                if (boundSymbols.has(name)) continue;

                const definitions = getVisibleEntries(name);
                if (definitions && definitions.length > 0) continue;

                if (
                    (headName === '=' ||
                        headName === ':' ||
                        headName === '->' ||
                        headName === 'macro' ||
                        headName === 'defmacro') &&
                    i === 1
                ) {
                    continue;
                }

                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Undefined binding variable or function '${name}'`,
                    source: 'metta-lsp'
                });
            }
        });
    }

    if (diagnosticsSettings.typeMismatchEnabled) {
        validateCallTypeSignatures(
            tree.rootNode,
            diagnostics,
            boundSymbols,
            getVisibleEntries,
            getTypedOverloads,
            diagnosticsSettings.typeMismatchMode
        );
    }

    if (diagnosticsSettings.undefinedVariables) {
        validateUndefinedVariables(tree.rootNode, diagnostics);
    }

    return diagnostics;
}

function isInsideModuleDirective(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current) {
        if (current.type === 'list') {
            const named = getNamedChildren(current);
            if (named.length > 0 && named[0].type === 'atom') {
                const head = named[0].text;
                if (head === 'register-module!' || head === 'import!') {
                    return true;
                }
            }
        }
        current = current.parent;
    }
    return false;
}

function isInsideCaseBranches(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current && current.parent) {
        const maybeCaseCall = current.parent;
        if (maybeCaseCall.type === 'list') {
            const named = getNamedChildren(maybeCaseCall);
            if (named.length >= 3 && named[0].type === 'atom' && named[0].text === 'case') {
                if (named[2] === current) {
                    return true;
                }
            }
        }
        current = current.parent;
    }
    return false;
}

function validateCallTypeSignatures(
    rootNode: SyntaxNode,
    diagnostics: Diagnostic[],
    boundSymbols: Set<string>,
    getVisibleEntries: (name: string) => SymbolEntry[],
    getTypedOverloads: (name: string) => TypedOverload[],
    mode: TypeMismatchMode
): void {
    const nonCallableForms = new Set([
        '=',
        ':',
        '->',
        'macro',
        'defmacro',
        'let',
        'let*',
        'match',
        'case',
        'if'
    ]);
    const inferenceCache = new Map<string, TypeEvidence>();
    const inferenceInProgress = new Set<string>();

    traverseTree(rootNode, (node) => {
        if (node.type !== 'list') return;

        const namedChildren = getNamedChildren(node);
        if (namedChildren.length === 0) return;

        const head = namedChildren[0];
        if (head.type !== 'atom') return;
        const symbolNode = head.children.find((child) => child.type === 'symbol');
        if (!symbolNode) return;

        const name = symbolNode.text;
        if (nonCallableForms.has(name)) return;
        if (name.startsWith('$')) return;

        const parent = node.parent;
        if (parent && parent.type === 'list') {
            const parentNamed = getNamedChildren(parent);
            const parentHead = parentNamed[0]?.text;
            if (
                parentNamed.length > 0 &&
                (parentHead === '=' ||
                    parentHead === ':' ||
                    parentHead === '->' ||
                    parentHead === 'macro' ||
                    parentHead === 'defmacro') &&
                (parentNamed[1] === node || parentNamed[1] === head)
            ) {
                return;
            }
        }

        if (boundSymbols.has(name) && getVisibleEntries(name).length === 0) {
            return;
        }

        const args = namedChildren.slice(1);
        const callArity = args.length;
        const overloads = getTypedOverloads(name)
            .filter((overload) => overload.paramTypes.length === callArity);
        if (overloads.length === 0) return;

        const argTypes = args.map((arg) =>
            inferArgumentType(arg, getTypedOverloads, inferenceCache, inferenceInProgress, mode)
        );
        const matching = overloads.filter((overload) =>
            matchOverload(overload, argTypes, mode).length > 0
        );

        if (matching.length === 0) {
            const expected = overloads.map((overload) => `(${overload.paramTypes.join(', ')})`).join(' or ');
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                    end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                },
                message: `Type mismatch for '${name}': argument types [${argTypes.map(typeEvidenceToString).join(', ')}] do not match ${expected}`,
                source: 'metta-lsp'
            });
            return;
        }

        if (matching.length > 1) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                    end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                },
                message: `Ambiguous reference '${name}': ${matching.length} matching typed overloads for ${callArity} argument(s)`,
                source: 'metta-lsp'
            });
        }
    });
}

function collectBoundSymbols(rootNode: SyntaxNode): Set<string> {
    const bound = new Set<string>();

    function maybeRecordBind(listNode: SyntaxNode): void {
        if (listNode.type !== 'list') return;
        if (getHeadSymbol(listNode) !== 'bind!') return;

        const children = getNamedChildren(listNode);
        if (children.length < 2 || children[1].type !== 'atom') return;

        const boundSymbol = children[1].children.find((child) => child.type === 'symbol');
        if (boundSymbol) {
            bound.add(boundSymbol.text);
        }
    }

    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const node = rootNode.namedChild(i);
        if (!node) continue;

        if (node.type === 'list') {
            maybeRecordBind(node);
            continue;
        }

        if (node.type === 'atom') {
            const symbolNode = node.children.find((child) => child.type === 'symbol');
            if (!symbolNode || symbolNode.text !== '!') continue;

            const next = rootNode.namedChild(i + 1);
            if (next && next.type === 'list') {
                maybeRecordBind(next);
            }
        }
    }

    return bound;
}

function collectTypedOverloads(
    name: string,
    getVisibleEntries: (name: string) => SymbolEntry[],
    builtinMeta: Map<string, BuiltinMeta>
): TypedOverload[] {
    const overloads: TypedOverload[] = [];

    const entries = getVisibleEntries(name);
    for (const entry of entries) {
        if (entry.op !== ':' || !entry.typeSignature) continue;
        const parsed = parseArrowType(entry.typeSignature);
        if (parsed) overloads.push(parsed);
    }

    const meta = builtinMeta.get(name);
    if (meta && Array.isArray(meta.signatures)) {
        for (const signature of meta.signatures) {
            const parsed = parseSignatureText(signature);
            if (parsed) overloads.push(parsed);
        }
    }

    return overloads;
}

function parseSignatureText(signature: string): TypedOverload | null {
    const idx = signature.indexOf(':');
    const rhs = idx >= 0 ? signature.slice(idx + 1).trim() : signature.trim();
    return parseArrowType(rhs);
}

function parseArrowType(typeSignature: string): TypedOverload | null {
    const sig = typeSignature.trim();
    if (!sig.startsWith('(->') || !sig.endsWith(')')) return null;

    const inner = sig.slice(3, -1).trim();
    const parts = splitTopLevelTypeParts(inner);
    if (parts.length < 1) {
        return {
            paramTypes: [],
            returnType: null,
            paramTerms: [],
            returnTerm: null
        };
    }

    const paramTypes = parts.slice(0, -1);
    const returnType = parts[parts.length - 1] ?? null;

    return {
        paramTypes,
        returnType,
        paramTerms: paramTypes.map((typeName) => parseTypeTerm(typeName) ?? createNameTypeTerm(typeName)),
        returnTerm: returnType ? (parseTypeTerm(returnType) ?? createNameTypeTerm(returnType)) : null
    };
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

const UNIVERSAL_TYPE_NAMES = new Set([
    'Atom',
    '%Undefined%',
    'Any',
    'AnyRet',
    'EagerAny',
    'LazyAny',
    'ErrorType',
    'Unknown'
]);
const META_TYPE_NAMES = new Set<MetaTypeKind>(['Atom', 'Expression', 'Symbol', 'Variable', 'Grounded']);
const PRIMITIVE_GROUNDED_TYPES = new Set(['Number', 'String', 'Bool', 'Char', 'Integer', 'Decimal', 'Rational', 'Grounded']);

function normalizeTypeName(typeName: string): string {
    const normalized = typeName.trim();
    if (!normalized) return 'Unknown';
    if (normalized === 'Integer' || normalized === 'Decimal' || normalized === 'Rational') return 'Number';
    return normalized;
}

function createNameTypeTerm(typeName: string): TypeTerm {
    return { kind: 'name', name: normalizeTypeName(typeName) };
}

function tokenizeTypeTerm(text: string): string[] {
    const tokens: string[] = [];
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === ')') {
            if (current.trim()) tokens.push(current.trim());
            current = '';
            tokens.push(ch);
            continue;
        }
        if (/\s/.test(ch)) {
            if (current.trim()) tokens.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) tokens.push(current.trim());
    return tokens;
}

function parseTypeTerm(typeText: string): TypeTerm | null {
    const tokens = tokenizeTypeTerm(typeText.trim());
    if (tokens.length === 0) return null;

    const state = { index: 0 };
    const parsed = parseTypeTermTokens(tokens, state);
    if (!parsed || state.index !== tokens.length) return null;
    return parsed;
}

function parseTypeTermTokens(tokens: string[], state: { index: number }): TypeTerm | null {
    if (state.index >= tokens.length) return null;
    const token = tokens[state.index++];

    if (token === '(') {
        const terms: TypeTerm[] = [];
        while (state.index < tokens.length && tokens[state.index] !== ')') {
            const term = parseTypeTermTokens(tokens, state);
            if (!term) return null;
            terms.push(term);
        }
        if (state.index >= tokens.length || tokens[state.index] !== ')') return null;
        state.index++;
        if (terms.length === 0) return null;
        const [head, ...args] = terms;
        return { kind: 'compound', head, args };
    }

    if (token === ')') {
        return null;
    }

    if (token.startsWith('$')) {
        return { kind: 'var', name: token };
    }

    return createNameTypeTerm(token);
}

function typeTermToString(term: TypeTerm): string {
    if (term.kind === 'name' || term.kind === 'var') return term.name;
    const head = typeTermToString(term.head);
    const args = term.args.map(typeTermToString).join(' ');
    return args ? `(${head} ${args})` : `(${head})`;
}

function buildTypeEvidence(candidates: TypeTerm[], metaKinds: MetaTypeKind[], unknown = false): TypeEvidence {
    const uniqueCandidates: TypeTerm[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const key = typeTermToString(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueCandidates.push(candidate);
    }
    return {
        candidates: uniqueCandidates,
        metaKinds: new Set(metaKinds),
        unknown: unknown || uniqueCandidates.length === 0
    };
}

function getNodeKey(node: SyntaxNode): string {
    const start = node.startPosition;
    const end = node.endPosition;
    return `${start.row}:${start.column}-${end.row}:${end.column}:${node.type}`;
}

function typeEvidenceToString(evidence: TypeEvidence): string {
    if (evidence.candidates.length === 0) return 'Unknown';
    return evidence.candidates.map(typeTermToString).join(' | ');
}

function inferArgumentType(
    node: SyntaxNode | null,
    getTypedOverloads: (name: string) => TypedOverload[],
    cache: Map<string, TypeEvidence>,
    inProgress: Set<string>,
    mode: TypeMismatchMode
): TypeEvidence {
    if (!node) return buildTypeEvidence([], ['Atom'], true);

    const key = getNodeKey(node);
    const cached = cache.get(key);
    if (cached) return cached;

    if (inProgress.has(key)) {
        return buildTypeEvidence([], ['Expression', 'Atom'], true);
    }
    inProgress.add(key);

    let inferred: TypeEvidence;
    if (node.type === 'atom') {
        inferred = inferAtomType(node);
    } else if (node.type === 'list') {
        inferred = inferListType(node, getTypedOverloads, cache, inProgress, mode);
    } else {
        inferred = buildTypeEvidence([], ['Atom'], true);
    }

    inProgress.delete(key);
    cache.set(key, inferred);
    return inferred;
}

function inferAtomType(node: SyntaxNode): TypeEvidence {
    if (node.children.some((child) => child.type === 'number')) {
        return buildTypeEvidence([createNameTypeTerm('Number')], ['Grounded', 'Atom']);
    }
    if (node.children.some((child) => child.type === 'string')) {
        return buildTypeEvidence([createNameTypeTerm('String')], ['Grounded', 'Atom']);
    }
    if (node.children.some((child) => child.type === 'variable')) {
        return buildTypeEvidence([createNameTypeTerm('Variable')], ['Variable', 'Atom'], true);
    }

    const symbolNode = node.children.find((child) => child.type === 'symbol');
    if (!symbolNode) {
        return buildTypeEvidence([], ['Atom'], true);
    }

    if (symbolNode.text === 'True' || symbolNode.text === 'False') {
        return buildTypeEvidence([createNameTypeTerm('Bool')], ['Symbol', 'Atom']);
    }

    return buildTypeEvidence([createNameTypeTerm('Symbol')], ['Symbol', 'Atom']);
}

function inferListType(
    node: SyntaxNode,
    getTypedOverloads: (name: string) => TypedOverload[],
    cache: Map<string, TypeEvidence>,
    inProgress: Set<string>,
    mode: TypeMismatchMode
): TypeEvidence {
    const metaKinds: MetaTypeKind[] = ['Expression', 'Atom'];
    const children = getNamedChildren(node);
    if (children.length === 0) {
        return buildTypeEvidence([], metaKinds, true);
    }

    const head = children[0];
    if (head.type !== 'atom') {
        return buildTypeEvidence([], metaKinds, true);
    }

    const symbolNode = head.children.find((child) => child.type === 'symbol');
    if (!symbolNode) {
        return buildTypeEvidence([], metaKinds, true);
    }

    const name = symbolNode.text;
    if (name.startsWith('$')) {
        return buildTypeEvidence([], metaKinds, true);
    }

    const args = children.slice(1);
    const overloads = getTypedOverloads(name).filter((overload) => overload.paramTerms.length === args.length);
    if (overloads.length === 0) {
        return buildTypeEvidence([], metaKinds, true);
    }

    const argEvidence = args.map((arg) => inferArgumentType(arg, getTypedOverloads, cache, inProgress, mode));
    const returnCandidates: TypeTerm[] = [];
    let hasMatch = false;
    let unresolved = false;

    for (const overload of overloads) {
        const bindingSets = matchOverload(overload, argEvidence, mode);
        if (bindingSets.length === 0) continue;
        hasMatch = true;

        for (const bindings of bindingSets) {
            const instantiated = instantiateReturnType(overload.returnTerm, bindings);
            if (instantiated.term) {
                returnCandidates.push(instantiated.term);
            }
            unresolved = unresolved || instantiated.unresolved;
        }
    }

    if (!hasMatch) {
        unresolved = true;
    }

    return buildTypeEvidence(returnCandidates, metaKinds, unresolved);
}

function matchOverload(
    overload: TypedOverload,
    argTypes: TypeEvidence[],
    mode: TypeMismatchMode
): Map<string, TypeTerm>[] {
    let bindingsList: Map<string, TypeTerm>[] = [new Map<string, TypeTerm>()];

    for (let i = 0; i < overload.paramTerms.length; i++) {
        const expected = overload.paramTerms[i];
        const actualEvidence = argTypes[i] ?? buildTypeEvidence([], ['Atom'], true);
        const nextBindings: Map<string, TypeTerm>[] = [];

        for (const bindings of bindingsList) {
            const matchedBindings = matchExpectedToEvidence(expected, actualEvidence, bindings, mode);
            nextBindings.push(...matchedBindings);
        }

        if (nextBindings.length === 0) return [];
        bindingsList = dedupeBindings(nextBindings);
    }

    return bindingsList;
}

function matchExpectedToEvidence(
    expected: TypeTerm,
    evidence: TypeEvidence,
    bindings: Map<string, TypeTerm>,
    mode: TypeMismatchMode
): Map<string, TypeTerm>[] {
    const matched: Map<string, TypeTerm>[] = [];
    const canAcceptUnknown = mode === 'runtime' || isPermissiveExpected(expected);

    if (isMetaExpected(expected)) {
        if (matchesMetaExpected(expected, evidence, mode) || (evidence.unknown && canAcceptUnknown)) {
            matched.push(new Map(bindings));
        }
        return matched;
    }

    if (isExpressionLikeExpected(expected) && evidence.metaKinds.has('Expression') && (mode === 'runtime' || evidence.unknown)) {
        matched.push(new Map(bindings));
    }

    for (const candidate of evidence.candidates) {
        const nextBindings = new Map(bindings);
        if (matchTypeTerms(expected, candidate, nextBindings, mode)) {
            matched.push(nextBindings);
        }
    }

    if (matched.length === 0 && evidence.unknown && canAcceptUnknown) {
        matched.push(new Map(bindings));
    }

    return dedupeBindings(matched);
}

function dedupeBindings(bindingsList: Map<string, TypeTerm>[]): Map<string, TypeTerm>[] {
    const unique: Map<string, TypeTerm>[] = [];
    const seen = new Set<string>();

    for (const bindings of bindingsList) {
        const key = Array.from(bindings.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, term]) => `${name}:${typeTermToString(term)}`)
            .join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(bindings);
    }

    return unique;
}

function isMetaExpected(expected: TypeTerm): expected is { kind: 'name'; name: string } {
    return expected.kind === 'name' && META_TYPE_NAMES.has(normalizeTypeName(expected.name) as MetaTypeKind);
}

function isExpressionLikeExpected(expected: TypeTerm): boolean {
    if (expected.kind === 'name') {
        return normalizeTypeName(expected.name) === 'Expression';
    }
    if (expected.kind === 'compound' && expected.head.kind === 'name') {
        return normalizeTypeName(expected.head.name) === 'Expression';
    }
    return false;
}

function isPermissiveExpected(expected: TypeTerm): boolean {
    if (expected.kind === 'var') return true;
    if (expected.kind === 'name') {
        const name = normalizeTypeName(expected.name);
        return UNIVERSAL_TYPE_NAMES.has(name) || META_TYPE_NAMES.has(name as MetaTypeKind);
    }
    return isExpressionLikeExpected(expected);
}

function matchesMetaExpected(
    expected: { kind: 'name'; name: string },
    evidence: TypeEvidence,
    mode: TypeMismatchMode
): boolean {
    const expectedName = normalizeTypeName(expected.name);
    if (expectedName === 'Atom') return true;
    if (expectedName === 'Expression') {
        return evidence.metaKinds.has('Expression') || evidence.candidates.some(isExpressionTypeTerm) || (mode === 'runtime' && evidence.unknown);
    }
    if (expectedName === 'Symbol') {
        return evidence.metaKinds.has('Symbol') || evidence.candidates.some((term) => getTermName(term) === 'Symbol');
    }
    if (expectedName === 'Variable') {
        return evidence.metaKinds.has('Variable') || evidence.candidates.some((term) => getTermName(term) === 'Variable') || (mode === 'runtime' && evidence.unknown);
    }
    if (expectedName === 'Grounded') {
        return evidence.metaKinds.has('Grounded') || evidence.candidates.some(isGroundedTypeTerm) || (mode === 'runtime' && evidence.unknown);
    }
    return false;
}

function getTermName(term: TypeTerm): string | null {
    if (term.kind === 'name') return normalizeTypeName(term.name);
    return null;
}

function isGroundedTypeTerm(term: TypeTerm): boolean {
    const name = getTermName(term);
    return name !== null && PRIMITIVE_GROUNDED_TYPES.has(name);
}

function isExpressionTypeTerm(term: TypeTerm): boolean {
    if (term.kind === 'name') return normalizeTypeName(term.name) === 'Expression';
    if (term.kind === 'compound' && term.head.kind === 'name') {
        return normalizeTypeName(term.head.name) === 'Expression';
    }
    return false;
}

function isUnknownLikeTypeName(typeName: string): boolean {
    return UNIVERSAL_TYPE_NAMES.has(typeName) || typeName === 'Variable' || typeName.startsWith('$');
}

function matchTypeTerms(
    expected: TypeTerm,
    actual: TypeTerm,
    bindings: Map<string, TypeTerm>,
    mode: TypeMismatchMode
): boolean {
    if (expected.kind === 'name') {
        const expectedName = normalizeTypeName(expected.name);
        if (UNIVERSAL_TYPE_NAMES.has(expectedName)) return true;
    }

    if (expected.kind === 'var') {
        const existing = bindings.get(expected.name);
        if (existing) {
            return matchTypeTerms(existing, actual, bindings, mode);
        }
        bindings.set(expected.name, actual);
        return true;
    }

    if (actual.kind === 'var') {
        return mode === 'runtime';
    }

    if (actual.kind === 'name') {
        const actualName = normalizeTypeName(actual.name);
        if (actualName === '%Undefined%' || actualName === 'Atom') return true;
        if (mode === 'runtime' && isUnknownLikeTypeName(actualName)) return true;
    }

    if (expected.kind === 'name' && actual.kind === 'name') {
        const expectedName = normalizeTypeName(expected.name);
        const actualName = normalizeTypeName(actual.name);
        if (expectedName === actualName) return true;
        if (expectedName === 'Grounded' && PRIMITIVE_GROUNDED_TYPES.has(actualName)) return true;
        return false;
    }

    if (expected.kind === 'compound' && actual.kind === 'compound') {
        if (!matchTypeTerms(expected.head, actual.head, bindings, mode)) return false;
        if (expected.args.length !== actual.args.length) return false;
        for (let i = 0; i < expected.args.length; i++) {
            if (!matchTypeTerms(expected.args[i], actual.args[i], bindings, mode)) return false;
        }
        return true;
    }

    if (expected.kind === 'compound' && actual.kind === 'name') {
        const actualName = normalizeTypeName(actual.name);
        return mode === 'runtime' && isUnknownLikeTypeName(actualName);
    }

    if (expected.kind === 'name' && actual.kind === 'compound') {
        const expectedName = normalizeTypeName(expected.name);
        if (expectedName === 'Expression') return true;
        return false;
    }

    return false;
}

function instantiateReturnType(
    returnType: TypeTerm | null,
    bindings: Map<string, TypeTerm>
): { term: TypeTerm | null; unresolved: boolean } {
    if (!returnType) {
        return { term: null, unresolved: true };
    }

    if (returnType.kind === 'var') {
        const bound = bindings.get(returnType.name);
        if (!bound) {
            return { term: createNameTypeTerm('Unknown'), unresolved: true };
        }
        return { term: bound, unresolved: false };
    }

    if (returnType.kind === 'name') {
        const normalized = normalizeTypeName(returnType.name);
        return {
            term: createNameTypeTerm(normalized),
            unresolved: isUnknownLikeTypeName(normalized)
        };
    }

    const headInstantiated = instantiateReturnType(returnType.head, bindings);
    const args: TypeTerm[] = [];
    let unresolved = headInstantiated.unresolved;

    for (const arg of returnType.args) {
        const instantiatedArg = instantiateReturnType(arg, bindings);
        args.push(instantiatedArg.term ?? createNameTypeTerm('Unknown'));
        unresolved = unresolved || instantiatedArg.unresolved;
    }

    return {
        term: {
            kind: 'compound',
            head: headInstantiated.term ?? createNameTypeTerm('Unknown'),
            args
        },
        unresolved
    };
}

function hasTypedOverloadForArity(
    name: string,
    arity: number,
    getTypedOverloads: (name: string) => TypedOverload[]
): boolean {
    return getTypedOverloads(name)
        .some((overload) => overload.paramTypes.length === arity);
}

function inferDefinitionArity(nameNode: SyntaxNode | null): number {
    if (!nameNode || !nameNode.parent || !nameNode.parent.parent) return 0;

    const atomNode = nameNode.parent;
    const listNode = atomNode.parent;
    if (!listNode || atomNode.type !== 'atom' || listNode.type !== 'list') return 0;

    const named = getNamedChildren(listNode);
    if (named.length === 0 || named[0] !== atomNode) return 0;
    return Math.max(0, named.length - 1);
}

function getEntryArity(entry: SymbolEntry | undefined | null): number | null {
    if (!entry) return null;

    if (entry.op === '=' && Array.isArray(entry.parameters)) {
        return entry.parameters.length;
    }

    if (entry.op === ':' && entry.typeSignature) {
        return arityFromTypeSignature(entry.typeSignature);
    }

    return null;
}

function getDefinitionEntryArity(entry: SymbolEntry | undefined | null): number | null {
    if (!entry || entry.op !== '=') return null;
    if (Array.isArray(entry.parameters)) return entry.parameters.length;
    return 0;
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

function formatExpectedArities(arities: number[]): string {
    if (arities.length === 0) return 'unknown';
    if (arities.length === 1) return `${arities[0]}`;
    return arities.join(' or ');
}

function validateUndefinedVariables(rootNode: SyntaxNode, diagnostics: Diagnostic[]): void {
    function getVariableNameFromAtom(atomNode: SyntaxNode | null): string | null {
        if (!atomNode || atomNode.type !== 'atom') return null;
        const variableNode = atomNode.children.find((child) => child.type === 'variable');
        return variableNode ? variableNode.text : null;
    }

    function collectPatternVariables(patternNode: SyntaxNode | null, out: Set<string> = new Set()): Set<string> {
        if (!patternNode) return out;

        if (patternNode.type === 'atom') {
            const variableName = getVariableNameFromAtom(patternNode);
            if (variableName) out.add(variableName);
            return out;
        }

        if (patternNode.type === 'list') {
            for (const part of getNamedChildren(patternNode)) {
                collectPatternVariables(part, out);
            }
        }

        return out;
    }

    function reportUndefined(variableNode: SyntaxNode): void {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: {
                    line: variableNode.startPosition.row,
                    character: variableNode.startPosition.column
                },
                end: {
                    line: variableNode.endPosition.row,
                    character: variableNode.endPosition.column
                }
            },
            message: `Undefined variable '${variableNode.text}'`,
            source: 'metta-lsp'
        });
    }

    function visit(node: SyntaxNode | null, env: Set<string>, checkVars: boolean): void {
        if (!node) return;

        if (node.type === 'atom') {
            if (!checkVars) return;
            const variableNode = node.children.find((child) => child.type === 'variable');
            if (!variableNode) return;
            if (!env.has(variableNode.text)) {
                reportUndefined(variableNode);
            }
            return;
        }

        if (node.type !== 'list') {
            for (let i = 0; i < node.namedChildCount; i++) {
                visit(node.namedChild(i), env, checkVars);
            }
            return;
        }

        const children = getNamedChildren(node);
        if (children.length === 0) return;
        const headSymbol = getHeadSymbol(node);

        if (headSymbol === '=') {
            const defHead = children[1] ?? null;
            const bodyNodes = children.slice(2);
            const localEnv = new Set(env);

            if (defHead && defHead.type === 'list') {
                const signatureParts = getNamedChildren(defHead);
                for (let i = 1; i < signatureParts.length; i++) {
                    for (const variableName of collectPatternVariables(signatureParts[i])) {
                        localEnv.add(variableName);
                    }
                }
            }

            for (const bodyNode of bodyNodes) {
                visit(bodyNode, localEnv, true);
            }
            return;
        }

        if (headSymbol === 'let') {
            if (!checkVars) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    visit(node.namedChild(i), env, checkVars);
                }
                return;
            }

            const binderAtom = children[1] ?? null;
            const exprNode = children[2] ?? null;
            const bodyNodes = children.slice(3);

            if (exprNode) visit(exprNode, env, true);

            const localEnv = new Set(env);
            for (const variableName of collectPatternVariables(binderAtom)) {
                localEnv.add(variableName);
            }

            for (const bodyNode of bodyNodes) {
                visit(bodyNode, localEnv, true);
            }
            return;
        }

        if (headSymbol === 'let*') {
            if (!checkVars) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    visit(node.namedChild(i), env, checkVars);
                }
                return;
            }

            const bindingsList = children[1] ?? null;
            const bodyNodes = children.slice(2);
            const localEnv = new Set(env);

            if (bindingsList && bindingsList.type === 'list') {
                const bindings = getNamedChildren(bindingsList).filter((child) => child.type === 'list');
                for (const binding of bindings) {
                    const bindingParts = getNamedChildren(binding);
                    if (bindingParts.length === 0) continue;

                    const binderAtom = bindingParts[0];
                    const valueParts = bindingParts.slice(1);
                    for (const valueNode of valueParts) {
                        visit(valueNode, localEnv, true);
                    }

                    for (const variableName of collectPatternVariables(binderAtom)) {
                        localEnv.add(variableName);
                    }
                }
            }

            for (const bodyNode of bodyNodes) {
                visit(bodyNode, localEnv, true);
            }
            return;
        }

        for (const child of children) {
            visit(child, env, checkVars);
        }
    }

    visit(rootNode, new Set<string>(), false);
}

function traverseTree(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) traverseTree(child, callback);
    }
}
