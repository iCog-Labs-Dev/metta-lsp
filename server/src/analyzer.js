const Parser = require('tree-sitter');
const Metta = require('../../grammar');
const fs = require('fs');
const path = require('path');
const { SymbolKind } = require('vscode-languageserver/node');
const { uriToPath, normalizeUri } = require('./utils');

class Analyzer {
    constructor(connection) {
        this.connection = connection;
        this.parser = new Parser();
        this.parser.setLanguage(Metta);

        this.globalIndex = new Map();
        this.parseCache = new Map();
        this.scopeTrees = new Map();
        this.moduleMeta = new Map();
        this.globalModuleRoots = new Set();

        this.initializeQueries();
    }

    initializeQueries() {
        this.symbolQuery = this.loadQuery('definitions.scm');
        this.scopeQuery = this.loadQuery('scopes.scm');
        this.usageQuery = this.loadQuery('locals.scm');
    }

    loadQuery(filename) {
        const queryPath = path.resolve(__dirname, '../../grammar/queries/metta', filename);
        try {
            if (fs.existsSync(queryPath)) {
                return new Parser.Query(Metta, fs.readFileSync(queryPath, 'utf8'));
            }
        } catch (e) {
            if (this.connection) {
                this.connection.console.error(`Failed to load query ${filename}: ${e.message}`);
            }
        }
        return new Parser.Query(Metta, "");
    }

    detectSymbolKind(nameNode, opNode, context) {
        const op = opNode ? opNode.text : "=";
        const name = nameNode.text;
        const contextStr = context ? context.toLowerCase() : "";

        if (op === ':') {
            return SymbolKind.Interface;
        }

        if (op === '=') {
            if (name.endsWith('?') || name.startsWith('is-') || name.startsWith('has-')) {
                return SymbolKind.Boolean;
            }
            return SymbolKind.Function;
        }

        if (op === '->') {
            return SymbolKind.Function;
        }

        if (contextStr.includes('macro') || contextStr.includes('defmacro')) {
            return SymbolKind.Constant;
        }

        return SymbolKind.Function;
    }

    buildScopeTree(uri, tree) {
        const scopeTree = new Map();
        const rootScope = { parent: null, children: [], symbols: new Set(), startLine: 0, endLine: Infinity, nodeId: 'root' };
        scopeTree.set('root', rootScope);

        if (!this.scopeQuery) return scopeTree;

        const matches = this.scopeQuery.matches(tree.rootNode);
        const scopes = [];

        for (const match of matches) {
            const scopeNode = match.captures.find(c => c.name === 'scope_node')?.node;
            if (scopeNode) {
                scopes.push({
                    node: scopeNode,
                    startLine: scopeNode.startPosition.row,
                    endLine: scopeNode.endPosition.row,
                    id: `${scopeNode.startPosition.row}:${scopeNode.startPosition.column}`
                });
            }
        }

        scopes.sort((a, b) => {
            if (a.startLine !== b.startLine) return a.startLine - b.startLine;
            return a.node.startPosition.column - b.node.startPosition.column;
        });

        const scopeStack = [rootScope];

        for (const scope of scopes) {
            while (scopeStack.length > 1 && scopeStack[scopeStack.length - 1].endLine < scope.startLine) {
                scopeStack.pop();
            }

            const parent = scopeStack[scopeStack.length - 1];
            const newScope = {
                parent: parent,
                children: [],
                symbols: new Set(),
                startLine: scope.startLine,
                endLine: scope.endLine,
                nodeId: scope.id
            };

            parent.children.push(newScope);
            scopeTree.set(scope.id, newScope);
            scopeStack.push(newScope);
        }

        if (this.symbolQuery) {
            const symbolMatches = this.symbolQuery.matches(tree.rootNode);
            for (const match of symbolMatches) {
                const nameNode = match.captures.find(c => c.name === 'name')?.node;
                if (nameNode) {
                    const symbolLine = nameNode.startPosition.row;
                    const symbolName = nameNode.text;

                    function findScopeForLine(scope, line) {
                        if (line < scope.startLine || line > scope.endLine) {
                            return null;
                        }

                        for (const child of scope.children) {
                            const found = findScopeForLine(child, line);
                            if (found) return found;
                        }

                        return scope;
                    }

                    const containingScope = findScopeForLine(rootScope, symbolLine);
                    if (containingScope) {
                        containingScope.symbols.add(symbolName);
                    }
                }
            }
        }

        this.scopeTrees.set(uri, scopeTree);
        return scopeTree;
    }

