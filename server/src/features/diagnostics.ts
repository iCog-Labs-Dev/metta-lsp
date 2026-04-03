import Parser from 'tree-sitter';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type Analyzer from '../analyzer';
import type { DiagnosticSettings, SymbolEntry } from '../types';
import { BUILTIN_META, BUILTIN_SYMBOLS, BUILTIN_TYPE_NAMES, normalizeUri, type BuiltinMeta } from '../utils';

type SyntaxNode = Parser.SyntaxNode;

interface TypedOverload {
    paramTypes: string[];
    returnType: string | null;
    paramTerms: TypeTerm[];
    returnTerm: TypeTerm | null;
}

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

type ActiveBindingKind = 'parameter' | 'local';

function getNamedChildren(node: SyntaxNode): SyntaxNode[] {
    return node.children.filter((child) => child.type === 'atom' || child.type === 'list');
}

function isSameNode(left: SyntaxNode | null, right: SyntaxNode | null): boolean {
    if (!left || !right) return false;
    return left.type === right.type &&
        left.startIndex === right.startIndex &&
        left.endIndex === right.endIndex;
}

function findNamedChildIndex(parent: SyntaxNode, target: SyntaxNode): number {
    const named = getNamedChildren(parent);
    return named.findIndex((child) => isSameNode(child, target));
}

function getHeadSymbol(listNode: SyntaxNode): string | null {
    if (listNode.type !== 'list') return null;
    const children = getNamedChildren(listNode);
    if (children.length === 0 || children[0].type !== 'atom') return null;
    const symbolNode = children[0].children.find((child) => child.type === 'symbol');
    return symbolNode ? symbolNode.text : null;
}

function getAtomSymbol(atomNode: SyntaxNode | null): string | null {
    if (!atomNode || atomNode.type !== 'atom') return null;
    const symbolNode = atomNode.children.find((child) => child.type === 'symbol');
    return symbolNode ? symbolNode.text : null;
}

function getAtomSymbolNode(atomNode: SyntaxNode | null): SyntaxNode | null {
    if (!atomNode || atomNode.type !== 'atom') return null;
    const symbolNode = atomNode.children.find((child) => child.type === 'symbol');
    return symbolNode ?? null;
}

function getAtomVariable(atomNode: SyntaxNode | null): string | null {
    if (!atomNode || atomNode.type !== 'atom') return null;
    const variableNode = atomNode.children.find((child) => child.type === 'variable');
    return variableNode ? variableNode.text : null;
}

function isRedeclarationExemptVariable(name: string): boolean {
    return name === '$_';
}

function isIgnorableSibling(node: SyntaxNode | null): boolean {
    if (!node) return true;
    if (node.type === 'comment') return true;
    if (node.type === '\n') return true;
    return node.text.trim() === '';
}

function isCallableEntry(entry: SymbolEntry): boolean {
    return entry.op === '=' || entry.op === 'macro' || entry.op === 'defmacro' || entry.op === 'bind!';
}

function isLikelySymbolName(name: string): boolean {
    if (!name) return false;
    return /^[^\d\.$()\s";][^()\s";]*$/u.test(name);
}

function containsParseError(node: SyntaxNode): boolean {
    if (node.isMissing || node.type === 'ERROR') {
        return true;
    }

    const stack: SyntaxNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) continue;
        if (current.isMissing || current.type === 'ERROR') {
            return true;
        }
        for (const child of current.children) {
            stack.push(child);
        }
    }

    return false;
}

function collectPatternVariableNodes(
    patternNode: SyntaxNode | null,
    out: SyntaxNode[] = []
): SyntaxNode[] {
    if (!patternNode) return out;

    if (patternNode.type === 'atom') {
        const variableNode = patternNode.children.find((child) => child.type === 'variable');
        if (variableNode) out.push(variableNode);
        return out;
    }

    if (patternNode.type === 'list') {
        for (const child of getNamedChildren(patternNode)) {
            collectPatternVariableNodes(child, out);
        }
    }

    return out;
}

