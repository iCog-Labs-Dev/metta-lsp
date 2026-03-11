# MeTTa Language Support (VS Code Extension)

Full-featured Language Server Protocol (LSP) support for the [MeTTa](https://wiki.opencog.org/w/MeTTa) language in Visual Studio Code.

The extension client and language server source are implemented in strict TypeScript and compiled to JavaScript for runtime.

## Features

- Syntax Highlighting: Tree-sitter powered semantic coloring for keywords, functions, variables, strings, numbers, and operators
- Diagnostics: real-time checks for syntax, scope, arity, type mismatches, and overload ambiguity
- Go to Definition: jump to function/type definitions across the workspace
- Hover Documentation: rich hover info with signatures, descriptions, parameters, and return types
- Auto-Completion: context-aware suggestions for keywords and project symbols
- Find All References: locate symbol usage across the project with scope awareness
- Rename Symbol: safe workspace-wide renaming with conflict detection
- Document Symbols: Outline integration for `=`, `:`, `->`, and macro definitions
- Signature Help: parameter hints while calling functions
- Formatting: full-document, range, and on-type formatting

## Prerequisites

- Node.js v20+
- C++ Build Tools for compiling the Tree-sitter native grammar (for example Visual Studio Build Tools on Windows)

## Getting Started

```powershell
git clone https://github.com/iCog-Labs-Dev/MeTTa-LSP.git
cd MeTTa-LSP
npm install
```

The root `postinstall` installs dependencies for `server/` and `grammar/` as well.

Press `F5` in VS Code to launch the Extension Development Host.

## Build and Package

```powershell
npm run typecheck    # strict TypeScript validation (tsc --noEmit)
npm run build        # typecheck + build server + build client
npm run build:server # compile server/src/**/*.ts -> server/dist/**/*.js
npm run build:client # bundle client/src/extension.ts -> dist/extension.js
npm run watch        # rebuild client bundle on file changes
npm run package      # build + create .vsix
```

The packaged `.vsix` file is created in the project root.

## Create a VSIX

Use the project packaging script:

```powershell
npm install
npm run package
```

The `package` script uses `vsce package --readme-path EXTENSION.md`, so repository `README.md` is never renamed or overwritten during packaging.

Output:

- A file like `vscode-metta-<version>.vsix` is generated in the repository root.

Optional direct command (without the repo wrapper script):

```powershell
npx @vscode/vsce package --readme-path EXTENSION.md
```

## Project Structure

```text
client/
  src/
    extension.ts                 # VS Code extension client entry point
server/
  src/
    server.ts                    # LSP server entry point and request routing
    analyzer.ts                  # Core analysis engine (parsing, indexing, scopes)
    utils.ts                     # URI handling and shared utility helpers
    types.ts                     # Shared TypeScript interfaces/types
    features/
      completion.ts
      definition.ts
      diagnostics.ts
      formatting.ts
      hover.ts
      references.ts
      rename.ts
      semantics.ts
      signature.ts
      symbols.ts
  dist/                          # Compiled server runtime JS output
grammar/                         # Tree-sitter MeTTa grammar and queries
scripts/
  build-server.mjs               # Compiles TS server source to server/dist
dist/                            # Bundled extension client output
tsconfig.json                    # Strict TypeScript compiler configuration
```

## Architecture

### Analyzer (`server/src/analyzer.ts`)

Provides:

- Tree-sitter parsing with cache-backed re-parsing
- Global symbol index from `.scm` query files
- Scope tree construction for shadowing and local variable analysis
- Workspace scanning for `.metta` files

All Tree-sitter queries are loaded from `grammar/queries/metta/`.

### Feature Modules (`server/src/features/`)

Each LSP capability is implemented in an isolated module. Handlers receive the analyzer and documents manager to keep analysis and transport concerns decoupled.

### Client (`client/src/extension.ts`)

Thin LSP client that boots the server and forwards capabilities to VS Code. It launches the compiled server runtime at `server/dist/server.js`.

## Diagnostics Coverage

Current diagnostics include:

- Syntax errors and missing nodes
- Duplicate top-level definitions (same name and arity)
- Undefined function calls
- Undefined types inside `(: ...)` declarations (optional)
- Undefined scoped variables in `=`, `let`, and `let*` (including destructured binders like `($h $t)`)
- Undefined binding symbols (symbols not built-in, user-defined, or introduced by `bind!`)
- Argument count mismatch for calls
- Type mismatch for calls when `:` signatures or built-in signatures are available
- Ambiguous reference warnings when multiple overloads match

### Diagnostics Configuration

The following VS Code settings control diagnostics behavior:

- `metta.diagnostics.duplicateDefinitions`
- `metta.diagnostics.duplicateDefinitionsMode`
- `metta.diagnostics.undefinedFunctions`
- `metta.diagnostics.undefinedTypes`
- `metta.diagnostics.undefinedVariables`
- `metta.diagnostics.undefinedBindings`
- `metta.diagnostics.typeMismatchEnabled`
- `metta.diagnostics.typeMismatchMode`

`metta.diagnostics.typeMismatchMode` values:

- `runtime` (default): runtime-aligned matching; only report mismatches when incompatibility is provable.
- `strict`: stronger static matching; can report more potential type issues.

`metta.diagnostics.duplicateDefinitionsMode` values:

- `local` (default): report duplicates only within the current file.
- `global`: include duplicates from the current file and its imported files.

Hover behavior setting:

- `metta.hover.userDefinitionComments`: include comments above user-defined functions in hover descriptions.

## Stdlib Metadata

Built-in symbols and documentation are loaded from the root `metta-stdlib.json` file:

- `schemaVersion`
- `builtins` with summary/signatures/params/examples/source links

Corelib documentation links are sourced from:
`https://trueagi-io.github.io/hyperon-experimental/generated/corelib`

To update built-in symbol metadata:

1. Edit the relevant symbol in `metta-stdlib.json`.
2. Regenerate Tree-sitter highlights:

```powershell
npm run grammar:generate-highlights
```

This keeps LSP completions and Tree-sitter highlighting in sync.

## License

[MIT](LICENSE)