    getOrParseFile(uri, content, oldContent = null) {
        uri = normalizeUri(uri);
        const filePath = uriToPath(uri);
        if (!filePath) return null;

        let stats = null;
        try {
            stats = fs.statSync(filePath);
        } catch (e) {
            return null;
        }

        const cached = this.parseCache.get(uri);

        if (cached && oldContent !== null && cached.oldTree) {
        }

        if (cached && cached.timestamp >= stats.mtimeMs && cached.content === content) {
            return cached;
        }

        const oldTree = cached?.tree || null;
        const tree = this.parser.parse(content);
        const usageIndex = new Map();

        if (this.usageQuery) {
            const matches = this.usageQuery.matches(tree.rootNode);
            for (const match of matches) {
                const symbolNode = match.captures.find(c => c.name === 'symbol')?.node;
                if (symbolNode) {
                    const name = symbolNode.text;
                    if (!usageIndex.has(name)) {
                        usageIndex.set(name, []);
                    }
                    usageIndex.get(name).push({
                        start: {
                            line: symbolNode.startPosition.row,
                            character: symbolNode.startPosition.column
                        },
                        end: {
                            line: symbolNode.endPosition.row,
                            character: symbolNode.endPosition.column
                        }
                    });
                }
            }
        }

        this.buildScopeTree(uri, tree);

        const cacheEntry = {
            tree,
            content,
            timestamp: stats.mtimeMs,
            usageIndex,
            oldTree
        };

        this.parseCache.set(uri, cacheEntry);
        return cacheEntry;
    }

    indexFile(uri, content) {
        uri = normalizeUri(uri);
        const tree = this.parser.parse(content);

        if (!this.symbolQuery) return;

        const matches = this.symbolQuery.matches(tree.rootNode);

        for (const [name, symbols] of this.globalIndex.entries()) {
            const filtered = symbols.filter(s => s.uri !== uri);
            if (filtered.length === 0) {
                this.globalIndex.delete(name);
            } else {
                this.globalIndex.set(name, filtered);
            }
        }

        const validOps = new Set(['=', ':', '->', 'macro', 'defmacro']);
        this.updateModuleMetadata(uri, tree, content);

        for (const match of matches) {
            const nameNode = match.captures.find(c => c.name === 'name')?.node;
            const opNode = match.captures.find(c => c.name === 'op')?.node;

            if (nameNode) {
                const opText = opNode ? opNode.text : '=';
                if (opNode && !validOps.has(opText)) {
                    // Workaround for tree-sitter node bindings ignoring #any-of? predicates
                    continue;
                }

                const name = nameNode.text;
                const existing = this.globalIndex.get(name);
                if (existing && existing.some(e => e.uri === uri &&
                    e.range.start.line === nameNode.startPosition.row &&
                    e.range.start.character === nameNode.startPosition.column)) {
                    continue;
                }

                let innerList = nameNode.parent;
                while (innerList && innerList.type !== 'list') innerList = innerList.parent;

                let definitionNode = innerList;
                if (opText === '=' || opText === ':' || opText === 'macro' || opText === 'defmacro') {
                    let outer = innerList.parent;
                    while (outer && outer.type !== 'list') outer = outer.parent;
                    if (outer) {
                        definitionNode = outer;
                        const namedArgs = definitionNode.children.filter(c => c.type === 'atom' || c.type === 'list');
                        if (namedArgs.indexOf(innerList) !== 1) {
                            continue;
                        }

                        const isTopLevel = definitionNode.parent && definitionNode.parent.type === 'source_file';
                        if (!isTopLevel) {
                            continue;
                        }
                    }
                }

                const context = definitionNode ? definitionNode.text : name;
                const kind = this.detectSymbolKind(nameNode, opNode, context);

                let description = [];
                let prev = definitionNode ? definitionNode.previousSibling : null;
                while (prev) {
                    if (prev.type === 'comment') {
                        description.unshift(prev.text.replace(/^;+\s*/, '').trim());
                    } else if (prev.type === '\n' || !prev.type || prev.text.trim() === '') {
                        // skip whitespace
                    } else {
                        break;
                    }
                    prev = prev.previousSibling;
                }

                let parameters = [];
                let typeSignature = null;

                if (opText === '=') {
                    if (innerList) {
                        const listArgs = innerList.children.filter(c => c.type === 'atom' || c.type === 'list');
                        parameters = listArgs.slice(1).map(c => c.text.trim());
                    }
                } else if (opText === ':') {
                    const args = definitionNode ? definitionNode.children.filter(c => c.type === 'list' || c.type === 'atom') : [];
                    if (args.length > 2) {
                        typeSignature = args[2].text;
                    }
                }

                const entry = {
                    uri,
                    kind,
                    context,
                    op: opText,
                    description: description.length > 0 ? description.join('\n') : null,
                    parameters: parameters.length > 0 ? parameters : null,
                    typeSignature,
                    range: {
                        start: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
                        end: { line: nameNode.endPosition.row, character: nameNode.endPosition.column },
                    }
                };

                const existingEntries = this.globalIndex.get(name) || [];
                existingEntries.push(entry);
                this.globalIndex.set(name, existingEntries);
            }
        }

    }