export function validateTextDocument(
    document: TextDocument,
    analyzer: Analyzer,
    settings: Partial<DiagnosticSettings> = {}
): Diagnostic[] {
    const diagnosticsSettings: DiagnosticSettings = {
        duplicateDefinitions: settings.duplicateDefinitions !== false,
        duplicateDefinitionsMode: settings.duplicateDefinitionsMode === 'global' ? 'global' : 'local',
        undefinedFunctions: settings.undefinedFunctions === true,
        undefinedTypes: settings.undefinedTypes === true,
        undefinedVariables: settings.undefinedVariables === true,
        undefinedBindings: settings.undefinedBindings === true,
        typeMismatchEnabled: settings.typeMismatchEnabled !== false,
        argumentCountMismatchEnabled: settings.argumentCountMismatchEnabled !== false,
        shadowingHints: settings.shadowingHints === true
    };

    const text = document.getText();
    const sourceUri = normalizeUri(document.uri);
    const tree = analyzer.getTreeForDocument(sourceUri, text);
    if (!tree) {
        return [];
    }
    const diagnostics: Diagnostic[] = [];
    const syntaxDiagnostics: Diagnostic[] = [];
    const topLevelEvaluatedForms = collectTopLevelEvaluatedForms(tree.rootNode);
    const isInEvaluatedContext = (node: SyntaxNode): boolean =>
        topLevelEvaluatedForms.some((form) => isDescendantOf(node, form));
    const isInRuleBodyContext = (node: SyntaxNode): boolean => {
        let current: SyntaxNode | null = node;
        while (current) {
            const parent: SyntaxNode | null = current.parent;
            if (!parent || parent.type !== 'list') {
                current = parent;
                continue;
            }

            const parentNamed = getNamedChildren(parent);
            const parentHead = parentNamed[0]?.text;
            if (parentHead === '=' || parentHead === 'macro' || parentHead === 'defmacro') {
                const childIndex = findNamedChildIndex(parent, current);
                if (childIndex >= 2) return true;
                if (childIndex === 1) return false;
            }

            current = parent;
        }
        return false;
    };
    const isInArityCheckedContext = (node: SyntaxNode): boolean =>
        isInEvaluatedContext(node) || isInRuleBodyContext(node);
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
    const knownAtomSpaceSymbols = validateSpaceBindingOrderAndCollectAtoms(
        topLevelEvaluatedForms,
        sourceUri,
        diagnostics,
        getVisibleEntries
    );

    traverseTree(tree.rootNode, (node) => {
        if (node.isMissing) {
            if (isInsideModuleDirective(node)) return;
            syntaxDiagnostics.push({
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
            syntaxDiagnostics.push({
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
    validateAmbiguousBangSymbols(tree.rootNode, diagnostics);
    validateVariableEdgeCases(tree.rootNode, diagnostics);
    validateEqualsDefinitionShape(tree.rootNode, diagnostics);
    validateLocalBindingRedeclarations(tree.rootNode, diagnostics);

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

    traverseTree(tree.rootNode, (node) => {
        if (node.type !== 'list') return;
        if (!isInArityCheckedContext(node)) return;
        if (containsParseError(node)) return;

        const namedChildren = getNamedChildren(node);
        if (namedChildren.length === 0) return;

        const head = namedChildren[0];
        if (head.type !== 'atom') return;
        const symbolNode = head.children.find((child) => child.type === 'symbol');
        if (!symbolNode) return;

        const name = symbolNode.text;
        const isBuiltinSymbol = BUILTIN_SYMBOLS.has(name);
        const isKnownOperator = validOperators.has(name);
        if (!isLikelySymbolName(name)) return;
        if (boundSymbols.has(name)) return;
        if (name.startsWith('$')) return;
        if (isInsideCaseBranches(node)) return;
        if (isInsideTypeExpression(node)) return;

        const parent = node.parent;
        if (parent && parent.type === 'list') {
            const parentNamed = getNamedChildren(parent);
            if (parentNamed[0]?.text === '=' && isSameNode(parentNamed[1] ?? null, node)) {
                return;
            }
        }

        const grandParent = node.parent;
        if (grandParent && grandParent.type === 'list') {
            const grandParentNamed = getNamedChildren(grandParent);
            if (grandParentNamed[0]?.text === ':' && isSameNode(grandParentNamed[1] ?? null, head)) {
                return;
            }
        }

        const definitions = getVisibleEntries(name);
        const callableDefinitions = definitions.filter(isCallableEntry);
        const builtinTypedArities = (isBuiltinSymbol || isKnownOperator)
            ? Array.from(
                new Set(
                    getTypedOverloads(name).map((overload) => overload.paramTypes.length)
                )
            ).sort((a, b) => a - b)
            : [];

        if (callableDefinitions.length === 0 && builtinTypedArities.length === 0) {
            if (diagnosticsSettings.undefinedFunctions) {
                if (isBuiltinSymbol || isKnownOperator) return;
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Undefined function '${name}'`,
                    source: 'metta-lsp'
                });
            }
            return;
        }

        const callArity = namedChildren.length - 1;
        const matchingDefinitions = callableDefinitions.filter((definition) => {
            const arity = getEntryArity(definition);
            return arity === null || arity === callArity;
        });
        const hasTypedArityMatch = builtinTypedArities.includes(callArity);

        const concreteDefinitionArities = Array.from(
            new Set(
                callableDefinitions
                    .map(getEntryArity)
                    .filter((arity): arity is number => arity !== null)
            )
        ).sort((a, b) => a - b);
        const concreteArities = Array.from(
            new Set([...concreteDefinitionArities, ...builtinTypedArities])
        ).sort((a, b) => a - b);

        if (
            concreteArities.length > 0 &&
            matchingDefinitions.length === 0 &&
            !hasTypedArityMatch
        ) {
            if (diagnosticsSettings.argumentCountMismatchEnabled) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Argument count mismatch for '${name}': expected ${formatExpectedArities(concreteArities)}, got ${callArity}`,
                    source: 'metta-lsp'
                });
            }
        } else if (
            matchingDefinitions.length > 1 &&
            !hasTypedArityMatch
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

    if (diagnosticsSettings.undefinedTypes) {
        const reportUndefinedType = (symbolNode: SyntaxNode, name: string): void => {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                    end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                },
                message: `Undefined type '${name}'`,
                source: 'metta-lsp'
            });
        };

        traverseTree(tree.rootNode, (node) => {
            if (node.type !== 'list') return;
            const namedChildren = getNamedChildren(node);
            if (namedChildren.length < 3) return;
            if (getHeadSymbol(node) !== ':') return;

            const typeExpression = namedChildren[2] ?? null;
            validateUndefinedTypesInTypeExpression(
                typeExpression,
                getVisibleEntries,
                reportUndefinedType
            );
        });
    }

    if (diagnosticsSettings.undefinedBindings) {
        traverseTree(tree.rootNode, (node) => {
            if (node.type !== 'list') return;
            if (isInsideCaseBranches(node)) return;
            if (isInsideTypeExpression(node)) return;
            if (containsParseError(node)) return;

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
            if (headName === ':') {
                return;
            }

            for (let i = 1; i < namedChildren.length; i++) {
                const child = namedChildren[i];
                if (child.type !== 'atom') continue;

                const symbolNode = child.children.find((nodeChild) => nodeChild.type === 'symbol');
                if (!symbolNode) continue;

                const name = symbolNode.text;
                if (!isLikelySymbolName(name)) continue;
                if (BUILTIN_SYMBOLS.has(name)) continue;
                if (name === '&self') continue;
                if (name.startsWith('&')) continue;
                if (boundSymbols.has(name)) continue;
                if (knownAtomSpaceSymbols.has(name)) continue;

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
                if (headName === 'py-atom' && i === 1) {
                    // The first py-atom argument is a Python-side callable path, not a MeTTa binding.
                    continue;
                }

                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                    },
                    message: `Undefined symbol '${name}'`,
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
            getTypedOverloads
        );
        validateDefinitionTypeContracts(
            tree.rootNode,
            diagnostics,
            getVisibleEntries,
            getTypedOverloads
        );
    }

    if (diagnosticsSettings.undefinedVariables) {
        validateUndefinedVariables(tree.rootNode, diagnostics);
    }
    const hasPrimaryErrors = diagnostics.some(
        (diagnostic) => (diagnostic.severity ?? DiagnosticSeverity.Error) === DiagnosticSeverity.Error
    );
    if (hasPrimaryErrors) {
        for (const diagnostic of syntaxDiagnostics) {
            diagnostic.severity = DiagnosticSeverity.Warning;
        }
    }
    return diagnostics.concat(syntaxDiagnostics);
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

function validateAmbiguousBangSymbols(rootNode: SyntaxNode, diagnostics: Diagnostic[]): void {
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const node = rootNode.namedChild(i);
        if (!node || node.type !== 'atom') continue;

        const symbolNode = node.children.find((child) => child.type === 'symbol');
        if (!symbolNode) continue;

        const symbolText = symbolNode.text;
        if (!symbolText.startsWith('!') || symbolText === '!') continue;

        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: {
                start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
            },
            message: `Ambiguous symbol '${symbolText}': if you intended evaluation, separate '!' from the atom`,
            source: 'metta-lsp'
        });
    }
}

function validateVariableEdgeCases(rootNode: SyntaxNode, diagnostics: Diagnostic[]): void {
    traverseTree(rootNode, (node) => {
        if (node.type !== 'variable') return;
        const variableText = node.text;

        if (variableText.includes('#')) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column }
                },
                message: `Invalid variable '${variableText}': '#' is reserved and should not appear in variable names`,
                source: 'metta-lsp'
            });
        }

        if (variableText.includes(';')) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column }
                },
                message: `Suspicious variable '${variableText}': ';' may be parsed as part of the variable instead of starting a comment`,
                source: 'metta-lsp'
            });
        }
    });
}

