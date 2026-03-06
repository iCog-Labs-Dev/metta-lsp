# MeTTa Language Support

Full-featured Language Server Protocol (LSP) support for the [MeTTa](https://wiki.opencog.org/w/MeTTa) language in Visual Studio Code.

## Features

- Syntax Highlighting: Tree-sitter powered semantic coloring for keywords, functions, variables, strings, numbers, and operators
- Diagnostics: syntax errors, undefined names, arity/type mismatches, and overload ambiguity
- Go to Definition: jump to function/type definitions across the workspace
- Hover Info: view type signatures and symbol details on hover
- Auto-Completion: context-aware keyword and project symbol suggestions
- Find All References: locate usages with scope awareness
- Rename Symbol: safe workspace-wide renaming with conflict detection
- Document Symbols: Outline integration for `=`, `:`, `->`, and macro definitions
- Signature Help: parameter hints while typing function calls
- Formatting: full-document, range, and on-type formatting

## Installation

### From VSIX

1. Download the `.vsix` from [Releases](https://github.com/iCog-Labs-Dev/MeTTa-LSP/releases)
2. Open VS Code -> Extensions (`Ctrl+Shift+X`) -> `...` menu -> Install from VSIX...
3. Select the `.vsix` file

### From Marketplace

Search for **MeTTa Language Support** in the VS Code Extensions panel.

## Usage

Open any `.metta` file and the language server activates automatically.

## Development Notes

- Source code is strict TypeScript (`tsconfig.json`).
- Runtime artifacts are compiled JavaScript (`dist/` and `server/dist/`).
- The extension client launches the server runtime from `server/dist/server.js`.

## License

[MIT](LICENSE)
