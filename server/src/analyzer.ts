import Parser from 'tree-sitter';
import Metta from '../../grammar';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    SymbolKind,
    type CancellationToken,
    type Connection,
    type Position,
    type Range,
    type TextDocumentContentChangeEvent,
    type WorkspaceFolder
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { normalizeUri, uriToPath } from './utils';
import type {
    ModuleMeta,
    ParseCacheEntry,
    ReferenceLocation,
    ScopeNode,
    ScopeTree,
    SymbolEntry
} from './types';

interface ScopeCandidate {
    node: Parser.SyntaxNode;
    startLine: number;
    endLine: number;
    id: string;
}

interface UriIndexedEntry {
    symbolName: string;
    entry: SymbolEntry;
}

interface IncrementalEditComputation {
    edit: Parser.Edit;
    nextContent: string;
}

export default class Analyzer {
    public readonly connection: Connection;
    public readonly parser: Parser;
    public readonly globalIndex: Map<string, SymbolEntry[]>;
    public readonly parseCache: Map<string, ParseCacheEntry>;
    private readonly scopeTrees: Map<string, ScopeTree>;
    private readonly moduleMeta: Map<string, ModuleMeta>;
    private readonly globalModuleRoots: Set<string>;
    private readonly visibleUrisCache: Map<string, Set<string>>;
    private readonly visibleEntriesCache: Map<string, SymbolEntry[]>;
    private readonly indexedContent: Map<string, string>;
    private readonly entriesByUri: Map<string, UriIndexedEntry[]>;
    private readonly workspaceMettaUris: Set<string>;
    private readonly usageByUri: Map<string, Map<string, Range[]>>;
    private readonly usageBySymbol: Map<string, ReferenceLocation[]>;
    public symbolQuery: Parser.Query | null;
    private scopeQuery: Parser.Query | null;
    private usageQuery: Parser.Query | null;

    constructor(connection: Connection) {
        this.connection = connection;
        this.parser = new Parser();
        this.parser.setLanguage(Metta);

        this.globalIndex = new Map();
        this.parseCache = new Map();
        this.scopeTrees = new Map();
        this.moduleMeta = new Map();
        this.globalModuleRoots = new Set();
        this.visibleUrisCache = new Map();
        this.visibleEntriesCache = new Map();
        this.indexedContent = new Map();
        this.entriesByUri = new Map();
        this.workspaceMettaUris = new Set();
        this.usageByUri = new Map();
        this.usageBySymbol = new Map();

        this.symbolQuery = null;
        this.scopeQuery = null;
        this.usageQuery = null;

        this.initializeQueries();
    }

    private initializeQueries(): void {
        this.symbolQuery = this.loadQuery('definitions.scm');
        this.scopeQuery = this.loadQuery('scopes.scm');
        this.usageQuery = this.loadQuery('locals.scm');
    }