function validateEqualsDefinitionShape(rootNode: SyntaxNode, diagnostics: Diagnostic[]): void {
    function report(node: SyntaxNode, message: string): void {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: { line: node.startPosition.row, character: node.startPosition.column },
                end: { line: node.endPosition.row, character: node.endPosition.column }
            },
            message,
            source: 'metta-lsp'
        });
    }

    traverseTree(rootNode, (node) => {
        if (node.type !== 'list') return;
        if (node.parent?.type !== 'source_file') return;
        if (containsParseError(node)) return;
        if (getHeadSymbol(node) !== '=') return;

        const namedChildren = getNamedChildren(node);
        if (namedChildren.length < 2) return;

        const definitionHead = namedChildren[1] ?? null;
        if (!definitionHead || definitionHead.type !== 'list') {
            report(
                definitionHead ?? node,
                `Invalid '=' definition: expected a signature list of the form '(name ...)'`
            );
            return;
        }

        const signatureParts = getNamedChildren(definitionHead);
        if (signatureParts.length === 0 || !getAtomSymbol(signatureParts[0] ?? null)) {
            report(
                definitionHead,
                `Invalid '=' definition: expected a function name symbol as the first item in the signature`
            );
            return;
        }

        if (namedChildren.length !== 3) {
            const functionName = getAtomSymbol(signatureParts[0] ?? null) ?? 'definition';
            report(
                node,
                `Invalid '=' definition for '${functionName}': expected exactly one implementation expression`
            );
        }
    });
}

function validateLocalBindingRedeclarations(rootNode: SyntaxNode, diagnostics: Diagnostic[]): void {
    function report(node: SyntaxNode, message: string): void {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: { line: node.startPosition.row, character: node.startPosition.column },
                end: { line: node.endPosition.row, character: node.endPosition.column }
            },
            message,
            source: 'metta-lsp'
        });
    }

    function collectDefinitionParameters(signatureNode: SyntaxNode | null): Map<string, ActiveBindingKind> {
        const bindings = new Map<string, ActiveBindingKind>();
        if (!signatureNode || signatureNode.type !== 'list') return bindings;

        const signatureParts = getNamedChildren(signatureNode);
        for (let i = 1; i < signatureParts.length; i++) {
            for (const variableNode of collectPatternVariableNodes(signatureParts[i])) {
                if (!bindings.has(variableNode.text)) {
                    bindings.set(variableNode.text, 'parameter');
                }
            }
        }

        return bindings;
    }

    function extendBindings(
        activeBindings: ReadonlyMap<string, ActiveBindingKind>,
        names: Iterable<string>
    ): Map<string, ActiveBindingKind> {
        const next = new Map(activeBindings);
        for (const name of names) {
            next.set(name, 'local');
        }
        return next;
    }

    function validateBinderPattern(
        binderNode: SyntaxNode | null,
        activeBindings: ReadonlyMap<string, ActiveBindingKind>,
        binderKind: 'let' | 'let*' | 'chain'
    ): Set<string> {
        const introducedNames = new Set<string>();

        for (const variableNode of collectPatternVariableNodes(binderNode)) {
            const variableName = variableNode.text;

            if (isRedeclarationExemptVariable(variableName)) {
                introducedNames.add(variableName);
                continue;
            }

            if (introducedNames.has(variableName)) {
                report(variableNode, `Duplicate variable '${variableName}' in ${binderKind} binding pattern`);
                continue;
            }

            const activeKind = activeBindings.get(variableName);
            if (activeKind === 'parameter') {
                report(variableNode, `Invalid ${binderKind} binding '${variableName}': cannot redeclare function parameter`);
            } else if (activeKind === 'local') {
                report(variableNode, `Invalid ${binderKind} binding '${variableName}': cannot redeclare active local binding`);
            }

            introducedNames.add(variableName);
        }

        return introducedNames;
    }

    function visit(
        node: SyntaxNode | null,
        activeBindings: ReadonlyMap<string, ActiveBindingKind>,
        checkBindings: boolean
    ): void {
        if (!node) return;

        if (node.type !== 'list') {
            for (let i = 0; i < node.namedChildCount; i++) {
                visit(node.namedChild(i), activeBindings, checkBindings);
            }
            return;
        }

        const children = getNamedChildren(node);
        if (children.length === 0) return;

        const headSymbol = getHeadSymbol(node);

        if (headSymbol === '=') {
            const definitionBindings = collectDefinitionParameters(children[1] ?? null);
            for (const bodyNode of children.slice(2)) {
                visit(bodyNode, definitionBindings, true);
            }
            return;
        }

        if (headSymbol === 'let') {
            if (!checkBindings) {
                for (const child of children) {
                    visit(child, activeBindings, checkBindings);
                }
                return;
            }

            const binderNode = children[1] ?? null;
            const valueNode = children[2] ?? null;
            if (valueNode) {
                visit(valueNode, activeBindings, true);
            }

            const bodyBindings = extendBindings(
                activeBindings,
                validateBinderPattern(binderNode, activeBindings, 'let')
            );

            for (const bodyNode of children.slice(3)) {
                visit(bodyNode, bodyBindings, true);
            }
            return;
        }

        if (headSymbol === 'let*') {
            if (!checkBindings) {
                for (const child of children) {
                    visit(child, activeBindings, checkBindings);
                }
                return;
            }

            let sequentialBindings = new Map(activeBindings);
            const bindingsListNode = children[1] ?? null;

            if (bindingsListNode && bindingsListNode.type === 'list') {
                const bindingPairs = getNamedChildren(bindingsListNode).filter((child) => child.type === 'list');
                for (const bindingPair of bindingPairs) {
                    const bindingParts = getNamedChildren(bindingPair);
                    const binderNode = bindingParts[0] ?? null;

                    for (const valueNode of bindingParts.slice(1)) {
                        visit(valueNode, sequentialBindings, true);
                    }

                    sequentialBindings = extendBindings(
                        sequentialBindings,
                        validateBinderPattern(binderNode, sequentialBindings, 'let*')
                    );
                }
            }

            for (const bodyNode of children.slice(2)) {
                visit(bodyNode, sequentialBindings, true);
            }
            return;
        }

        if (headSymbol === 'chain') {
            if (!checkBindings) {
                for (const child of children) {
                    visit(child, activeBindings, checkBindings);
                }
                return;
            }

            const valueNode = children[1] ?? null;
            const binderNode = children[2] ?? null;
            if (valueNode) {
                visit(valueNode, activeBindings, true);
            }

            const bodyBindings = extendBindings(
                activeBindings,
                validateBinderPattern(binderNode, activeBindings, 'chain')
            );

            for (const bodyNode of children.slice(3)) {
                visit(bodyNode, bodyBindings, true);
            }
            return;
        }

        for (const child of children) {
            visit(child, activeBindings, checkBindings);
        }
    }

    traverseTree(rootNode, (node) => {
        if (node.type !== 'list' || getHeadSymbol(node) !== '=') {
            return;
        }

        if (node.parent?.type !== 'source_file') {
            return;
        }

        const children = getNamedChildren(node);
        const definitionBindings = collectDefinitionParameters(children[1] ?? null);
        for (const bodyNode of children.slice(2)) {
            visit(bodyNode, definitionBindings, true);
        }
    });

    for (const form of collectTopLevelEvaluatedForms(rootNode)) {
        visit(form, new Map(), true);
    }
}

