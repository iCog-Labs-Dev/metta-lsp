# MeTTa Language Support (VS Code Extension)

Full-featured Language Server Protocol (LSP) support for the [MeTTa](https://wiki.opencog.org/w/MeTTa) language in Visual Studio Code.

## Features

- **Syntax Highlighting** — Tree-sitter powered semantic coloring for keywords, functions, variables, strings, numbers, and operators
- **Diagnostics** — Real-time syntax error reporting, duplicate top-level definition warnings, and undefined function detection
- **Go to Definition** — Jump to any function or type definition across the workspace
- **Rich Hover Documentation** — Highly detailed hover info including type signatures, descriptions, parameters, and return types
- **Auto-Completion** — Context-aware suggestions for keywords and project symbols
- **Find All References** — Locate every usage of a symbol across the project with scope awareness
- **Rename Symbol** — Safe workspace-wide renaming with conflict detection
- **Document Symbols** — Navigate files via the Outline view (supports `=`, `:`, `->`, and macro definitions)
- **Signature Help** — Parameter hints when calling functions
- **Formatting** — Full document, range, and on-type formatting for MeTTa code

## Prerequisites

- **Node.js** v20+
- **C++ Build Tools** — required for compiling the Tree-sitter native grammar (e.g., Visual Studio Build Tools on Windows)

## Getting Started

```powershell
git clone https://github.com/iCog-Labs-Dev/MeTTa-LSP.git
cd MeTTa-LSP
npm install
```

This repository is configured so a single root `npm install` also installs dependencies for `server/` and `grammar/` automatically (via root `postinstall`).

Press **F5** in VS Code to launch the Extension Development Host.

## Build & Package

```powershell
npm run build        # bundle client + server
npm run package      # build + create .vsix
npm run watch        # rebuild on file changes
```

The `.vsix` file will appear in the project root (e.g., `vscode-metta-1.1.0.vsix`).

## Project Structure

```
├── client/                    # VS Code extension client (LSP client)
│   └── src/
│       └── extension.js       # Client entry point
├── server/                    # Language Server (LSP server)
│   └── src/
│       ├── server.js          # Server entry point & request routing
│       ├── analyzer.js        # Core analysis engine (parsing, indexing, scopes)
│       ├── utils.js           # URI handling and shared utilities
│       └── features/          # LSP feature handlers
│           ├── completion.js      # Auto-completion
│           ├── definition.js      # Go to Definition
│           ├── diagnostics.js     # Syntax errors & duplicate detection
│           ├── formatting.js      # Document/range/on-type formatting
│           ├── hover.js           # Hover information
│           ├── references.js      # Find All References
│           ├── rename.js          # Rename Symbol
│           ├── semantics.js       # Semantic token highlighting
│           ├── signature.js       # Signature Help
│           └── symbols.js        # Document Symbols
├── grammar/                   # Tree-sitter MeTTa grammar
│   ├── grammar.js             # Grammar definition
│   ├── scripts/               # Codegen scripts
│   │   └── generate-highlights.js # Maps keywords.json to highlights.scm
│   ├── src/                   # Generated parser (parser.c, grammar.json)
│   ├── queries/metta/         # Tree-sitter query files
│   │   ├── definitions.scm        # Symbol definition patterns
│   │   ├── highlights.scm         # Syntax highlighting captures
│   │   ├── scopes.scm             # Scope detection (let, let*, match)
│   │   ├── locals.scm             # Local symbol usage tracking
│   │   ├── folds.scm              # Code folding ranges
│   │   ├── indents.scm            # Indentation rules
│   │   └── injections.scm         # Language injections
│   └── bindings/node/         # Node.js native binding
└── dist/                      # Bundled output (generated)
```

## Architecture

### Analyzer (`analyzer.js`)

The core engine that provides:

- **Tree-sitter parsing** with cached incremental re-parsing
- **Global symbol index** built from `.scm` query files
- **Scope tree construction** for shadowing and local variable detection
- **Workspace scanning** to index all `.metta` files on startup

All Tree-sitter queries are loaded from external `.scm` files in `grammar/queries/metta/`.

### Feature Modules (`features/`)

Each LSP capability is isolated in its own module under `server/src/features/`. Feature modules receive the `analyzer` instance and `documents` manager, keeping request handling decoupled from the analysis engine.

### Client (`client/`)

Thin LSP client that bootstraps the language server and forwards capabilities to VS Code.

## Maintenance

### Keyword Management

Keywords, constants, and built-ins are managed in a single source of truth: `server/src/keywords.json`.
The file uses a structured corelib schema:

- `schemaVersion`
- `builtins`: full corelib entries (summary, signatures, params, examples, and permanent `source` links)
- `classification.keywords`: symbols highlighted as keywords
- `classification.constants`: symbols highlighted as constants

Corelib documentation links come from:
`https://trueagi-io.github.io/hyperon-experimental/generated/corelib`

To add a new keyword:
1. Add the symbol to `classification.keywords` in `server/src/keywords.json`.
2. Sync the Tree-sitter highlighter by running:
   ```powershell
   npm run grammar:generate-highlights
   ```

This ensures that the Language Server (for completions) and Tree-sitter (for syntax highlighting) stay perfectly in sync.
Keyword highlighting is intentionally scoped to the language keyword set, independent from the full builtin list.

## License

[MIT](LICENSE)
