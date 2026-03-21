/**
 * scoping.ts
 *
 * Local scope resolution engine for the MeTTa LSP server.
 *
 * Responsibilities
 * ─────────────────
 * 1. Build a rich LocalScope tree from an AST (augmenting the lightweight
 *    ScopeTree already stored on the Analyzer).
 * 2. Collect every local binding introduced by =, let, let*, match, case, →
 *    together with its exact source position.
 * 3. Resolve which binding a variable/symbol reference refers to, walking the
 *    scope chain from innermost outward (shadowing-aware).
 * 4. Detect shadowing and out-of-scope usage for diagnostics.
 * 5. Provide scope-filtered symbol lists for completions.
 *
 * Design notes
 * ─────────────
 * • We do NOT re-parse the tree; we receive a Parser.Tree that the Analyzer
 *   has already produced.
 * • We work purely at the AST level so the logic is grammar-independent.
 * • This module is stateless – callers pass a tree and get back a result;
 *   caching is the Analyzer's responsibility.
 */

import type Parser from 'tree-sitter';
import type { Range } from 'vscode-languageserver/node';

// ─── Public types ────────────────────────────────────────────────────────────

/** A single local binding (variable or symbol) introduced in a scope. */
export interface LocalBinding {
    /** The name as it appears in source (e.g. "$x" or "myFn"). */
    name: string;
    /** Exact source range of the binding site (the introducing node). */
    range: Range;
    /** What syntactic construct introduced this binding. */
    introducedBy: BindingOrigin;
    /** The scope this binding lives in. */
    scope: LocalScope;
}

export type BindingOrigin =
    | 'definition-param'   // parameter of a (= (fn $x) body) definition
    | 'let-binder'         // binder in (let $x val body)
    | 'let*-binder'        // binder in (let* (($x val)…) body)
    | 'match-pattern'      // pattern variable in (match space pat body)
    | 'case-branch'        // pattern variable in a case branch
    | 'lambda-param';      // parameter in a (-> …) lambda/arrow form

/** A node in the scope tree. */
export interface LocalScope {
    id: string;
    parent: LocalScope | null;
    children: LocalScope[];
    /** All bindings introduced directly in this scope. */
    bindings: Map<string, LocalBinding>;
    startLine: number;
    endLine: number;
    startCol: number;
    endCol: number;
    /** The AST node that created this scope. */
    node: Parser.SyntaxNode;
}

/** Result returned by resolveReference(). */
export interface ResolvedReference {
    binding: LocalBinding;
    /** True if an outer binding with the same name is shadowed. */
    shadows: boolean;
}