function isInsideCaseBranches(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current && current.parent) {
        const maybeCaseCall = current.parent;
        if (maybeCaseCall.type === 'list') {
            const named = getNamedChildren(maybeCaseCall);
            if (named.length >= 3 && named[0].type === 'atom' && named[0].text === 'case') {
                if (isSameNode(named[2] ?? null, current)) {
                    return true;
                }
            }
        }
        current = current.parent;
    }
    return false;
}

function isDescendantOf(node: SyntaxNode | null, ancestor: SyntaxNode | null): boolean {
    if (!node || !ancestor) return false;
    let current: SyntaxNode | null = node;
    while (current) {
        if (isSameNode(current, ancestor)) return true;
        current = current.parent;
    }
    return false;
}

function isInsideTypeExpression(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current) {
        const parent: SyntaxNode | null = current.parent;
        if (!parent || parent.type !== 'list') {
            current = parent;
            continue;
        }

        const named = getNamedChildren(parent);
        if (named.length >= 3 && named[0].text === ':' && isDescendantOf(node, named[2])) {
            return true;
        }
        current = parent;
    }
    return false;
}

function isBuiltinTypeName(name: string): boolean {
    if (!name || name.startsWith('$')) return true;
    if (name === '->') return true;

    const normalized = normalizeTypeName(name);
    if (BUILTIN_TYPE_NAMES.has(normalized)) return true;
    if (UNIVERSAL_TYPE_NAMES.has(normalized)) return true;
    if (META_TYPE_NAMES.has(normalized as MetaTypeKind)) return true;
    if (PRIMITIVE_GROUNDED_TYPES.has(normalized)) return true;
    return false;
}

function hasVisibleTypeDefinition(
    name: string,
    getVisibleEntries: (name: string) => SymbolEntry[]
): boolean {
    return getVisibleEntries(name).some((entry) => entry.op === ':');
}

function validateUndefinedTypesInTypeExpression(
    node: SyntaxNode | null,
    getVisibleEntries: (name: string) => SymbolEntry[],
    reportUndefinedType: (symbolNode: SyntaxNode, name: string) => void
): void {
    if (!node) return;

    if (node.type === 'atom') {
        const symbolNode = node.children.find((child) => child.type === 'symbol');
        if (!symbolNode) return;

        const name = symbolNode.text;
        if (name.startsWith('$')) return;
        if (isBuiltinTypeName(name)) return;
        if (hasVisibleTypeDefinition(name, getVisibleEntries)) return;
        reportUndefinedType(symbolNode, name);
        return;
    }

    if (node.type !== 'list') return;

    const named = getNamedChildren(node);
    if (named.length === 0) return;
    const headName = getHeadSymbol(node);
    const startIndex = headName === '->' ? 1 : 0;

    for (let i = startIndex; i < named.length; i++) {
        validateUndefinedTypesInTypeExpression(
            named[i],
            getVisibleEntries,
            reportUndefinedType
        );
    }
}

function findImmediateTypeSignatureForDefinition(
    definitionNode: SyntaxNode,
    functionName: string
): string | null {
    let prev: SyntaxNode | null = definitionNode.previousSibling;
    while (prev && isIgnorableSibling(prev)) {
        prev = prev.previousSibling;
    }
    if (!prev || prev.type !== 'list') return null;
    if (getHeadSymbol(prev) !== ':') return null;

    const named = getNamedChildren(prev);
    if (named.length < 3) return null;
    if (getAtomSymbol(named[1]) !== functionName) return null;
    return named[2]?.text ?? null;
}

function collectPatternVariablesForTypeEnv(
    patternNode: SyntaxNode | null,
    out: Set<string> = new Set()
): Set<string> {
    if (!patternNode) return out;

    if (patternNode.type === 'atom') {
        const variableName = getAtomVariable(patternNode);
        if (variableName) out.add(variableName);
        return out;
    }

    if (patternNode.type === 'list') {
        for (const part of getNamedChildren(patternNode)) {
            collectPatternVariablesForTypeEnv(part, out);
        }
    }

    return out;
}

function buildParameterTypeEnvironment(
    parameterNodes: SyntaxNode[],
    parameterTypes: TypeTerm[]
): Map<string, TypeTerm> {
    const env = new Map<string, TypeTerm>();
    const count = Math.min(parameterNodes.length, parameterTypes.length);
    for (let i = 0; i < count; i++) {
        const parameterNode = parameterNodes[i];
        const parameterType = parameterTypes[i];
        for (const variableName of collectPatternVariablesForTypeEnv(parameterNode)) {
            env.set(variableName, parameterType);
        }
    }
    return env;
}

