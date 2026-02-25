const { DiagnosticSeverity } = require('vscode-languageserver/node');

function validateTextDocument(document, analyzer) {
    const text = document.getText();
    const sourceUri = document.uri;
    const tree = analyzer.parser.parse(text);
    const diagnostics = [];
    const boundSymbols = collectBoundSymbols(tree.rootNode);

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
                message: "Syntax error",
                source: 'metta-lsp'
            });
        }
    });

    const definitionsBySignature = new Map();
    const matches = analyzer.symbolQuery.matches(tree.rootNode);

    for (const match of matches) {
        const nameNode = match.captures.find(c => c.name === 'name')?.node;
        const opNode = match.captures.find(c => c.name === 'op')?.node;

        if (nameNode && opNode && opNode.text === '=') {
            let innerList = nameNode.parent;
            while (innerList && innerList.type !== 'list') innerList = innerList.parent;

            let definitionNode = innerList;
            let outer = innerList.parent;
            while (outer && outer.type !== 'list') outer = outer.parent;
            if (outer) {
                definitionNode = outer;

                const namedArgs = definitionNode.children.filter(c => c.type === 'atom' || c.type === 'list');
                if (namedArgs.indexOf(innerList) !== 1) continue;

                const isTopLevel = definitionNode.parent && definitionNode.parent.type === 'source_file';
                if (!isTopLevel) continue;
            } else {
                continue;
            }

            const name = nameNode.text;
            const arity = inferDefinitionArity(nameNode);
            const key = `${name}::${arity}`;
            if (!definitionsBySignature.has(key)) {
                definitionsBySignature.set(key, []);
            }
            definitionsBySignature.get(key).push(nameNode);
        }
    }

    for (const [key, nodes] of definitionsBySignature) {
        if (nodes.length > 1) {
            const [name, arity] = key.split('::');
            for (const nameNode of nodes) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
                        end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column }
                    },
                    message: `Duplicate definition of '${name}' with ${arity} argument(s) (${nodes.length} definitions in this file)`,
                    source: 'metta-lsp'
                });
            }
        }
    }

    const { BUILTIN_SYMBOLS, BUILTIN_META } = require('../utils');
    const validOperators = new Set(['=', ':', '->', 'macro', 'defmacro', '==', '~=', '+', '-', '*', '/', '>', '<', '>=', '<=']);

    traverseTree(tree.rootNode, (node) => {
        if (node.type === 'list') {
            const namedChildren = node.children.filter(c => c.type === 'atom' || c.type === 'list');
            if (namedChildren.length > 0) {
                const head = namedChildren[0];
                if (head.type === 'atom') {
                    const symbolNode = head.children.find(c => c.type === 'symbol');
                    if (symbolNode) {
                        const name = symbolNode.text;

                        if (boundSymbols.has(name)) return;

                        if (BUILTIN_SYMBOLS.has(name)) return;

                        if (validOperators.has(name)) return;

                        if (name.startsWith('$')) return;

                        if (isInsideCaseBranches(node)) return;

                        let p = node.parent;
                        if (p && p.type === 'list') {
                            const pNamed = p.children.filter(c => c.type === 'atom' || c.type === 'list');
                            if (pNamed.length > 0 && pNamed[0].text === '=') {
                                if (pNamed[1] === node) return;
                            }
                        }

                        let gp = node.parent;
                        if (gp && gp.type === 'list') {
                            const gpNamed = gp.children.filter(c => c.type === 'atom' || c.type === 'list');
                            if (gpNamed.length > 0 && gpNamed[0].text === ':') {
                                if (gpNamed[1] === head) return;
                            }
                        }

                        const definitions = analyzer.getVisibleEntries(name, sourceUri);
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
                        } else {
                            const callArity = namedChildren.length - 1;
                            const callableDefinitions = definitions.filter(d => d.op !== ':');
                            const matchingDefinitions = callableDefinitions.filter(d => {
                                const arity = getEntryArity(d);
                                return arity === null || arity === callArity;
                            });
                            const concreteArities = Array.from(new Set(
                                callableDefinitions
                                    .map(getEntryArity)
                                    .filter(a => a !== null)
                            )).sort((a, b) => a - b);

                            if (callableDefinitions.length > 0 && concreteArities.length > 0 && matchingDefinitions.length === 0) {
                                diagnostics.push({
                                    severity: DiagnosticSeverity.Error,
                                    range: {
                                        start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                                        end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                                    },
                                    message: `Argument count mismatch for '${name}': expected ${formatExpectedArities(concreteArities)}, got ${callArity}`,
                                    source: 'metta-lsp'
                                });
                            } else if (matchingDefinitions.length > 1 && !hasTypedOverloadForArity(name, callArity, analyzer, BUILTIN_META, sourceUri)) {
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
                        }
                    }
                }
            }
        }
    });

    traverseTree(tree.rootNode, (node) => {
        if (node.type !== 'list') return;
        if (isInsideCaseBranches(node)) return;

        const namedChildren = node.children.filter(c => c.type === 'atom' || c.type === 'list');
        if (namedChildren.length === 0) return;

        const head = namedChildren[0];
        const headSymbolNode = head.type === 'atom' ? head.children.find(c => c.type === 'symbol') : null;
        const headName = headSymbolNode ? headSymbolNode.text : null;

        if (headName === 'import!' || headName === 'register-module!') {
            return;
        }

        for (let i = 1; i < namedChildren.length; i++) {
            const child = namedChildren[i];
            if (child.type !== 'atom') continue;

            const symbolNode = child.children.find(c => c.type === 'symbol');
            if (!symbolNode) continue;

            const name = symbolNode.text;
            if (validOperators.has(name)) continue;
            if (BUILTIN_SYMBOLS.has(name)) continue;
            if (boundSymbols.has(name)) continue;

            const definitions = analyzer.getVisibleEntries(name, sourceUri);
            if (definitions && definitions.length > 0) continue;

            if (headName === '=' || headName === ':' || headName === '->' || headName === 'macro' || headName === 'defmacro') {
                if (i === 1) continue;
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

    validateCallTypeSignatures(tree.rootNode, analyzer, diagnostics, BUILTIN_META, validOperators, boundSymbols, sourceUri);

    validateUndefinedVariables(tree.rootNode, diagnostics);

    return diagnostics;
}

function isInsideModuleDirective(node) {
    let current = node;
    while (current) {
        if (current.type === 'list') {
            const named = current.children.filter(c => c.type === 'atom' || c.type === 'list');
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

function isCaseBranchHead(listNode) {
    if (!listNode || listNode.type !== 'list') return false;

    const parent = listNode.parent;
    if (!parent || parent.type !== 'list') return false;

    const parentNamed = parent.children.filter(c => c.type === 'atom' || c.type === 'list');
    const listIndexInParent = parentNamed.indexOf(listNode);
    if (listIndexInParent < 0) return false;

    const caseCall = parent.parent;
    if (!caseCall || caseCall.type !== 'list') return false;

    const caseNamed = caseCall.children.filter(c => c.type === 'atom' || c.type === 'list');
    if (caseNamed.length < 3) return false;

    const caseHead = caseNamed[0];
    if (caseHead.type !== 'atom' || caseHead.text !== 'case') return false;

    // Branch list must be inside the third argument of case: (case <expr> (<branch> ...))
    if (caseNamed[2] !== parent) return false;

    return true;
}

function isInsideCaseBranches(node) {
    let current = node;
    while (current && current.parent) {
        const maybeCaseCall = current.parent;
        if (maybeCaseCall.type === 'list') {
            const named = maybeCaseCall.children.filter(c => c.type === 'atom' || c.type === 'list');
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

function validateCallTypeSignatures(rootNode, analyzer, diagnostics, builtinMeta, validOperators, boundSymbols, sourceUri) {
    const nonCallableForms = new Set(['=', ':', '->', 'macro', 'defmacro', 'let', 'let*', 'match', 'case', 'if']);

    traverseTree(rootNode, (node) => {
        if (node.type !== 'list') return;

        const namedChildren = node.children.filter(c => c.type === 'atom' || c.type === 'list');
        if (namedChildren.length === 0) return;

        const head = namedChildren[0];
        if (head.type !== 'atom') return;
        const symbolNode = head.children.find(c => c.type === 'symbol');
        if (!symbolNode) return;

        const name = symbolNode.text;
        if (nonCallableForms.has(name)) return;
        if (name.startsWith('$')) return;

        let p = node.parent;
        if (p && p.type === 'list') {
            const pNamed = p.children.filter(c => c.type === 'atom' || c.type === 'list');
            if (pNamed.length > 0 && (pNamed[0].text === '=' || pNamed[0].text === ':' || pNamed[0].text === '->' || pNamed[0].text === 'macro' || pNamed[0].text === 'defmacro')) {
                if (pNamed[1] === node || pNamed[1] === head) return;
            }
        }

        if (boundSymbols.has(name) && !(analyzer.getVisibleEntries(name, sourceUri)?.length)) {
            return;
        }

        const args = namedChildren.slice(1);
        const callArity = args.length;
        const overloads = collectTypedOverloads(name, analyzer, builtinMeta, sourceUri)
            .filter(o => o.paramTypes.length === callArity);

        if (overloads.length === 0) return;

        const argTypes = args.map(inferArgumentType);
        const matching = overloads.filter(o =>
            o.paramTypes.every((expected, i) => isTypeCompatible(expected, argTypes[i]))
        );

        if (matching.length === 0) {
            const expected = overloads.map(o => `(${o.paramTypes.join(', ')})`).join(' or ');
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: symbolNode.startPosition.row, character: symbolNode.startPosition.column },
                    end: { line: symbolNode.endPosition.row, character: symbolNode.endPosition.column }
                },
                message: `Type mismatch for '${name}': argument types [${argTypes.join(', ')}] do not match ${expected}`,
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

function collectBoundSymbols(rootNode) {
    const bound = new Set();

    function getNamedChildren(node) {
        return node.children.filter(c => c.type === 'atom' || c.type === 'list');
    }

    function getHeadSymbol(listNode) {
        const children = getNamedChildren(listNode);
        if (children.length === 0 || children[0].type !== 'atom') return null;
        const symbolNode = children[0].children.find(c => c.type === 'symbol');
        return symbolNode ? symbolNode.text : null;
    }

    function maybeRecordBind(listNode) {
        if (!listNode || listNode.type !== 'list') return;
        if (getHeadSymbol(listNode) !== 'bind!') return;

        const children = getNamedChildren(listNode);
        if (children.length < 2 || children[1].type !== 'atom') return;

        const boundSymbol = children[1].children.find(c => c.type === 'symbol');
        if (boundSymbol) {
            bound.add(boundSymbol.text);
        }
    }

    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const node = rootNode.namedChild(i);
        if (node.type === 'list') {
            maybeRecordBind(node);
            continue;
        }

        if (node.type === 'atom') {
            const symbolNode = node.children.find(c => c.type === 'symbol');
            if (!symbolNode || symbolNode.text !== '!') continue;

            const next = rootNode.namedChild(i + 1);
            if (next && next.type === 'list') {
                maybeRecordBind(next);
            }
        }
    }

    return bound;
}

function collectTypedOverloads(name, analyzer, builtinMeta, sourceUri) {
    const overloads = [];

    const entries = analyzer.getVisibleEntries(name, sourceUri) || [];
    for (const entry of entries) {
        if (entry.op !== ':' || !entry.typeSignature) continue;
        const parsed = parseArrowType(entry.typeSignature);
        if (!parsed) continue;
        overloads.push(parsed);
    }

    const meta = builtinMeta.get(name);
    if (meta && Array.isArray(meta.signatures)) {
        for (const sig of meta.signatures) {
            const parsed = parseSignatureText(sig);
            if (!parsed) continue;
            overloads.push(parsed);
        }
    }

    return overloads;
}

function parseSignatureText(signature) {
    if (typeof signature !== 'string') return null;
    const idx = signature.indexOf(':');
    const rhs = idx >= 0 ? signature.slice(idx + 1).trim() : signature.trim();
    return parseArrowType(rhs);
}

function parseArrowType(typeSignature) {
    const sig = (typeSignature || '').trim();
    if (!sig.startsWith('(-> ') || !sig.endsWith(')')) return null;

    const inner = sig.slice(4, -1).trim();
    const parts = splitTopLevelTypeParts(inner);
    if (parts.length < 1) return { paramTypes: [], returnType: null };

    const paramTypes = parts.slice(0, -1);
    const returnType = parts[parts.length - 1] || null;
    return { paramTypes, returnType };
}

function splitTopLevelTypeParts(inner) {
    const parts = [];
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

function inferArgumentType(node) {
    if (!node) return 'Unknown';

    if (node.type === 'atom') {
        if (node.children.find(c => c.type === 'number')) return 'Number';
        if (node.children.find(c => c.type === 'string')) return 'String';
        const variableNode = node.children.find(c => c.type === 'variable');
        if (variableNode) return 'Unknown';

        const symbolNode = node.children.find(c => c.type === 'symbol');
        if (!symbolNode) return 'Unknown';
        if (symbolNode.text === 'True' || symbolNode.text === 'False') return 'Bool';
        return 'Unknown';
    }

    if (node.type === 'list') {
        return 'Expression';
    }

    return 'Unknown';
}

function isGenericType(typeName) {
    const t = (typeName || '').trim();
    if (!t) return true;
    if (t === 'Any' || t === 'Atom' || t === 'Expression' || t === '%Undefined%') return true;
    if (t.startsWith('$')) return true;
    if (t.includes('#')) return true;
    return false;
}

function isTypeCompatible(expected, actual) {
    const exp = (expected || '').trim();
    if (isGenericType(exp)) return true;
    if (actual === 'Unknown') return true;
    if (exp === actual) return true;

    if (exp === 'Bool') return actual === 'Bool';
    if (exp === 'Number') return actual === 'Number';
    if (exp === 'String') return actual === 'String';

    return false;
}

function hasTypedOverloadForArity(name, arity, analyzer, builtinMeta, sourceUri) {
    return collectTypedOverloads(name, analyzer, builtinMeta, sourceUri).some(o => o.paramTypes.length === arity);
}

function inferDefinitionArity(nameNode) {
    if (!nameNode || !nameNode.parent || !nameNode.parent.parent) return 0;
    const atomNode = nameNode.parent;
    const listNode = atomNode.parent;
    if (atomNode.type !== 'atom' || listNode.type !== 'list') return 0;

    const named = listNode.children.filter(c => c.type === 'atom' || c.type === 'list');
    if (named.length === 0 || named[0] !== atomNode) return 0;
    return Math.max(0, named.length - 1);
}

function getEntryArity(entry) {
    if (!entry) return null;

    if (entry.op === '=' && Array.isArray(entry.parameters)) {
        return entry.parameters.length;
    }

    if (entry.op === ':' && entry.typeSignature) {
        return arityFromTypeSignature(entry.typeSignature);
    }

    return null;
}

function arityFromTypeSignature(typeSignature) {
    const sig = (typeSignature || '').trim();
    if (!sig.startsWith('(-> ')) return null;
    const inner = sig.slice(4, -1).trim();
    if (!inner) return 0;

    const parts = [];
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
    if (parts.length === 0) return 0;
    return Math.max(0, parts.length - 1);
}

function formatExpectedArities(arities) {
    if (arities.length === 0) return 'unknown';
    if (arities.length === 1) return `${arities[0]}`;
    return arities.join(' or ');
}

function validateUndefinedVariables(rootNode, diagnostics) {
    function getNamedChildren(node) {
        return node.children.filter(c => c.type === 'atom' || c.type === 'list');
    }

    function getVariableNameFromAtom(atomNode) {
        if (!atomNode || atomNode.type !== 'atom') return null;
        const variableNode = atomNode.children.find(c => c.type === 'variable');
        return variableNode ? variableNode.text : null;
    }

    function collectPatternVariables(patternNode, out = new Set()) {
        if (!patternNode) return out;

        if (patternNode.type === 'atom') {
            const variableName = getVariableNameFromAtom(patternNode);
            if (variableName) out.add(variableName);
            return out;
        }

        if (patternNode.type === 'list') {
            const parts = getNamedChildren(patternNode);
            for (const part of parts) {
                collectPatternVariables(part, out);
            }
        }

        return out;
    }

    function getHeadSymbol(listNode) {
        if (!listNode || listNode.type !== 'list') return null;
        const head = getNamedChildren(listNode)[0];
        if (!head || head.type !== 'atom') return null;
        const symbolNode = head.children.find(c => c.type === 'symbol');
        return symbolNode ? symbolNode.text : null;
    }

    function reportUndefined(variableNode) {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: { line: variableNode.startPosition.row, character: variableNode.startPosition.column },
                end: { line: variableNode.endPosition.row, character: variableNode.endPosition.column }
            },
            message: `Undefined variable '${variableNode.text}'`,
            source: 'metta-lsp'
        });
    }

    function visit(node, env, checkVars) {
        if (!node) return;

        if (node.type === 'atom') {
            if (!checkVars) return;
            const variableNode = node.children.find(c => c.type === 'variable');
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
            const defHead = children[1];
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

            const binderAtom = children[1];
            const exprNode = children[2];
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

            const bindingsList = children[1];
            const bodyNodes = children.slice(2);
            const localEnv = new Set(env);

            if (bindingsList && bindingsList.type === 'list') {
                const bindings = getNamedChildren(bindingsList).filter(n => n.type === 'list');
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

    visit(rootNode, new Set(), false);
}

function traverseTree(node, callback) {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        traverseTree(node.child(i), callback);
    }
}

module.exports = {
    validateTextDocument
};