/** Full scope analysis for one document. */
export interface ScopeAnalysis {
    /** Root (module-level) scope. */
    root: LocalScope;
    /** All scopes indexed by their id ("row:col"). */
    index: Map<string, LocalScope>;
    /** All local bindings across the document. */
    allBindings: LocalBinding[];
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function nodeRange(n: Parser.SyntaxNode): Range {
    return {
        start: { line: n.startPosition.row, character: n.startPosition.column },
        end: { line: n.endPosition.row, character: n.endPosition.column }
    };
}

function scopeId(n: Parser.SyntaxNode): string {
    return `${n.startPosition.row}:${n.startPosition.column}`;
}

function namedChildren(n: Parser.SyntaxNode): Parser.SyntaxNode[] {
    return n.children.filter((c) => c.type === 'atom' || c.type === 'list');
}

function headSymbol(listNode: Parser.SyntaxNode): string | null {
    if (listNode.type !== 'list') return null;
    const ch = namedChildren(listNode);
    if (ch.length === 0 || ch[0].type !== 'atom') return null;
    const sym = ch[0].children.find((c) => c.type === 'symbol');
    return sym ? sym.text : null;
}

function symbolNodeOf(atomNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (atomNode.type !== 'atom') return null;
    return atomNode.children.find((c) => c.type === 'symbol') ?? null;
}

function variableNodeOf(atomNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (atomNode.type !== 'atom') return null;
    return atomNode.children.find((c) => c.type === 'variable') ?? null;
}

/**
 * Collect all variable nodes ($x) and symbol nodes from a pattern subtree.
 * Used when binding introduces a destructured pattern.
 */
function collectPatternBinders(
    node: Parser.SyntaxNode,
    out: Parser.SyntaxNode[] = []
): Parser.SyntaxNode[] {
    if (node.type === 'atom') {
        const v = variableNodeOf(node);
        if (v) out.push(v);
        return out;
    }
    if (node.type === 'list') {
        for (const child of namedChildren(node)) {
            collectPatternBinders(child, out);
        }
    }
    return out;
}

// ─── Scope builder ───────────────────────────────────────────────────────────

function makeScope(
    node: Parser.SyntaxNode,
    parent: LocalScope | null
): LocalScope {
    return {
        id: scopeId(node),
        parent,
        children: [],
        bindings: new Map(),
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
        node
    };
}

function addBinding(
    scope: LocalScope,
    nameNode: Parser.SyntaxNode,
    origin: BindingOrigin,
    allBindings: LocalBinding[]
): void {
    const name = nameNode.text;
    if (!name) return;
    const binding: LocalBinding = {
        name,
        range: nodeRange(nameNode),
        introducedBy: origin,
        scope
    };
    // Last writer wins within the same scope (handles redefinition).
    scope.bindings.set(name, binding);
    allBindings.push(binding);
}

/**
 * Recursively walk the AST, build LocalScope nodes and populate bindings.
 */
function buildScopes(
    node: Parser.SyntaxNode,
    currentScope: LocalScope,
    index: Map<string, LocalScope>,
    allBindings: LocalBinding[]
): void {
    if (node.type !== 'list') {
        // Leaf – nothing to do for scope building.
        return;
    }

    const head = headSymbol(node);
    const children = namedChildren(node);

    // ── (= (fn-name param1 param2 …) body…) ──────────────────────────────
    if (head === '=' && children.length >= 2) {
        const signatureNode = children[1];
        if (signatureNode && signatureNode.type === 'list') {
            const defScope = makeScope(node, currentScope);
            currentScope.children.push(defScope);
            index.set(defScope.id, defScope);

            // Bind parameters (everything after the function name in the signature).
            const sigParts = namedChildren(signatureNode);
            for (let i = 1; i < sigParts.length; i++) {
                const part = sigParts[i];
                if (!part) continue;
                for (const binder of collectPatternBinders(part)) {
                    addBinding(defScope, binder, 'definition-param', allBindings);
                }
            }

            // Walk body nodes inside the definition scope.
            for (let i = 2; i < children.length; i++) {
                const child = children[i];
                if (child) buildScopes(child, defScope, index, allBindings);
            }
            return;
        }
    }

    // ── (let binder value body…) ──────────────────────────────────────────
    if (head === 'let' && children.length >= 3) {
        const letScope = makeScope(node, currentScope);
        currentScope.children.push(letScope);
        index.set(letScope.id, letScope);

        const binderNode = children[1];
        const valueNode = children[2];

        // The value is evaluated in the OUTER scope (standard let semantics).
        if (valueNode) buildScopes(valueNode, currentScope, index, allBindings);

        // Binder is introduced into the let scope.
        if (binderNode) {
            for (const binder of collectPatternBinders(binderNode)) {
                addBinding(letScope, binder, 'let-binder', allBindings);
            }
        }

        // Body nodes are inside the let scope.
        for (let i = 3; i < children.length; i++) {
            const child = children[i];
            if (child) buildScopes(child, letScope, index, allBindings);
        }
        return;
    }

    // ── (let* ((x val) (y val2) …) body…) ────────────────────────────────
    if (head === 'let*' && children.length >= 2) {
        const letStarScope = makeScope(node, currentScope);
        currentScope.children.push(letStarScope);
        index.set(letStarScope.id, letStarScope);

        const bindingsListNode = children[1];
        if (bindingsListNode && bindingsListNode.type === 'list') {
            const pairs = namedChildren(bindingsListNode).filter((c) => c.type === 'list');
            for (const pair of pairs) {
                const pairParts = namedChildren(pair);
                // Value is evaluated in the current accumulated scope (let* semantics).
                if (pairParts[1]) buildScopes(pairParts[1], letStarScope, index, allBindings);
                // Binder extends the same scope (sequential).
                if (pairParts[0]) {
                    for (const binder of collectPatternBinders(pairParts[0])) {
                        addBinding(letStarScope, binder, 'let*-binder', allBindings);
                    }
                }
            }
        }

        for (let i = 2; i < children.length; i++) {
            const child = children[i];
            if (child) buildScopes(child, letStarScope, index, allBindings);
        }
        return;
    }

    // ── (match space pattern body) ────────────────────────────────────────
    if (head === 'match' && children.length >= 4) {
        const matchScope = makeScope(node, currentScope);
        currentScope.children.push(matchScope);
        index.set(matchScope.id, matchScope);

        // Space arg (children[1]) – evaluated in outer scope.
        if (children[1]) buildScopes(children[1], currentScope, index, allBindings);

        // Pattern (children[2]) – introduces bindings.
        const patternNode = children[2];
        if (patternNode) {
            for (const binder of collectPatternBinders(patternNode)) {
                addBinding(matchScope, binder, 'match-pattern', allBindings);
            }
        }

        // Body (children[3…]) – inside match scope.
        for (let i = 3; i < children.length; i++) {
            const child = children[i];
            if (child) buildScopes(child, matchScope, index, allBindings);
        }
        return;
    }

    // ── (case expr ((pat1 body1) (pat2 body2) …)) ─────────────────────────
    if (head === 'case' && children.length >= 3) {
        // Scrutinee in outer scope.
        if (children[1]) buildScopes(children[1], currentScope, index, allBindings);

        const branchesNode = children[2];
        if (branchesNode && branchesNode.type === 'list') {
            for (const branch of namedChildren(branchesNode)) {
                if (branch.type !== 'list') continue;
                const branchScope = makeScope(branch, currentScope);
                currentScope.children.push(branchScope);
                index.set(branchScope.id, branchScope);

                const branchParts = namedChildren(branch);
                // Pattern (first element) – introduces bindings.
                if (branchParts[0]) {
                    for (const binder of collectPatternBinders(branchParts[0])) {
                        addBinding(branchScope, binder, 'case-branch', allBindings);
                    }
                }
                // Body (remaining elements).
                for (let i = 1; i < branchParts.length; i++) {
                    const child = branchParts[i];
                    if (child) buildScopes(child, branchScope, index, allBindings);
                }
            }
        }
        return;
    }

    // ── Default: recurse into children in the current scope ──────────────
    for (const child of children) {
        buildScopes(child, currentScope, index, allBindings);
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a complete ScopeAnalysis for one document tree.
 * This is the entry point called by the Analyzer (or feature handlers).
 */
export function buildScopeAnalysis(tree: Parser.Tree): ScopeAnalysis {
    const rootScope = makeScope(tree.rootNode, null);
    const index = new Map<string, LocalScope>();
    const allBindings: LocalBinding[] = [];

    index.set(rootScope.id, rootScope);

    // Walk top-level expressions.
    for (let i = 0; i < tree.rootNode.childCount; i++) {
        const child = tree.rootNode.child(i);
        if (child && (child.type === 'list' || child.type === 'atom')) {
            buildScopes(child, rootScope, index, allBindings);
        }
    }

    return { root: rootScope, index, allBindings };
}

/**
 * Find the innermost LocalScope that contains the given source position.
 */
export function findScopeAtPosition(
    root: LocalScope,
    line: number,
    col: number
): LocalScope {
    function search(scope: LocalScope): LocalScope {
        for (const child of scope.children) {
            if (
                (line > child.startLine || (line === child.startLine && col >= child.startCol)) &&
                (line < child.endLine || (line === child.endLine && col <= child.endCol))
            ) {
                return search(child);
            }
        }
        return scope;
    }
    return search(root);
}

/**
 * Resolve a symbol/variable name at a given position to its local binding.
 * Returns null if the name has no local binding (i.e. it is a global reference).
 */
export function resolveReference(
    name: string,
    line: number,
    col: number,
    root: LocalScope
): ResolvedReference | null {
    const scope = findScopeAtPosition(root, line, col);

    // Walk scope chain from innermost outward.
    let current: LocalScope | null = scope;
    let firstFound: LocalBinding | null = null;
    let shadowCount = 0;

    while (current) {
        const binding = current.bindings.get(name);
        if (binding) {
            if (firstFound === null) {
                firstFound = binding;
                // Check whether an outer scope also has this name.
                let outer = current.parent;
                while (outer) {
                    if (outer.bindings.has(name)) {
                        shadowCount++;
                    }
                    outer = outer.parent;
                }
            }
        }
        current = current.parent;
    }

    if (!firstFound) return null;

    return {
        binding: firstFound,
        shadows: shadowCount > 0
    };
}

/**
 * Collect all locally-visible bindings at a position (for completions).
 * Walks from the innermost scope outward, de-duplicating by name so that
 * shadowed names appear only once (the innermost wins).
 */
export function getLocalBindingsAtPosition(
    line: number,
    col: number,
    root: LocalScope
): LocalBinding[] {
    const scope = findScopeAtPosition(root, line, col);
    const seen = new Set<string>();
    const result: LocalBinding[] = [];

    let current: LocalScope | null = scope;
    while (current) {
        for (const [name, binding] of current.bindings) {
            if (!seen.has(name)) {
                seen.add(name);
                result.push(binding);
            }
        }
        current = current.parent;
    }

    return result;
}

/**
 * Check whether a reference node at (line, col) with the given name is
 * shadowed by a local binding that is *closer* than the global definition.
 *
 * Returns the shadowing LocalBinding if shadowed, or null otherwise.
 */
export function findShadowingBinding(
    name: string,
    line: number,
    col: number,
    root: LocalScope
): LocalBinding | null {
    const resolved = resolveReference(name, line, col, root);
    if (!resolved) return null;
    // If the resolved binding is not the global one (i.e. it is a local binding), it shadows.
    return resolved.binding;
}

/**
 * Detect all shadowing occurrences across the whole document.
 * Returns pairs of (shadowingBinding, shadowedName) for diagnostic reporting.
 */
export interface ShadowingOccurrence {
    inner: LocalBinding;
    /** Name of the outer binding that is being shadowed. */
    outerName: string;
    /** Range of the outer binding site. */
    outerRange: Range | null;
}

export function detectShadowing(analysis: ScopeAnalysis): ShadowingOccurrence[] {
    const occurrences: ShadowingOccurrence[] = [];

    function walk(scope: LocalScope): void {
        for (const [name, binding] of scope.bindings) {
            // Check whether any ancestor scope has the same name.
            let ancestor = scope.parent;
            while (ancestor) {
                const outer = ancestor.bindings.get(name);
                if (outer) {
                    occurrences.push({
                        inner: binding,
                        outerName: name,
                        outerRange: outer.range
                    });
                    break; // Only report the nearest shadow.
                }
                ancestor = ancestor.parent;
            }
        }
        for (const child of scope.children) {
            walk(child);
        }
    }

    walk(analysis.root);
    return occurrences;
}

/**
 * Given a variable/symbol node from the AST, check whether it is used
 * outside the scope in which it was bound (out-of-scope usage error).
 *
 * Returns the binding whose scope does NOT contain (usageLine, usageCol),
 * or null if the usage is valid.
 */
export function isOutOfScopeUsage(
    name: string,
    usageLine: number,
    usageCol: number,
    analysis: ScopeAnalysis
): LocalBinding | null {
    // Find the binding by walking all scopes (not position-filtered).
    for (const binding of analysis.allBindings) {
        if (binding.name !== name) continue;
        const s = binding.scope;
        const inScope =
            (usageLine > s.startLine || (usageLine === s.startLine && usageCol >= s.startCol)) &&
            (usageLine < s.endLine || (usageLine === s.endLine && usageCol <= s.endCol));
        if (!inScope) return binding;
    }
    return null;
}