function validateDefinitionTypeContracts(
    rootNode: SyntaxNode,
    diagnostics: Diagnostic[],
    getVisibleEntries: (name: string) => SymbolEntry[],
    getTypedOverloads: (name: string) => TypedOverload[]
): void {
    traverseTree(rootNode, (node) => {
        if (node.type !== 'list') return;
        if (node.parent?.type !== 'source_file') return;
        if (containsParseError(node)) return;
        if (getHeadSymbol(node) !== '=') return;

        const namedChildren = getNamedChildren(node);
        if (namedChildren.length < 2) return;

        const definitionHead = namedChildren[1];
        if (!definitionHead || definitionHead.type !== 'list') return;

        const signatureParts = getNamedChildren(definitionHead);
        if (signatureParts.length === 0) return;

        const functionAtom = signatureParts[0];
        const functionName = getAtomSymbol(functionAtom);
        const functionNameNode = getAtomSymbolNode(functionAtom);
        if (!functionName || !functionNameNode) return;

        const immediateTypeSignature = findImmediateTypeSignatureForDefinition(node, functionName);
        if (!immediateTypeSignature) return;

        const parsedContract = parseArrowType(immediateTypeSignature);
        if (!parsedContract) return;

        const parameterNodes = signatureParts.slice(1);
        const declaredArity = parsedContract.paramTerms.length;
        const actualArity = parameterNodes.length;

        if (declaredArity !== actualArity) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: functionNameNode.startPosition.row, character: functionNameNode.startPosition.column },
                    end: { line: functionNameNode.endPosition.row, character: functionNameNode.endPosition.column }
                },
                message: `Type contract mismatch for '${functionName}': declared ${declaredArity} parameter type(s), but definition has ${actualArity} parameter(s)`,
                source: 'metta-lsp'
            });
            return;
        }

        if (!parsedContract.returnTerm) return;

        const bodyNodes = namedChildren.slice(2);
        const finalBodyNode = bodyNodes.length > 0 ? bodyNodes[bodyNodes.length - 1] : null;
        const parameterTypeEnvironment = buildParameterTypeEnvironment(parameterNodes, parsedContract.paramTerms);
        const inferenceCache = new Map<string, TypeEvidence>();
        const inferenceInProgress = new Set<string>();
        const inferredReturn = finalBodyNode
            ? inferArgumentType(
                finalBodyNode,
                getVisibleEntries,
                getTypedOverloads,
                inferenceCache,
                inferenceInProgress,
                parameterTypeEnvironment,
                parsedContract.returnTerm
            )
            : buildTypeEvidence([], ['Expression', 'Atom'], true);

        const returnTerm = parsedContract.returnTerm;
        const returnMatches = matchExpectedToEvidence(returnTerm, inferredReturn, new Map());
        const allCandidatesMatch = inferredReturn.candidates.length === 0 || inferredReturn.candidates.every(cand => 
            matchTypeTerms(returnTerm, cand, new Map())
        );

        if (allCandidatesMatch && (returnMatches.length > 0 || !inferredReturn.unknown)) return;

        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: { line: functionNameNode.startPosition.row, character: functionNameNode.startPosition.column },
                end: { line: functionNameNode.endPosition.row, character: functionNameNode.endPosition.column }
            },
            message: `Return type mismatch for '${functionName}': declared ${typeTermToString(parsedContract.returnTerm)}, inferred ${typeEvidenceToString(inferredReturn)}`,
            source: 'metta-lsp'
        });
    });
}

function typeTermToOverload(term: TypeTerm): TypedOverload | null {
    if (term.kind !== 'compound') return null;
    const headName = getTermName(term.head);
    if (headName !== '->') return null;

    const parts = term.args;
    if (parts.length === 0) return null;

    const paramTerms = parts.slice(0, -1);
    const returnTerm = parts[parts.length - 1];

    return {
        paramTypes: paramTerms.map(typeTermToString),
        returnType: typeTermToString(returnTerm),
        paramTerms,
        returnTerm
    };
}

function validateCallTypeSignatures(
    rootNode: SyntaxNode,
    diagnostics: Diagnostic[],
    boundSymbols: Set<string>,
    getVisibleEntries: (name: string) => SymbolEntry[],
    getTypedOverloads: (name: string) => TypedOverload[]
): void {
    const nonCallableForms = new Set([
        '=',
        ':',
        '->',
        'macro',
        'defmacro'
    ]);
    const inferenceCache = new Map<string, TypeEvidence>();
    const inferenceInProgress = new Set<string>();

    function visit(node: SyntaxNode | null, env: Map<string, TypeTerm>): void {
        if (!node) return;

        if (node.type === 'list') {
            if (containsParseError(node)) return;

            const namedChildren = getNamedChildren(node);
            if (namedChildren.length === 0) return;

            const head = namedChildren[0];
            const headSymbol = getHeadSymbol(node);

            if (headSymbol === '=') {
                const defHead = namedChildren[1] ?? null;
                const bodyNodes = namedChildren.slice(2);
                const localEnv = new Map(env);

                if (defHead && defHead.type === 'list') {
                    const signatureParts = getNamedChildren(defHead);
                    const functionName = getAtomSymbol(signatureParts[0] ?? null);
                    if (functionName) {
                        const typeSignature = findImmediateTypeSignatureForDefinition(node, functionName);
                        if (typeSignature) {
                            const parsedContract = parseArrowType(typeSignature);
                            if (parsedContract) {
                                const parameterNodes = signatureParts.slice(1);
                                const count = Math.min(parameterNodes.length, parsedContract.paramTerms.length);
                                for (let i = 0; i < count; i++) {
                                    for (const varName of collectPatternVariablesForTypeEnv(parameterNodes[i])) {
                                        localEnv.set(varName, parsedContract.paramTerms[i]);
                                    }
                                }
                            }
                        }
                    }
                }

                for (const bodyNode of bodyNodes) {
                    visit(bodyNode, localEnv);
                }
                return;
            }

            if (headSymbol === 'let' || headSymbol === 'let*' || headSymbol === 'chain') {
                // For simplicity in this phase, we skip complex environment tracking for let/let*/chain 
                // as it requires full type inference of the assigned expressions.
                // We will just visit children with the current environment.
                for (const child of namedChildren) {
                    visit(child, env);
                }
                return;
            }

            // Normal Call Validation
            let overloads: TypedOverload[] = [];
            let nameForReport = '';
            let errorNode: SyntaxNode | null = null;

            if (head.type === 'atom') {
                const symbolNode = head.children.find((child) => child.type === 'symbol');
                const variableNode = head.children.find((child) => child.type === 'variable');

                if (symbolNode) {
                    const name = symbolNode.text;
                    if (!nonCallableForms.has(name) && !name.startsWith('$')) {
                        const isBound = boundSymbols.has(name) && getVisibleEntries(name).length === 0;
                        if (!isBound) {
                            const parent = node.parent;
                            let shouldSkip = false;
                            if (parent && parent.type === 'list') {
                                const parentNamed = getNamedChildren(parent);
                                const parentHead = parentNamed[0]?.text;
                                if (
                                    (parentHead === '=' ||
                                        parentHead === ':' ||
                                        parentHead === '->' ||
                                        parentHead === 'macro' ||
                                        parentHead === 'defmacro') &&
                                    (parentNamed[1] === node || parentNamed[1] === head)
                                ) {
                                    shouldSkip = true;
                                }
                            }

                            if (!shouldSkip) {
                                overloads = getTypedOverloads(name);
                                nameForReport = name;
                                errorNode = symbolNode;
                            }
                        }
                    }
                } else if (variableNode) {
                    const name = variableNode.text;
                    const type = env.get(name);
                    if (type) {
                        const overload = typeTermToOverload(type);
                        if (overload) {
                            overloads = [overload];
                            nameForReport = name;
                            errorNode = variableNode;
                        }
                    }
                }
            }

            if (overloads.length > 0 && errorNode) {
                const args = namedChildren.slice(1);
                const callArity = args.length;
                const arityOverloads = overloads.filter((ov) => ov.paramTypes.length === callArity);

                if (arityOverloads.length === 0) {
                    // Arity mismatch for variables or symbols with signatures
                    const concreteArities = Array.from(new Set(overloads.map(ov => ov.paramTypes.length))).sort((a,b) => a-b);
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: {
                            start: { line: errorNode.startPosition.row, character: errorNode.startPosition.column },
                            end: { line: errorNode.endPosition.row, character: errorNode.endPosition.column }
                        },
                        message: `Argument count mismatch for '${nameForReport}': expected ${formatExpectedArities(concreteArities)}, got ${callArity}`,
                        source: 'metta-lsp'
                    });
                } else {
                    const argTypes = args.map((arg) =>
                        inferArgumentType(arg, getVisibleEntries, getTypedOverloads, inferenceCache, inferenceInProgress, env)
                    );
                    const matching = arityOverloads.filter((overload) =>
                        matchOverload(overload, argTypes).length > 0
                    );

                    if (matching.length === 0) {
                        const expected = arityOverloads.map((overload) => `(${overload.paramTypes.join(', ')})`).join(' or ');
                        diagnostics.push({
                            severity: DiagnosticSeverity.Error,
                            range: {
                                start: { line: errorNode.startPosition.row, character: errorNode.startPosition.column },
                                end: { line: errorNode.endPosition.row, character: errorNode.endPosition.column }
                            },
                            message: `Type mismatch for '${nameForReport}': argument types [${argTypes.map(typeEvidenceToString).join(', ')}] do not match ${expected}`,
                            source: 'metta-lsp'
                        });
                    } else if (matching.length > 1) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Warning,
                            range: {
                                start: { line: errorNode.startPosition.row, character: errorNode.startPosition.column },
                                end: { line: errorNode.endPosition.row, character: errorNode.endPosition.column }
                            },
                            message: `Ambiguous reference '${nameForReport}': ${matching.length} matching typed overloads for ${callArity} argument(s)`,
                            source: 'metta-lsp'
                        });
                    }
                }
            }

            // Continue visiting children
            for (const child of namedChildren) {
                visit(child, env);
            }
        } else {
            for (let i = 0; i < node.childCount; i++) {
                visit(node.child(i), env);
            }
        }
    }

    visit(rootNode, new Map());
    for (const form of collectTopLevelEvaluatedForms(rootNode)) {
        visit(form, new Map());
    }
}