    private loadQuery(filename: string): Parser.Query {
        const queryPath = path.resolve(__dirname, '../../grammar/queries/metta', filename);
        try {
            if (fs.existsSync(queryPath)) {
                return new Parser.Query(Metta, fs.readFileSync(queryPath, 'utf8'));
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.error(`Failed to load query ${filename}: ${message}`);
        }
        return new Parser.Query(Metta, '');
    }

    public detectSymbolKind(
        nameNode: Parser.SyntaxNode,
        opNode: Parser.SyntaxNode | null,
        context: string
    ): SymbolKind {
        const op = opNode ? opNode.text : '=';
        const name = nameNode.text;
        const contextStr = context.toLowerCase();

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

    private buildScopeTree(uri: string, tree: Parser.Tree): ScopeTree {
        const scopeTree: ScopeTree = new Map();
        const rootScope: ScopeNode = {
            parent: null,
            children: [],
            symbols: new Set(),
            startLine: 0,
            endLine: Number.POSITIVE_INFINITY,
            nodeId: 'root'
        };
        scopeTree.set('root', rootScope);

        if (!this.scopeQuery) return scopeTree;

        const matches = this.scopeQuery.matches(tree.rootNode);
        const scopes: ScopeCandidate[] = [];

        for (const match of matches) {
            const scopeNode = match.captures.find((capture) => capture.name === 'scope_node')?.node;
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

        const scopeStack: ScopeNode[] = [rootScope];

        for (const scope of scopes) {
            while (
                scopeStack.length > 1 &&
                scopeStack[scopeStack.length - 1].endLine < scope.startLine
            ) {
                scopeStack.pop();
            }

            const parent = scopeStack[scopeStack.length - 1];
            const newScope: ScopeNode = {
                parent,
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
                const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
                if (nameNode) {
                    const symbolLine = nameNode.startPosition.row;
                    const symbolName = nameNode.text;

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

    private buildUsageIndex(tree: Parser.Tree): Map<string, Range[]> {
        const usageIndex = new Map<string, Range[]>();
        if (!this.usageQuery) return usageIndex;

        const matches = this.usageQuery.matches(tree.rootNode);
        for (const match of matches) {
            const symbolNode = match.captures.find((capture) => capture.name === 'symbol')?.node;
            if (!symbolNode) continue;

            const name = symbolNode.text;
            if (!usageIndex.has(name)) {
                usageIndex.set(name, []);
            }
            const ranges = usageIndex.get(name);
            if (!ranges) continue;

            ranges.push({
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

        return usageIndex;
    }

    private clearUsageForUri(uri: string): void {
        const existingBySymbol = this.usageByUri.get(uri);
        if (!existingBySymbol) return;

        for (const symbolName of existingBySymbol.keys()) {
            const refs = this.usageBySymbol.get(symbolName);
            if (!refs) continue;

            const filtered = refs.filter((ref) => ref.uri !== uri);
            if (filtered.length === 0) {
                this.usageBySymbol.delete(symbolName);
            } else {
                this.usageBySymbol.set(symbolName, filtered);
            }
        }

        this.usageByUri.delete(uri);
    }

    private updateUsageIndexes(uri: string, usageIndex: Map<string, Range[]>): void {
        const normalizedUri = normalizeUri(uri);
        this.clearUsageForUri(normalizedUri);
        this.usageByUri.set(normalizedUri, usageIndex);

        for (const [symbolName, ranges] of usageIndex.entries()) {
            if (ranges.length === 0) continue;
            const refs = this.usageBySymbol.get(symbolName) ?? [];
            for (const range of ranges) {
                refs.push({ uri: normalizedUri, range });
            }
            this.usageBySymbol.set(symbolName, refs);
        }
    }

    private cacheParsedTree(uri: string, content: string, tree: Parser.Tree, timestamp: number): ParseCacheEntry {
        const normalizedUri = normalizeUri(uri);
        const oldTree = this.parseCache.get(normalizedUri)?.tree ?? null;
        const usageIndex = this.buildUsageIndex(tree);

        this.buildScopeTree(normalizedUri, tree);
        this.updateUsageIndexes(normalizedUri, usageIndex);

        const cacheEntry: ParseCacheEntry = {
            tree,
            content,
            timestamp,
            usageIndex,
            oldTree
        };

        this.parseCache.set(normalizedUri, cacheEntry);
        return cacheEntry;
    }

    private parseIncrementalContent(
        uri: string,
        content: string,
        cached: ParseCacheEntry,
        changes: readonly TextDocumentContentChangeEvent[]
    ): Parser.Tree | null {
        if (changes.length === 0) {
            return null;
        }

        let workingContent = cached.content;
        const queuedEdits: Parser.Edit[] = [];

        for (const change of changes) {
            if (!('range' in change)) {
                return null;
            }

            const incrementalEdit = buildIncrementalEdit(workingContent, change);
            if (!incrementalEdit) {
                return null;
            }

            queuedEdits.push(incrementalEdit.edit);
            workingContent = incrementalEdit.nextContent;
        }

        if (workingContent !== content) {
            return null;
        }

        const workingTree = cached.tree;
        for (const edit of queuedEdits) {
            workingTree.edit(edit);
        }

        try {
            return this.parser.parse(content, workingTree);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.warn(
                `Incremental parse failed for ${uri}; falling back to full parse: ${message}`
            );
            return null;
        }
    }

    private ensureParsedContent(
        uri: string,
        content: string,
        timestamp: number,
        changes: readonly TextDocumentContentChangeEvent[] | null = null
    ): ParseCacheEntry {
        const normalizedUri = normalizeUri(uri);
        const cached = this.parseCache.get(normalizedUri);
        if (cached && cached.content === content) {
            if (cached.timestamp < timestamp) {
                cached.timestamp = timestamp;
            }
            return cached;
        }

        if (cached && changes && changes.length > 0) {
            const incrementalTree = this.parseIncrementalContent(normalizedUri, content, cached, changes);
            if (incrementalTree) {
                return this.cacheParsedTree(normalizedUri, content, incrementalTree, timestamp);
            }
        }

        if (cached) {
            const diffEdit = buildContentDiffEdit(cached.content, content);
            if (diffEdit) {
                const workingTree = cached.tree;
                workingTree.edit(diffEdit.edit);
                try {
                    const incrementalTree = this.parser.parse(content, workingTree);
                    return this.cacheParsedTree(normalizedUri, content, incrementalTree, timestamp);
                } catch {
                    // Fall back to a full parse below.
                }
            }
        }

        const tree = this.parser.parse(content);
        return this.cacheParsedTree(normalizedUri, content, tree, timestamp);
    }

    public getOrParseFile(uri: string, content: string, oldContent: string | null = null): ParseCacheEntry | null {
        uri = normalizeUri(uri);
        const filePath = uriToPath(uri);
        if (!filePath) {
            try {
                return this.ensureParsedContent(uri, content, Date.now());
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                this.connection.console.error(`Failed to parse in-memory content for ${uri}: ${message}`);
                return null;
            }
        }

        let stats: fs.Stats;
        try {
            stats = fs.statSync(filePath);
        } catch {
            return null;
        }

        const cached = this.parseCache.get(uri);

        if (cached && cached.timestamp >= stats.mtimeMs && cached.content === content) {
            return cached;
        }

        try {
            return this.ensureParsedContent(uri, content, stats.mtimeMs);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.error(`Failed to parse ${uri}: ${message}`);
            return null;
        }
    }

    public getTreeForDocument(uri: string, content: string): Parser.Tree | null {
        uri = normalizeUri(uri);

        const cached = this.parseCache.get(uri);
        if (cached && cached.content === content) {
            return cached.tree;
        }

        try {
            const parsed = this.ensureParsedContent(uri, content, Date.now());
            return parsed.tree;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.error(`Failed to retrieve cached parse for ${uri}: ${message}`);
            return null;
        }
    }

    private clearVisibilityCaches(): void {
        this.visibleUrisCache.clear();
        this.visibleEntriesCache.clear();
    }

    private removeEntriesForUri(uri: string): void {
        const normalizedUri = normalizeUri(uri);
        const existingEntries = this.entriesByUri.get(normalizedUri);
        if (!existingEntries || existingEntries.length === 0) return;

        for (const { symbolName, entry } of existingEntries) {
            const symbols = this.globalIndex.get(symbolName);
            if (!symbols || symbols.length === 0) continue;

            const filtered = symbols.filter((existing) =>
                !(
                    existing.uri === normalizedUri &&
                    existing.range.start.line === entry.range.start.line &&
                    existing.range.start.character === entry.range.start.character &&
                    existing.range.end.line === entry.range.end.line &&
                    existing.range.end.character === entry.range.end.character
                )
            );

            if (filtered.length === 0) {
                this.globalIndex.delete(symbolName);
            } else {
                this.globalIndex.set(symbolName, filtered);
            }
        }

        this.entriesByUri.delete(normalizedUri);
    }

    public indexFile(
        uri: string,
        content: string,
        changes: readonly TextDocumentContentChangeEvent[] | null = null
    ): boolean {
        uri = normalizeUri(uri);
        if (uri.endsWith('.metta')) {
            this.workspaceMettaUris.add(uri);
        }
        const previousIndexedContent = this.indexedContent.get(uri);
        if (previousIndexedContent === content) {
            return false;
        }

        let tree: Parser.Tree;
        try {
            tree = this.ensureParsedContent(uri, content, Date.now(), changes).tree;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.error(`Failed to index ${uri}: ${message}`);
            return false;
        }

        this.clearVisibilityCaches();
        this.removeEntriesForUri(uri);

        if (!this.symbolQuery) {
            this.indexedContent.set(uri, content);
            return true;
        }
        const matches = this.symbolQuery.matches(tree.rootNode);

        const validOps = new Set(['=', ':', 'macro', 'defmacro']);
        this.updateModuleMetadata(uri, tree, content);
        const newEntriesForUri: UriIndexedEntry[] = [];

        for (const match of matches) {
            const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
            const opNode = match.captures.find((capture) => capture.name === 'op')?.node ?? null;
            if (!nameNode) continue;

            const opText = opNode ? opNode.text : '=';
            if (opNode && !validOps.has(opText)) continue;

            const name = nameNode.text;
            const existing = this.globalIndex.get(name);
            if (
                existing &&
                existing.some((entry) =>
                    entry.uri === uri &&
                    entry.range.start.line === nameNode.startPosition.row &&
                    entry.range.start.character === nameNode.startPosition.column
                )
            ) {
                continue;
            }

            let innerList: Parser.SyntaxNode | null = nameNode.parent;
            while (innerList && innerList.type !== 'list') innerList = innerList.parent;
            if (!innerList) continue;

            let definitionNode: Parser.SyntaxNode | null = innerList;
            if (opText === '=' || opText === ':' || opText === 'macro' || opText === 'defmacro') {
                let outer: Parser.SyntaxNode | null = innerList.parent;
                while (outer && outer.type !== 'list') outer = outer.parent;
                if (outer) {
                    definitionNode = outer;
                    const namedArgs = definitionNode.children.filter(
                        (child) => child.type === 'atom' || child.type === 'list'
                    );
                    if (namedArgs.indexOf(innerList) !== 1) continue;

                    const isTopLevel =
                        definitionNode.parent !== null &&
                        definitionNode.parent.type === 'source_file';
                    if (!isTopLevel) continue;
                }
            }

            const context = definitionNode ? definitionNode.text : name;
            const kind = this.detectSymbolKind(nameNode, opNode, context);

            const description: string[] = [];
            let prev: Parser.SyntaxNode | null = definitionNode?.previousSibling ?? null;
            while (prev) {
                if (prev.type === 'comment') {
                    description.unshift(prev.text.replace(/^;+\s*/, '').trim());
                } else if (prev.type === '\n' || prev.text.trim() === '') {
                    // Skip whitespace and newline trivia.
                } else {
                    break;
                }
                prev = prev.previousSibling;
            }

            let parameters: string[] = [];
            let typeSignature: string | null = null;
            let immediateTypeSignature: string | null = null;

            if (opText === '=') {
                const listArgs = innerList.children.filter(
                    (child) => child.type === 'atom' || child.type === 'list'
                );
                parameters = listArgs.slice(1).map((child) => child.text.trim());
                immediateTypeSignature = findImmediateTypeSignature(definitionNode, name);
            } else if (opText === ':' && definitionNode) {
                const args = definitionNode.children.filter(
                    (child) => child.type === 'list' || child.type === 'atom'
                );
                if (args.length > 2) {
                    typeSignature = args[2].text;
                }
            }

            const entry: SymbolEntry = {
                uri,
                kind,
                context,
                op: opText,
                description: description.length > 0 ? description.join('\n') : null,
                parameters: parameters.length > 0 ? parameters : null,
                typeSignature,
                immediateTypeSignature,
                range: {
                    start: {
                        line: nameNode.startPosition.row,
                        character: nameNode.startPosition.column
                    },
                    end: {
                        line: nameNode.endPosition.row,
                        character: nameNode.endPosition.column
                    }
                }
            };

            const existingEntries = this.globalIndex.get(name) ?? [];
            existingEntries.push(entry);
            this.globalIndex.set(name, existingEntries);
            newEntriesForUri.push({ symbolName: name, entry });
        }

        const bindingEntries = collectTopLevelBindingEntries(uri, tree.rootNode);
        for (const { symbolName, entry } of bindingEntries) {
            const existingEntries = this.globalIndex.get(symbolName) ?? [];
            const duplicate = existingEntries.some((existing) =>
                existing.uri === uri &&
                existing.range.start.line === entry.range.start.line &&
                existing.range.start.character === entry.range.start.character &&
                existing.range.end.line === entry.range.end.line &&
                existing.range.end.character === entry.range.end.character
            );
            if (duplicate) continue;

            existingEntries.push(entry);
            this.globalIndex.set(symbolName, existingEntries);
            newEntriesForUri.push({ symbolName, entry });
        }

        this.entriesByUri.set(uri, newEntriesForUri);
        this.indexedContent.set(uri, content);
        return true;
    }

    private updateModuleMetadata(uri: string, tree: Parser.Tree, content: string | null = null): void {
        const oldMeta = this.moduleMeta.get(uri);
        if (oldMeta) {
            for (const root of oldMeta.registerRoots) {
                this.globalModuleRoots.delete(root);
            }
        }

        const imports = new Set<string>();
        const registerRoots = new Set<string>();
        const filePath = uriToPath(uri);
        const fileDir = filePath ? path.dirname(filePath) : null;

        if (typeof content === 'string') {
            const registerRegex = /\(\s*register-module!\s+([^\s)]+)/g;
            let regMatch: RegExpExecArray | null;
            while ((regMatch = registerRegex.exec(content)) !== null) {
                const raw = stripQuotes(regMatch[1].trim());
                if (!raw || raw.startsWith('&') || !fileDir) continue;
                const abs = path.isAbsolute(raw)
                    ? path.resolve(path.normalize(raw))
                    : path.resolve(fileDir, raw);
                registerRoots.add(abs);
            }

            const importRegex = /\(\s*import!\s+([^)]+)\)/g;
            let impMatch: RegExpExecArray | null;
            while ((impMatch = importRegex.exec(content)) !== null) {
                const tokens = impMatch[1]
                    .split(/\s+/)
                    .map((token) => token.trim())
                    .filter(Boolean)
                    .filter((token) => !token.startsWith('&'));
                if (tokens.length === 0) continue;
                imports.add(stripQuotes(tokens[tokens.length - 1]));
            }
        } else {
            traverseTree(tree.rootNode, (node) => {
                if (node.type !== 'list') return;
                const named = node.children.filter((child) => child.type === 'atom' || child.type === 'list');
                if (named.length === 0 || named[0].type !== 'atom') return;
                const head = named[0].text;

                if (head === 'import!') {
                    const importArg = named
                        .slice(1)
                        .map((child) => child.text.trim())
                        .filter((value) => value && !value.startsWith('&'))
                        .pop();
                    if (importArg) imports.add(stripQuotes(importArg));
                }

                if (head === 'register-module!') {
                    for (const arg of named.slice(1)) {
                        const raw = stripQuotes(arg.text.trim());
                        if (!raw || raw.startsWith('&') || !fileDir) continue;
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

    private resolveImportTargets(spec: string, baseUri: string, roots: Iterable<string>): string[] {
        if (!spec) return [];
        const targets: string[] = [];
        const seen = new Set<string>();
        const basePath = uriToPath(baseUri);
        const baseDir = basePath ? path.dirname(basePath) : null;

        const tryPath = (candidate: string): void => {
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
                } catch {
                    // Ignore invalid filesystem candidates.
                }
            }
        };

        const importSpec = stripQuotes(spec);
        if (importSpec.includes(':')) {
            const segments = importSpec.split(':').filter(Boolean);
            const rel = segments.join(path.sep);
            for (const root of roots) {
                tryPath(path.resolve(root, rel));
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

    private getVisibleUris(sourceUri: string): Set<string> {
        const start = normalizeUri(sourceUri);
        const cached = this.visibleUrisCache.get(start);
        if (cached) {
            return cached;
        }

        const visible = new Set<string>([start]);
        const queue: string[] = [start];

        while (queue.length > 0) {
            const uri = queue.shift();
            if (!uri) continue;

            const meta = this.moduleMeta.get(uri);
            if (!meta) continue;

            const roots = new Set<string>([...meta.registerRoots, ...this.globalModuleRoots]);
            for (const spec of meta.imports) {
                const targets = this.resolveImportTargets(spec, uri, roots);
                for (const target of targets) {
                    if (visible.has(target)) continue;
                    visible.add(target);
                    queue.push(target);
                }
            }
        }

        this.visibleUrisCache.set(start, visible);
        return visible;
    }

    private ensureVisibleUrisIndexed(sourceUri: string): void {
        const normalizedSourceUri = normalizeUri(sourceUri);
        const attempted = new Set<string>();
        let discoveredNewFiles = true;

        while (discoveredNewFiles) {
            discoveredNewFiles = false;
            const visibleUris = this.getVisibleUris(normalizedSourceUri);

            for (const uri of visibleUris) {
                if (this.indexedContent.has(uri) || attempted.has(uri)) {
                    continue;
                }
                attempted.add(uri);

                const filePath = uriToPath(uri);
                if (!filePath) continue;

                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    this.indexFile(uri, content);
                    discoveredNewFiles = true;
                } catch {
                    // Ignore unreadable targets; visibility falls back to currently indexed files.
                }
            }
        }
    }

    public getVisibleEntries(symbolName: string, sourceUri: string): SymbolEntry[] {
        const normalizedSourceUri = normalizeUri(sourceUri);
        this.ensureVisibleUrisIndexed(normalizedSourceUri);
        const cacheKey = `${normalizedSourceUri}\u0000${symbolName}`;
        const cached = this.visibleEntriesCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const all = this.globalIndex.get(symbolName) ?? [];
        const visibleUris = this.getVisibleUris(normalizedSourceUri);
        const filtered = all.filter((entry) => visibleUris.has(normalizeUri(entry.uri)));
        this.visibleEntriesCache.set(cacheKey, filtered);
        return filtered;
    }

    public async scanWorkspace(folders: WorkspaceFolder[]): Promise<void> {
        for (const folder of folders) {
            const rootPath = uriToPath(folder.uri);
            if (!rootPath) continue;

            this.connection.console.log(`Scanning workspace folder: ${rootPath}`);
            this.crawlDirectory(rootPath);
        }
    }

    public crawlDirectory(dir: string): void {
        let files: string[];
        try {
            files = fs.readdirSync(dir);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.error(`Error crawling directory ${dir}: ${message}`);
            return;
        }

        for (const file of files) {
            const fullPath = path.join(dir, file);
            let stat: fs.Stats;
            try {
                stat = fs.lstatSync(fullPath);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                this.connection.console.warn(`Skipping path during crawl (${fullPath}): ${message}`);
                continue;
            }

            if (stat.isSymbolicLink()) {
                // Skip symlinks/junctions to avoid invalid reparse points and cycles.
                continue;
            }

            if (stat.isDirectory()) {
                if (file !== 'node_modules' && file !== '.git' && file !== 'vscode-metta') {
                    this.crawlDirectory(fullPath);
                }
                continue;
            }

            if (!stat.isFile() || !file.endsWith('.metta')) {
                continue;
            }

            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const uri = normalizeUri(`file:///${fullPath.replace(/\\/g, '/')}`);
                this.indexFile(uri, content);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                this.connection.console.warn(`Skipping file during crawl (${fullPath}): ${message}`);
            }
        }
    }

    public findAllMettaFiles(
        dir: string,
        uriSet: Set<string>,
        token: CancellationToken | null = null
    ): void {
        let files: string[];
        try {
            if (token?.isCancellationRequested) return;
            files = fs.readdirSync(dir);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.connection.console.error(`Error finding metta files in ${dir}: ${message}`);
            return;
        }

        for (const file of files) {
            if (token?.isCancellationRequested) return;

            const fullPath = path.join(dir, file);
            let stat: fs.Stats;
            try {
                stat = fs.lstatSync(fullPath);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                this.connection.console.warn(`Skipping path while gathering files (${fullPath}): ${message}`);
                continue;
            }

            if (stat.isSymbolicLink()) {
                continue;
            }

            if (stat.isDirectory()) {
                if (file !== 'node_modules' && file !== '.git' && file !== 'vscode-metta') {
                    this.findAllMettaFiles(fullPath, uriSet, token);
                }
                continue;
            }

            if (stat.isFile() && file.endsWith('.metta')) {
                const uri = normalizeUri(`file:///${fullPath.replace(/\\/g, '/')}`);
                uriSet.add(uri);
                this.workspaceMettaUris.add(uri);
            }
        }
    }

    public findAllReferences(
        symbolName: string,
        includeDeclaration = true,
        sourceUri: string | null = null,
        sourcePosition: Position | null = null,
        documents: TextDocuments<TextDocument> | null = null,
        workspaceFolders: WorkspaceFolder[] = [],
        token: CancellationToken | null = null
    ): ReferenceLocation[] {
        const references: ReferenceLocation[] = [];
        const seenKeys = new Set<string>();
        const definitions = this.globalIndex.get(symbolName) ?? [];
        const definitionKeys = new Set<string>();

        for (const def of definitions) {
            const normalizedDefUri = normalizeUri(def.uri);
            const key = `${normalizedDefUri}:${def.range.start.line}:${def.range.start.character}`;
            definitionKeys.add(key);
            if (!includeDeclaration) continue;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            references.push({ uri: normalizedDefUri, range: def.range });
        }

        const candidateUris = new Set<string>();
        for (const uri of this.workspaceMettaUris) {
            candidateUris.add(uri);
        }
        for (const def of definitions) {
            candidateUris.add(normalizeUri(def.uri));
        }
        if (sourceUri) {
            candidateUris.add(normalizeUri(sourceUri));
        }
        if (documents) {
            for (const document of documents.all()) {
                if (document.languageId === 'metta' || document.uri.endsWith('.metta')) {
                    candidateUris.add(normalizeUri(document.uri));
                }
            }
        }

        if (this.workspaceMettaUris.size === 0) {
            for (const folder of workspaceFolders) {
                if (token?.isCancellationRequested) return references;
                const rootPath = uriToPath(folder.uri);
                if (!rootPath) continue;
                this.findAllMettaFiles(rootPath, candidateUris, token);
            }
        }

        for (const candidateUri of candidateUris) {
            if (token?.isCancellationRequested) return references;
            const normalizedCandidateUri = normalizeUri(candidateUri);
            const openDoc = documents?.get(normalizedCandidateUri) ?? documents?.get(candidateUri);
            if (openDoc) {
                this.indexFile(normalizedCandidateUri, openDoc.getText());
                continue;
            }

            const filePath = uriToPath(normalizedCandidateUri);
            if (!filePath || !fs.existsSync(filePath)) continue;

            if (this.indexedContent.has(normalizedCandidateUri)) {
                const cached = this.parseCache.get(normalizedCandidateUri);
                if (cached) {
                    try {
                        const stats = fs.statSync(filePath);
                        if (cached.timestamp >= stats.mtimeMs) {
                            continue;
                        }
                    } catch {
                        continue;
                    }
                } else {
                    continue;
                }
            }

            try {
                const content = fs.readFileSync(filePath, 'utf8');
                this.indexFile(normalizedCandidateUri, content);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                this.connection.console.error(`Error reading file ${filePath}: ${message}`);
            }
        }

        const indexedRefs = this.usageBySymbol.get(symbolName) ?? [];
        for (const ref of indexedRefs) {
            if (token?.isCancellationRequested) return references;
            const normalizedRefUri = normalizeUri(ref.uri);
            const key = `${normalizedRefUri}:${ref.range.start.line}:${ref.range.start.character}`;
            if (!includeDeclaration && definitionKeys.has(key)) continue;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            references.push({ uri: normalizedRefUri, range: ref.range });
        }

        if (sourceUri && sourcePosition && documents) {
            const normalizedSourceUri = normalizeUri(sourceUri);
            const sourceDoc = documents.get(sourceUri) ?? documents.get(normalizedSourceUri);
            if (sourceDoc) {
                return references.filter((ref) => {
                    const normalizedRefUri = normalizeUri(ref.uri);
                    if (normalizedRefUri !== normalizedSourceUri) return true;

                    const refDoc = documents.get(normalizedRefUri) ?? sourceDoc;
                    const refTree = this.getTreeForDocument(normalizedRefUri, refDoc.getText());
                    if (!refTree) return true;

                    const refOffset = refDoc.offsetAt(ref.range.start);
                    const refNode = refTree.rootNode.descendantForIndex(refOffset);
                    if (refNode && this.isSymbolShadowed(refNode, symbolName, refTree, normalizedRefUri)) {
                        return false;
                    }
                    return true;
                });
            }
        }

        return references;
    }

    public isSymbolShadowed(
        node: Parser.SyntaxNode,
        symbolName: string,
        _tree: Parser.Tree,
        uri: string
    ): boolean {
        const scopeTree = this.scopeTrees.get(uri);
        if (!scopeTree) {
            return this.isSymbolShadowedBasic(node, symbolName, _tree);
        }

        const nodeLine = node.startPosition.row;
        let containingScope = scopeTree.get('root');
        if (!containingScope) return false;

        const foundScope = findContainingScope(containingScope, nodeLine);
        if (foundScope) {
            containingScope = foundScope;
        }

        let currentScope: ScopeNode | null = containingScope;
        while (currentScope) {
            if (currentScope.symbols.has(symbolName)) {
                const defs = this.globalIndex.get(symbolName) ?? [];
                for (const def of defs) {
                    if (def.uri === uri) {
                        const defLine = def.range.start.line;
                        if (
                            defLine >= currentScope.startLine &&
                            defLine <= currentScope.endLine &&
                            defLine < nodeLine
                        ) {
                            return true;
                        }
                    }
                }
            }
            currentScope = currentScope.parent;
        }

        return false;
    }

    private isSymbolShadowedBasic(node: Parser.SyntaxNode, symbolName: string, _tree: Parser.Tree): boolean {
        let current: Parser.SyntaxNode | null = node.parent;
        while (current) {
            if (current.type === 'list') {
                const head = current.firstChild;
                if (head && head.type === 'atom') {
                    const headSymbol = head.firstChild;
                    if (
                        headSymbol &&
                        (headSymbol.text === 'let' || headSymbol.text === 'let*' || headSymbol.text === 'match')
                    ) {
                        if (this.symbolQuery) {
                            const scopeMatches = this.symbolQuery.matches(current);
                            for (const match of scopeMatches) {
                                const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
                                if (nameNode && nameNode.text === symbolName) {
                                    if (
                                        nameNode.startPosition.row < node.startPosition.row ||
                                        (
                                            nameNode.startPosition.row === node.startPosition.row &&
                                            nameNode.startPosition.column < node.startPosition.column
                                        )
                                    ) {
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

function stripQuotes(text: string): string {
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith('\'') && text.endsWith('\''))
    ) {
        return text.slice(1, -1);
    }
    return text;
}

function isEolChar(charCode: number): boolean {
    return charCode === 13 || charCode === 10;
}

function computeLineOffsets(content: string): number[] {
    const lineOffsets: number[] = [0];
    for (let i = 0; i < content.length; i++) {
        const ch = content.charCodeAt(i);
        if (!isEolChar(ch)) {
            continue;
        }
        if (ch === 13 && i + 1 < content.length && content.charCodeAt(i + 1) === 10) {
            i += 1;
        }
        lineOffsets.push(i + 1);
    }
    return lineOffsets;
}

function ensureBeforeEol(content: string, offset: number, lineOffset: number): number {
    let adjustedOffset = offset;
    while (adjustedOffset > lineOffset && isEolChar(content.charCodeAt(adjustedOffset - 1))) {
        adjustedOffset -= 1;
    }
    return adjustedOffset;
}

function offsetAtPosition(content: string, lineOffsets: number[], position: Position): number {
    if (position.line >= lineOffsets.length) {
        return content.length;
    }
    if (position.line < 0) {
        return 0;
    }

    const lineOffset = lineOffsets[position.line];
    if (position.character <= 0) {
        return lineOffset;
    }

    const nextLineOffset = position.line + 1 < lineOffsets.length
        ? lineOffsets[position.line + 1]
        : content.length;
    const rawOffset = Math.min(lineOffset + position.character, nextLineOffset);
    return ensureBeforeEol(content, rawOffset, lineOffset);
}

function positionIsAfter(left: Position, right: Position): boolean {
    if (left.line !== right.line) return left.line > right.line;
    return left.character > right.character;
}

function normalizeRange(range: Range): Range {
    if (positionIsAfter(range.start, range.end)) {
        return { start: range.end, end: range.start };
    }
    return range;
}

function lineForOffset(lineOffsets: number[], offset: number): number {
    let low = 0;
    let high = lineOffsets.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (lineOffsets[mid] > offset) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    return Math.max(0, low - 1);
}

function utf8ByteOffsetAt(content: string, offset: number): number {
    const clampedOffset = Math.max(0, Math.min(offset, content.length));
    return Buffer.byteLength(content.slice(0, clampedOffset), 'utf8');
}

function treePointAt(content: string, lineOffsets: number[], offset: number): Parser.Point {
    const clampedOffset = Math.max(0, Math.min(offset, content.length));
    const row = lineForOffset(lineOffsets, clampedOffset);
    const lineStart = lineOffsets[row] ?? 0;
    const column = Buffer.byteLength(content.slice(lineStart, clampedOffset), 'utf8');
    return { row, column };
}

function buildIncrementalEdit(
    content: string,
    change: { range: Range; text: string }
): IncrementalEditComputation | null {
    const safeRange = normalizeRange(change.range);
    const oldLineOffsets = computeLineOffsets(content);
    const startOffset = offsetAtPosition(content, oldLineOffsets, safeRange.start);
    const oldEndOffset = offsetAtPosition(content, oldLineOffsets, safeRange.end);
    if (oldEndOffset < startOffset) {
        return null;
    }

    const nextContent = `${content.slice(0, startOffset)}${change.text}${content.slice(oldEndOffset)}`;
    const newEndOffset = startOffset + change.text.length;
    const newLineOffsets = computeLineOffsets(nextContent);

    return {
        edit: {
            startIndex: utf8ByteOffsetAt(content, startOffset),
            oldEndIndex: utf8ByteOffsetAt(content, oldEndOffset),
            newEndIndex: utf8ByteOffsetAt(nextContent, newEndOffset),
            startPosition: treePointAt(content, oldLineOffsets, startOffset),
            oldEndPosition: treePointAt(content, oldLineOffsets, oldEndOffset),
            newEndPosition: treePointAt(nextContent, newLineOffsets, newEndOffset)
        },
        nextContent
    };
}

function buildContentDiffEdit(oldContent: string, newContent: string): IncrementalEditComputation | null {
    if (oldContent === newContent) {
        return null;
    }

    const minLength = Math.min(oldContent.length, newContent.length);
    let prefixLength = 0;
    while (prefixLength < minLength && oldContent.charCodeAt(prefixLength) === newContent.charCodeAt(prefixLength)) {
        prefixLength += 1;
    }

    let oldSuffixStart = oldContent.length;
    let newSuffixStart = newContent.length;
    while (
        oldSuffixStart > prefixLength &&
        newSuffixStart > prefixLength &&
        oldContent.charCodeAt(oldSuffixStart - 1) === newContent.charCodeAt(newSuffixStart - 1)
    ) {
        oldSuffixStart -= 1;
        newSuffixStart -= 1;
    }

    const oldLineOffsets = computeLineOffsets(oldContent);
    const newLineOffsets = computeLineOffsets(newContent);
    return {
        edit: {
            startIndex: utf8ByteOffsetAt(oldContent, prefixLength),
            oldEndIndex: utf8ByteOffsetAt(oldContent, oldSuffixStart),
            newEndIndex: utf8ByteOffsetAt(newContent, newSuffixStart),
            startPosition: treePointAt(oldContent, oldLineOffsets, prefixLength),
            oldEndPosition: treePointAt(oldContent, oldLineOffsets, oldSuffixStart),
            newEndPosition: treePointAt(newContent, newLineOffsets, newSuffixStart)
        },
        nextContent: newContent
    };
}

function getNamedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    return node.children.filter((child) => child.type === 'atom' || child.type === 'list');
}

function isIgnorableSibling(node: Parser.SyntaxNode | null): boolean {
    if (!node) return true;
    if (node.type === 'comment') return true;
    if (node.type === '\n') return true;
    return node.text.trim() === '';
}

function getHeadSymbol(listNode: Parser.SyntaxNode): string | null {
    if (listNode.type !== 'list') return null;
    const named = getNamedChildren(listNode);
    if (named.length === 0 || named[0].type !== 'atom') return null;
    const symbolNode = named[0].children.find((child) => child.type === 'symbol');
    return symbolNode ? symbolNode.text : null;
}

function getAtomSymbol(atomNode: Parser.SyntaxNode | null): string | null {
    if (!atomNode || atomNode.type !== 'atom') return null;
    const symbolNode = atomNode.children.find((child) => child.type === 'symbol');
    return symbolNode ? symbolNode.text : null;
}

function getAtomSymbolNode(atomNode: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
    if (!atomNode || atomNode.type !== 'atom') return null;
    const symbolNode = atomNode.children.find((child) => child.type === 'symbol');
    return symbolNode ?? null;
}

function collectTopLevelEvaluatedForms(rootNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const forms: Parser.SyntaxNode[] = [];
    for (let i = 0; i < rootNode.namedChildCount; i++) {
        const node = rootNode.namedChild(i);
        if (!node || node.type !== 'atom') continue;

        const symbolNode = getAtomSymbolNode(node);
        if (!symbolNode || symbolNode.text !== '!') continue;

        const next = rootNode.namedChild(i + 1);
        if (next && next.type === 'list') {
            forms.push(next);
            i += 1;
        }
    }
    return forms;
}

function collectTopLevelBindingEntries(
    uri: string,
    rootNode: Parser.SyntaxNode
): Array<{ symbolName: string; entry: SymbolEntry }> {
    const indexed: Array<{ symbolName: string; entry: SymbolEntry }> = [];

    for (const form of collectTopLevelEvaluatedForms(rootNode)) {
        if (getHeadSymbol(form) !== 'bind!') continue;
        const named = getNamedChildren(form);
        if (named.length < 2) continue;

        const targetAtom = named[1];
        const symbolNode = getAtomSymbolNode(targetAtom);
        if (!symbolNode) continue;

        const symbolName = symbolNode.text;
        const entry: SymbolEntry = {
            uri,
            kind: symbolName.startsWith('&') ? SymbolKind.Object : SymbolKind.Variable,
            context: form.text,
            op: 'bind!',
            description: null,
            parameters: null,
            typeSignature: null,
            immediateTypeSignature: null,
            range: {
                start: {
                    line: symbolNode.startPosition.row,
                    character: symbolNode.startPosition.column
                },
                end: {
                    line: symbolNode.endPosition.row,
                    character: symbolNode.endPosition.column
                }
            }
        };

        indexed.push({ symbolName, entry });
    }

    return indexed;
}

function findImmediateTypeSignature(
    definitionNode: Parser.SyntaxNode | null,
    functionName: string
): string | null {
    if (!definitionNode) return null;
    let prev: Parser.SyntaxNode | null = definitionNode.previousSibling;
    while (prev && isIgnorableSibling(prev)) {
        prev = prev.previousSibling;
    }
    if (!prev || prev.type !== 'list') return null;
    if (getHeadSymbol(prev) !== ':') return null;

    const named = getNamedChildren(prev);
    if (named.length < 3) return null;
    const declaredName = getAtomSymbol(named[1]);
    if (declaredName !== functionName) return null;
    return named[2]?.text ?? null;
}

function traverseTree(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) traverseTree(child, callback);
    }
}

function findScopeForLine(scope: ScopeNode, line: number): ScopeNode | null {
    if (line < scope.startLine || line > scope.endLine) {
        return null;
    }

    for (const child of scope.children) {
        const found = findScopeForLine(child, line);
        if (found) return found;
    }

    return scope;
}

function findContainingScope(scope: ScopeNode, line: number): ScopeNode | null {
    for (const child of scope.children) {
        if (line >= child.startLine && line <= child.endLine) {
            const deeper = findContainingScope(child, line);
            return deeper ?? child;
        }
    }
    return null;
}
