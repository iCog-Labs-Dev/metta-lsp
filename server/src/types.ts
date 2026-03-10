import type Parser from 'tree-sitter';
import type {
    CancellationToken,
    Connection,
    Position,
    Range,
    SymbolKind,
    WorkspaceFolder
} from 'vscode-languageserver/node';
import type { TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export interface SymbolEntry {
    uri: string;
    kind: SymbolKind;
    context: string;
    op: string;
    description: string | null;
    parameters: string[] | null;
    typeSignature: string | null;
    range: Range;
}

export interface ScopeNode {
    parent: ScopeNode | null;
    children: ScopeNode[];
    symbols: Set<string>;
    startLine: number;
    endLine: number;
    nodeId: string;
}

export type ScopeTree = Map<string, ScopeNode>;

export interface ParseCacheEntry {
    tree: Parser.Tree;
    content: string;
    timestamp: number;
    usageIndex: Map<string, Range[]>;
    oldTree: Parser.Tree | null;
}

export interface ModuleMeta {
    imports: string[];
    registerRoots: string[];
}

export interface ReferenceLocation {
    uri: string;
    range: Range;
}

export interface DiagnosticSettings {
    duplicateDefinitions: boolean;
    duplicateDefinitionsMode: 'local' | 'global';
    undefinedFunctions: boolean;
    undefinedVariables: boolean;
    undefinedBindings: boolean;
    typeMismatchEnabled: boolean;
    typeMismatchMode: 'runtime' | 'strict';
}

export interface HoverSettings {
    userDefinitionComments: boolean;
}

export interface AnalyzerLike {
    connection: Connection;
    parser: Parser;
    globalIndex: Map<string, SymbolEntry[]>;
    parseCache: Map<string, ParseCacheEntry>;
    symbolQuery: Parser.Query | null;
    detectSymbolKind(
        nameNode: Parser.SyntaxNode,
        opNode: Parser.SyntaxNode | null,
        context: string
    ): SymbolKind;
    getVisibleEntries(symbolName: string, sourceUri: string): SymbolEntry[];
    findAllReferences(
        symbolName: string,
        includeDeclaration?: boolean,
        sourceUri?: string | null,
        sourcePosition?: Position | null,
        documents?: TextDocuments<TextDocument> | null,
        workspaceFolders?: WorkspaceFolder[],
        token?: CancellationToken | null
    ): ReferenceLocation[];
    getOrParseFile(uri: string, content: string, oldContent?: string | null): ParseCacheEntry | null;
    getTreeForDocument(uri: string, content: string): Parser.Tree | null;
    indexFile(uri: string, content: string): boolean;
    scanWorkspace(folders: WorkspaceFolder[]): Promise<void>;
}