function collectTopLevelEvaluatedForms(rootNode: SyntaxNode): SyntaxNode[] {
    const forms: SyntaxNode[] = [];

    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const node = rootNode.namedChild(i);
        if (!node || node.type !== 'atom') continue;

        const symbolNode = node.children.find((child) => child.type === 'symbol');
        if (!symbolNode || symbolNode.text !== '!') continue;

        const next = rootNode.namedChild(i + 1);
        if (next && next.type === 'list') {
            forms.push(next);
            i += 1;
        }
    }

    return forms;
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

    for (const form of collectTopLevelEvaluatedForms(rootNode)) {
        maybeRecordBind(form);
    }

    return bound;
}

function validateSpaceBindingOrderAndCollectAtoms(
    topLevelEvaluatedForms: SyntaxNode[],
    sourceUri: string,
    diagnostics: Diagnostic[],
    getVisibleEntries: (name: string) => SymbolEntry[]
): Set<string> {
    const boundSpaces = new Set<string>(['&self']);
    const knownAtomSymbols = new Set<string>();
    const normalizedSourceUri = normalizeUri(sourceUri);

    for (const form of topLevelEvaluatedForms) {
        const named = getNamedChildren(form);
        if (named.length === 0) continue;
        const headName = getHeadSymbol(form);

        let bindTargetSymbolNode: SyntaxNode | null = null;
        let bindTargetName: string | null = null;
        if (headName === 'bind!' && named.length >= 2 && named[1]?.type === 'atom') {
            const targetSymbolNode = named[1].children.find((child) => child.type === 'symbol') ?? null;
            if (targetSymbolNode && targetSymbolNode.text.startsWith('&')) {
                bindTargetSymbolNode = targetSymbolNode;
                bindTargetName = targetSymbolNode.text;
            }
        }

        traverseTree(form, (node) => {
            if (node.type !== 'symbol') return;
            const name = node.text;
            if (!name.startsWith('&')) return;
            if (name === '&self') return;
            if (bindTargetSymbolNode && node === bindTargetSymbolNode) return;
            if (boundSpaces.has(name)) return;
            const importedBind = getVisibleEntries(name).some((entry) =>
                entry.op === 'bind!' && normalizeUri(entry.uri) !== normalizedSourceUri
            );
            if (importedBind) {
                boundSpaces.add(name);
                return;
            }

            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: node.startPosition.row, character: node.startPosition.column },
                    end: { line: node.endPosition.row, character: node.endPosition.column }
                },
                message: `Unbound space '${name}': bind it first using !(bind! ${name} (new-space)) or use &self`,
                source: 'metta-lsp'
            });
        });

        if (headName === 'add-atom' && named.length >= 3 && named[2]?.type === 'atom') {
            const atomSymbolNode = named[2].children.find((child) => child.type === 'symbol');
            if (atomSymbolNode && !atomSymbolNode.text.startsWith('&')) {
                knownAtomSymbols.add(atomSymbolNode.text);
            }
        }

        if (bindTargetName && bindTargetName !== '&self') {
            boundSpaces.add(bindTargetName);
        }
    }

    return knownAtomSymbols;
}