    updateModuleMetadata(uri, tree, content = null) {
        const oldMeta = this.moduleMeta.get(uri);
        if (oldMeta) {
            for (const root of oldMeta.registerRoots) {
                this.globalModuleRoots.delete(root);
            }
        }

        const imports = new Set();
        const registerRoots = new Set();
        const filePath = uriToPath(uri);
        const fileDir = filePath ? path.dirname(filePath) : null;

        if (typeof content === 'string') {
            const registerRegex = /\(\s*register-module!\s+([^\s\)]+)/g;
            let regMatch;
            while ((regMatch = registerRegex.exec(content)) !== null) {
                const raw = stripQuotes(regMatch[1].trim());
                if (!raw || raw.startsWith('&') || !fileDir) continue;
                const abs = path.isAbsolute(raw)
                    ? path.resolve(path.normalize(raw))
                    : path.resolve(fileDir, raw);
                registerRoots.add(abs);
            }

            const importRegex = /\(\s*import!\s+([^\)]*)\)/g;
            let impMatch;
            while ((impMatch = importRegex.exec(content)) !== null) {
                const argString = impMatch[1];
                const tokens = argString
                    .split(/\s+/)
                    .map(t => t.trim())
                    .filter(Boolean)
                    .filter(t => !t.startsWith('&'));
                if (tokens.length === 0) continue;
                imports.add(stripQuotes(tokens[tokens.length - 1]));
            }
        } else {
            traverseTree(tree.rootNode, (node) => {
                if (node.type !== 'list') return;
                const named = node.children.filter(c => c.type === 'atom' || c.type === 'list');
                if (named.length === 0 || named[0].type !== 'atom') return;
                const head = named[0].text;

                if (head === 'import!') {
                    const importArg = named
                        .slice(1)
                        .map(n => n.text.trim())
                        .filter(v => v && !v.startsWith('&'))
                        .pop();
                    if (importArg) imports.add(stripQuotes(importArg));
                }

                if (head === 'register-module!') {
                    for (const arg of named.slice(1)) {
                        const raw = stripQuotes(arg.text.trim());
                        if (!raw || raw.startsWith('&')) continue;
                        if (!fileDir) continue;
                        const abs = path.isAbsolute(raw)
                            ? path.resolve(path.normalize(raw))
                            : path.resolve(fileDir, raw);
                        registerRoots.add(abs);
                    }
                }
            });
        }

