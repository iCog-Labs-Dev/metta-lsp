const { DiagnosticSeverity } = require('vscode-languageserver/node');

function validateTextDocument(document, analyzer) {
    const text = document.getText();
    const tree = analyzer.parser.parse(text);
    const diagnostics = [];
    const boundSymbols = collectBoundSymbols(tree.rootNode);

    traverseTree(tree.rootNode, (node) => {
        if (node.isMissing) {
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

    const definitionsByName = new Map();
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
            if (!definitionsByName.has(name)) {
                definitionsByName.set(name, []);
            }
            definitionsByName.get(name).push(nameNode);
        }
    }

    for (const [name, nodes] of definitionsByName) {
        if (nodes.length > 1) {
            for (const nameNode of nodes) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
                        end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column }
                    },
                    message: `Duplicate definition of '${name}' (${nodes.length} definitions in this file)`,
                    source: 'metta-lsp'
                });
            }
        }
    }

    const { BUILTIN_SYMBOLS } = require('../utils');
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

                        const definitions = analyzer.globalIndex.get(name);
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
                        }
                    }
                }
            }
        }
    });

    traverseTree(tree.rootNode, (node) => {
        if (node.type !== 'list') return;

        const namedChildren = node.children.filter(c => c.type === 'atom' || c.type === 'list');
        if (namedChildren.length === 0) return;

        const head = namedChildren[0];
        const headSymbolNode = head.type === 'atom' ? head.children.find(c => c.type === 'symbol') : null;
        const headName = headSymbolNode ? headSymbolNode.text : null;

        for (let i = 1; i < namedChildren.length; i++) {
            const child = namedChildren[i];
            if (child.type !== 'atom') continue;

            const symbolNode = child.children.find(c => c.type === 'symbol');
            if (!symbolNode) continue;

            const name = symbolNode.text;
            if (validOperators.has(name)) continue;
            if (BUILTIN_SYMBOLS.has(name)) continue;
            if (boundSymbols.has(name)) continue;

            const definitions = analyzer.globalIndex.get(name);
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

    validateUndefinedVariables(tree.rootNode, diagnostics);

    return diagnostics;
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