function collectTypedOverloads(
    name: string,
    getVisibleEntries: (name: string) => SymbolEntry[],
    builtinMeta: Map<string, BuiltinMeta>
): TypedOverload[] {
    const overloads: TypedOverload[] = [];

    const entries = getVisibleEntries(name);
    const definitionEntries = entries.filter((entry) => entry.op === '=');
    const typedDefinitionEntries = definitionEntries.filter((entry) => Boolean(entry.immediateTypeSignature));

    if (typedDefinitionEntries.length > 0) {
        for (const entry of typedDefinitionEntries) {
            if (!entry.immediateTypeSignature) continue;
            const parsed = parseArrowType(entry.immediateTypeSignature);
            if (parsed) overloads.push(parsed);
        }
    } else if (definitionEntries.length === 0) {
        for (const entry of entries) {
            if (entry.op !== ':' || !entry.typeSignature) continue;
            const parsed = parseArrowType(entry.typeSignature);
            if (parsed) overloads.push(parsed);
        }
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

function cloneTypeTerm(term: TypeTerm): TypeTerm {
    if (term.kind === 'name' || term.kind === 'var') {
        return { ...term };
    }
    return {
        kind: 'compound',
        head: cloneTypeTerm(term.head),
        args: term.args.map(cloneTypeTerm)
    };
}

function overloadToFunctionTypeTerm(overload: TypedOverload): TypeTerm | null {
    const args = overload.paramTerms.map(cloneTypeTerm);
    if (overload.returnTerm) {
        args.push(cloneTypeTerm(overload.returnTerm));
    }

    return {
        kind: 'compound',
        head: createNameTypeTerm('->'),
        args
    };
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
    getVisibleEntries: (name: string) => SymbolEntry[],
    getTypedOverloads: (name: string) => TypedOverload[],
    cache: Map<string, TypeEvidence>,
    inProgress: Set<string>,
    parameterTypeEnvironment: Map<string, TypeTerm> | null = null,
    expectedReturnType: TypeTerm | null = null
): TypeEvidence {
    if (!node) return buildTypeEvidence([], ['Atom'], true);

    const key = getNodeKey(node);
    const cached = cache.get(key);
    if (cached) return cached;

    if (inProgress.has(key)) {
        if (expectedReturnType) {
            return buildTypeEvidence([expectedReturnType], ['Expression', 'Atom']);
        }
        return buildTypeEvidence([], ['Expression', 'Atom'], true);
    }
    inProgress.add(key);

    let inferred: TypeEvidence;
    if (node.type === 'atom') {
        inferred = inferAtomType(node, getVisibleEntries, getTypedOverloads, parameterTypeEnvironment);
    } else if (node.type === 'list') {
        inferred = inferListType(
            node,
            getVisibleEntries,
            getTypedOverloads,
            cache,
            inProgress,
            parameterTypeEnvironment,
            expectedReturnType
        );
    } else {
        inferred = buildTypeEvidence([], ['Atom'], true);
    }

    inProgress.delete(key);
    cache.set(key, inferred);
    return inferred;
}

function inferAtomType(
    node: SyntaxNode,
    getVisibleEntries: (name: string) => SymbolEntry[],
    getTypedOverloads: (name: string) => TypedOverload[],
    parameterTypeEnvironment: Map<string, TypeTerm> | null
): TypeEvidence {
    if (node.children.some((child) => child.type === 'number')) {
        return buildTypeEvidence([createNameTypeTerm('Number')], ['Grounded', 'Atom']);
    }
    if (node.children.some((child) => child.type === 'string')) {
        return buildTypeEvidence([createNameTypeTerm('String')], ['Grounded', 'Atom']);
    }
    const variableNode = node.children.find((child) => child.type === 'variable');
    if (variableNode) {
        if (parameterTypeEnvironment) {
            const mapped = parameterTypeEnvironment.get(variableNode.text);
            if (mapped) {
                return buildTypeEvidence([mapped], ['Variable', 'Atom']);
            }
        }
        return buildTypeEvidence([{ kind: 'var', name: variableNode.text }], ['Variable', 'Atom'], true);
    }

    const symbolNode = node.children.find((child) => child.type === 'symbol');
    if (!symbolNode) {
        return buildTypeEvidence([], ['Atom'], true);
    }

    if (symbolNode.text === 'True' || symbolNode.text === 'False') {
        return buildTypeEvidence([createNameTypeTerm('Bool')], ['Symbol', 'Atom']);
    }

    if (symbolNode.text.startsWith('&')) {
        return buildTypeEvidence([createNameTypeTerm('SpaceType')], ['Symbol', 'Atom']);
    }

    const functionCandidates = getTypedOverloads(symbolNode.text)
        .map(overloadToFunctionTypeTerm)
        .filter((term): term is TypeTerm => term !== null);
    if (functionCandidates.length > 0) {
        return buildTypeEvidence(
            [createNameTypeTerm('Symbol'), ...functionCandidates],
            ['Symbol', 'Atom']
        );
    }

    const visibleEntries = getVisibleEntries(symbolNode.text);
    const hasUntypedCallableDefinition = visibleEntries.some(isCallableEntry);
    if (hasUntypedCallableDefinition) {
        return buildTypeEvidence([], ['Symbol', 'Atom'], true);
    }

    // Unresolved symbols should surface as unresolved bindings, not as call-level type mismatch noise.
    if (visibleEntries.length === 0) {
        return buildTypeEvidence([createNameTypeTerm('Symbol')], ['Symbol', 'Atom'], true);
    }

    return buildTypeEvidence([createNameTypeTerm('Symbol')], ['Symbol', 'Atom']);
}

function inferListType(
    node: SyntaxNode,
    getVisibleEntries: (name: string) => SymbolEntry[],
    getTypedOverloads: (name: string) => TypedOverload[],
    cache: Map<string, TypeEvidence>,
    inProgress: Set<string>,
    parameterTypeEnvironment: Map<string, TypeTerm> | null,
    expectedReturnType: TypeTerm | null = null
): TypeEvidence {
    const metaKinds: MetaTypeKind[] = ['Expression', 'Atom'];
    const children = getNamedChildren(node);
    if (children.length === 0) {
        return buildTypeEvidence([], metaKinds, true);
    }

    const head = children[0];
    const headSymbol = getHeadSymbol(node);

    if (headSymbol === 'if') {
        const branches = children.slice(2);
        const branchEvidences = branches.map((branch) =>
            inferArgumentType(branch, getVisibleEntries, getTypedOverloads, cache, inProgress, parameterTypeEnvironment, expectedReturnType)
        );
        const candidates = branchEvidences.flatMap((ev) => ev.candidates);
        const metaSet = new Set<MetaTypeKind>(metaKinds);
        let unknown = false;
        for (const ev of branchEvidences) {
            for (const kind of ev.metaKinds) metaSet.add(kind);
            if (ev.unknown) unknown = true;
        }
        return buildTypeEvidence(candidates, Array.from(metaSet), unknown);
    }

    if (headSymbol === 'case') {
        const branches = children.slice(2);
        const branchEvidences: TypeEvidence[] = [];
        for (const branch of branches) {
            if (branch.type === 'list') {
                const branchChildren = getNamedChildren(branch);
                if (branchChildren.length >= 2) {
                    branchEvidences.push(
                        inferArgumentType(branchChildren[1], getVisibleEntries, getTypedOverloads, cache, inProgress, parameterTypeEnvironment, expectedReturnType)
                    );
                }
            }
        }
        const candidates = branchEvidences.flatMap((ev) => ev.candidates);
        const metaSet = new Set<MetaTypeKind>(metaKinds);
        let unknown = false;
        for (const ev of branchEvidences) {
            for (const kind of ev.metaKinds) metaSet.add(kind);
            if (ev.unknown) unknown = true;
        }
        return buildTypeEvidence(candidates, Array.from(metaSet), unknown);
    }

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

    const argEvidence = args.map((arg) =>
        inferArgumentType(arg, getVisibleEntries, getTypedOverloads, cache, inProgress, parameterTypeEnvironment)
    );
    const returnCandidates: TypeTerm[] = [];
    let hasMatch = false;
    let unresolved = false;

    for (const overload of overloads) {
        const bindingSets = matchOverload(overload, argEvidence);
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
    argTypes: TypeEvidence[]
): Map<string, TypeTerm>[] {
    let bindingsList: Map<string, TypeTerm>[] = [new Map<string, TypeTerm>()];

    for (let i = 0; i < overload.paramTerms.length; i++) {
        const expected = overload.paramTerms[i];
        const actualEvidence = argTypes[i] ?? buildTypeEvidence([], ['Atom'], true);
        const nextBindings: Map<string, TypeTerm>[] = [];

        for (const bindings of bindingsList) {
            const matchedBindings = matchExpectedToEvidence(expected, actualEvidence, bindings);
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
    bindings: Map<string, TypeTerm>
): Map<string, TypeTerm>[] {
    const matched: Map<string, TypeTerm>[] = [];
    const canAcceptUnknown = true;

    if (isMetaExpected(expected)) {
        if (matchesMetaExpected(expected, evidence) || (evidence.unknown && canAcceptUnknown)) {
            matched.push(new Map(bindings));
        }
        return matched;
    }

    if (isExpressionLikeExpected(expected) && evidence.metaKinds.has('Expression') && evidence.unknown) {
        matched.push(new Map(bindings));
    }

    for (const candidate of evidence.candidates) {
        const nextBindings = new Map(bindings);
        if (matchTypeTerms(expected, candidate, nextBindings)) {
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

function matchesMetaExpected(
    expected: { kind: 'name'; name: string },
    evidence: TypeEvidence
): boolean {
    const expectedName = normalizeTypeName(expected.name);
    if (expectedName === 'Atom') return true;
    if (expectedName === 'Expression') {
        return evidence.metaKinds.has('Expression') || evidence.candidates.some(isExpressionTypeTerm);
    }
    if (expectedName === 'Symbol') {
        return evidence.metaKinds.has('Symbol') || evidence.candidates.some((term) => getTermName(term) === 'Symbol');
    }
    if (expectedName === 'Variable') {
        return evidence.metaKinds.has('Variable') || evidence.candidates.some((term) => getTermName(term) === 'Variable');
    }
    if (expectedName === 'Grounded') {
        return evidence.metaKinds.has('Grounded') || evidence.candidates.some(isGroundedTypeTerm);
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

function resolveTypeTermBinding(term: TypeTerm, bindings: Map<string, TypeTerm>): TypeTerm {
    if (term.kind !== 'var') return term;

    const seen = new Set<string>();
    let current: TypeTerm = term;
    while (current.kind === 'var') {
        if (seen.has(current.name)) {
            // Cyclic binding chain (e.g. $a -> $b -> $a). Keep as unresolved var.
            return current;
        }
        seen.add(current.name);
        const bound = bindings.get(current.name);
        if (!bound) return current;
        current = bound;
    }
    return current;
}

function matchTypeTerms(
    expected: TypeTerm,
    actual: TypeTerm,
    bindings: Map<string, TypeTerm>,
    activePairs: Set<string> = new Set()
): boolean {
    const pairKey = `${typeTermToString(expected)}=>${typeTermToString(actual)}`;
    if (activePairs.has(pairKey)) {
        // Recursive type shape; treat as satisfiable to avoid non-terminating unification.
        return true;
    }
    activePairs.add(pairKey);

    try {
        if (expected.kind === 'name') {
            const expectedName = normalizeTypeName(expected.name);
            if (UNIVERSAL_TYPE_NAMES.has(expectedName)) return true;
        }

        if (expected.kind === 'var') {
            const resolvedExpected = resolveTypeTermBinding(expected, bindings);
            if (resolvedExpected.kind !== 'var' || resolvedExpected.name !== expected.name) {
                return matchTypeTerms(resolvedExpected, actual, bindings, activePairs);
            }

            const resolvedActual = resolveTypeTermBinding(actual, bindings);
            if (resolvedActual.kind === 'var' && resolvedActual.name === expected.name) {
                // Self-unification ($a with $a) is already satisfied.
                return true;
            }

            bindings.set(expected.name, resolvedActual);
            return true;
        }

        if (actual.kind === 'var') {
            const resolvedActual = resolveTypeTermBinding(actual, bindings);
            if (resolvedActual.kind === 'var') {
                bindings.set(resolvedActual.name, expected);
                return true;
            }
            return matchTypeTerms(expected, resolvedActual, bindings, activePairs);
        }

        if (actual.kind === 'name') {
            const actualName = normalizeTypeName(actual.name);
            if (actualName === '%Undefined%' || actualName === 'Atom') return true;
        }

        if (expected.kind === 'name' && actual.kind === 'name') {
            const expectedName = normalizeTypeName(expected.name);
            const actualName = normalizeTypeName(actual.name);
            if (expectedName === actualName) return true;
            if (expectedName === 'Grounded' && PRIMITIVE_GROUNDED_TYPES.has(actualName)) return true;
            return false;
        }

        if (expected.kind === 'compound' && actual.kind === 'compound') {
            if (!matchTypeTerms(expected.head, actual.head, bindings, activePairs)) return false;
            if (expected.args.length !== actual.args.length) return false;
            for (let i = 0; i < expected.args.length; i++) {
                if (!matchTypeTerms(expected.args[i], actual.args[i], bindings, activePairs)) return false;
            }
            return true;
        }

        if (expected.kind === 'compound' && actual.kind === 'name') {
            return false;
        }

        if (expected.kind === 'name' && actual.kind === 'compound') {
            const expectedName = normalizeTypeName(expected.name);
            if (expectedName === 'Expression') return true;
            return false;
        }

        return false;
    } finally {
        activePairs.delete(pairKey);
    }
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
            severity: DiagnosticSeverity.Warning,
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

        if (headSymbol === 'chain') {
            if (!checkVars) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    visit(node.namedChild(i), env, checkVars);
                }
                return;
            }

            const exprNode = children[1] ?? null;
            const binderAtom = children[2] ?? null;
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

        for (const child of children) {
            visit(child, env, checkVars);
        }
    }

    visit(rootNode, new Set<string>(), false);
    for (const form of collectTopLevelEvaluatedForms(rootNode)) {
        visit(form, new Set<string>(), true);
    }
}

function traverseTree(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) traverseTree(child, callback);
    }
}