        for (const root of registerRoots) {
            this.globalModuleRoots.add(root);
        }
        this.moduleMeta.set(uri, {
            imports: Array.from(imports),
            registerRoots: Array.from(registerRoots)
        });
    }

    resolveImportTargets(spec, baseUri, roots) {
        if (!spec) return [];
        const targets = [];
        const seen = new Set();
        const basePath = uriToPath(baseUri);
        const baseDir = basePath ? path.dirname(basePath) : null;
        const tryPath = (candidate) => {
            if (!candidate) return;
            const variants = [candidate];
            if (!candidate.endsWith('.metta')) variants.push(`${candidate}.metta`);
            variants.push(path.join(candidate, 'main.metta'));
            for (const variant of variants) {
                try {
                    if (fs.existsSync(variant) && fs.statSync(variant).isFile()) {
                        const uri = normalizeUri(`file:///${variant.replace(/\\/g, '/')}`);
                        if (!seen.has(uri)) {
                            seen.add(uri);
                            targets.push(uri);
                        }
                    }
                } catch (e) {
                    // Ignore invalid candidates
                }
            }
        };

        const importSpec = stripQuotes(spec);
        if (importSpec.includes(':')) {
            const segments = importSpec.split(':').filter(Boolean);
            const rel = segments.join(path.sep);
            for (const root of roots) {
                tryPath(path.resolve(root, rel));
                // Support register-module! pointing at module root while import
                // includes the module name prefix (e.g. root ".../hyperon-openpsi"
                // with import "hyperon-openpsi:main:...").
                const rootBase = path.basename(root).toLowerCase();
                if (segments.length > 1 && segments[0].toLowerCase() === rootBase) {
                    tryPath(path.resolve(root, ...segments.slice(1)));
                }
            }
        } else if (importSpec.includes('/') || importSpec.includes('\\') || importSpec.startsWith('.')) {
            if (baseDir) tryPath(path.resolve(baseDir, importSpec));
            for (const root of roots) {
                tryPath(path.resolve(root, importSpec));
            }
        } else {
            if (baseDir) tryPath(path.resolve(baseDir, importSpec));
            for (const root of roots) {
                tryPath(path.resolve(root, importSpec));
            }
        }

        return targets;
    }

    getVisibleUris(sourceUri) {
        const start = normalizeUri(sourceUri);
        const visible = new Set([start]);
        const queue = [start];

        while (queue.length > 0) {
            const uri = queue.shift();
            const meta = this.moduleMeta.get(uri);
            if (!meta) continue;

            const roots = new Set([...(meta.registerRoots || []), ...this.globalModuleRoots]);
            for (const spec of meta.imports || []) {
                const targets = this.resolveImportTargets(spec, uri, roots);
                for (const target of targets) {
                    if (visible.has(target)) continue;
                    visible.add(target);
                    queue.push(target);
                }
            }
        }

        return visible;
    }

    getVisibleEntries(symbolName, sourceUri) {
        const all = this.globalIndex.get(symbolName) || [];
        const visibleUris = this.getVisibleUris(sourceUri);
        return all.filter(entry => visibleUris.has(normalizeUri(entry.uri)));
    }

    async scanWorkspace(folders) {
        for (const folder of folders) {
            const rootPath = uriToPath(folder.uri);
            if (!rootPath) continue;

            if (this.connection) {
                this.connection.console.log(`Scanning workspace folder: ${rootPath}`);
            }
            this.crawlDirectory(rootPath);
        }
    }

    crawlDirectory(dir) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    if (file !== 'node_modules' && file !== '.git' && file !== 'vscode-metta') {
                        this.crawlDirectory(fullPath);
                    }
                } else if (file.endsWith('.metta')) {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const uri = normalizeUri(`file:///${fullPath.replace(/\\/g, '/')}`);
                    this.indexFile(uri, content);
                }
            }
        } catch (e) {
            if (this.connection) {
                this.connection.console.error(`Error crawling directory ${dir}: ${e.message}`);
            }
        }
    }

    findAllMettaFiles(dir, uriSet) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    if (file !== 'node_modules' && file !== '.git' && file !== 'vscode-metta') {
                        this.findAllMettaFiles(fullPath, uriSet);
                    }
                } else if (file.endsWith('.metta')) {
                    const uri = normalizeUri(`file:///${fullPath.replace(/\\/g, '/')}`);
                    uriSet.add(uri);
                }
            }
        } catch (e) {
            if (this.connection) {
                this.connection.console.error(`Error finding metta files in ${dir}: ${e.message}`);
            }
        }
    }

    findAllReferences(symbolName, includeDeclaration = true, sourceUri = null, sourcePosition = null, documents = null, workspaceFolders = []) {
        const references = [];
        const seenKeys = new Set();

        const definitions = this.globalIndex.get(symbolName) || [];
        if (includeDeclaration) {
            for (const def of definitions) {
                const normalizedDefUri = normalizeUri(def.uri);
                const key = `${normalizedDefUri}:${def.range.start.line}:${def.range.start.character}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    references.push({ uri: normalizedDefUri, range: def.range });
                }
            }
        }

        const allUris = new Set();
        for (const def of definitions) {
            allUris.add(def.uri);
        }

        for (const folder of workspaceFolders) {
            const rootPath = uriToPath(folder.uri);
            if (rootPath) {
                this.findAllMettaFiles(rootPath, allUris);
            }
        }

        for (const uri of allUris) {
            const normalizedFileUri = normalizeUri(uri);
            const filePath = uriToPath(normalizedFileUri);
            if (!filePath || !fs.existsSync(filePath)) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const cached = this.getOrParseFile(normalizedFileUri, content);

                if (cached && cached.usageIndex.has(symbolName)) {
                    const ranges = cached.usageIndex.get(symbolName);
                    for (const range of ranges) {
                        const key = `${normalizedFileUri}:${range.start.line}:${range.start.character}`;
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            references.push({ uri: normalizedFileUri, range });
                        }
                    }
                }
            } catch (e) {
                if (this.connection) {
                    this.connection.console.error(`Error reading file ${filePath}: ${e.message}`);
                }
            }
        }

        if (documents) {
            for (const document of documents.all()) {
                const normalizedDocUri = normalizeUri(document.uri);
                if (!allUris.has(normalizedDocUri)) {
                    try {
                        const content = document.getText();
                        const cached = this.getOrParseFile(normalizedDocUri, content);

                        if (cached && cached.usageIndex.has(symbolName)) {
                            const ranges = cached.usageIndex.get(symbolName);
                            for (const range of ranges) {
                                const key = `${normalizedDocUri}:${range.start.line}:${range.start.character}`;
                                if (!seenKeys.has(key)) {
                                    seenKeys.add(key);
                                    references.push({ uri: normalizedDocUri, range });
                                }
                            }
                        }
                    } catch (e) {
                        if (this.connection) {
                            this.connection.console.error(`Error parsing document ${normalizedDocUri}: ${e.message}`);
                        }
                    }
                }
            }
        }

        if (sourceUri && sourcePosition && documents) {
            const sourceDoc = documents.get(sourceUri);
            if (sourceDoc) {
                const cached = this.getOrParseFile(sourceUri, sourceDoc.getText());
                const sourceTree = cached ? cached.tree : this.parser.parse(sourceDoc.getText());

                return references.filter(ref => {
                    if (ref.uri === sourceUri) {
                        const refDoc = documents.get(ref.uri) || sourceDoc;
                        const refCached = this.getOrParseFile(ref.uri, refDoc.getText());
                        const refTree = refCached ? refCached.tree : this.parser.parse(refDoc.getText());
                        if (refTree) {
                            const refOffset = refDoc.offsetAt(ref.range.start);
                            const refNode = refTree.rootNode.descendantForIndex(refOffset);
                            if (refNode && this.isSymbolShadowed(refNode, symbolName, refTree, ref.uri)) {
                                return false;
                            }
                        }
                    }
                    return true;
                });
            }
        }

        return references;
    }

    isSymbolShadowed(node, symbolName, tree, uri) {
        const scopeTree = this.scopeTrees.get(uri);
        if (!scopeTree) {
            return this.isSymbolShadowedBasic(node, symbolName, tree);
        }

        const nodeLine = node.startPosition.row;
        let containingScope = scopeTree.get('root');

        function findContainingScope(scope, line) {
            for (const child of scope.children) {
                if (line >= child.startLine && line <= child.endLine) {
                    const deeper = findContainingScope(child, line);
                    return deeper || child;
                }
            }
            return null;
        }

        const foundScope = findContainingScope(containingScope, nodeLine);
        if (foundScope) {
            containingScope = foundScope;
        }

        let currentScope = containingScope;
        while (currentScope) {
            if (currentScope.symbols.has(symbolName)) {
                const defs = this.globalIndex.get(symbolName) || [];
                for (const def of defs) {
                    if (def.uri === uri) {
                        const defLine = def.range.start.line;
                        if (defLine >= currentScope.startLine && defLine <= currentScope.endLine &&
                            defLine < nodeLine) {
                            return true;
                        }
                    }
                }
            }
            currentScope = currentScope.parent;
        }

        return false;
    }

    isSymbolShadowedBasic(node, symbolName, tree) {
        let current = node.parent;
        while (current) {
            if (current.type === 'list') {
                const head = current.firstChild;
                if (head && head.type === 'atom') {
                    const headSymbol = head.firstChild;
                    if (headSymbol && (headSymbol.text === 'let' || headSymbol.text === 'let*' || headSymbol.text === 'match')) {
                        if (this.symbolQuery) {
                            const scopeMatches = this.symbolQuery.matches(current);
                            for (const match of scopeMatches) {
                                const nameNode = match.captures.find(c => c.name === 'name')?.node;
                                if (nameNode && nameNode.text === symbolName) {
                                    if (nameNode.startPosition.row < node.startPosition.row ||
                                        (nameNode.startPosition.row === node.startPosition.row &&
                                            nameNode.startPosition.column < node.startPosition.column)) {
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            current = current.parent;
        }
        return false;
    }
}

function stripQuotes(text) {
    if (!text) return text;
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
    }
    return text;
}

function traverseTree(node, callback) {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        traverseTree(node.child(i), callback);
    }
}

module.exports = Analyzer;
