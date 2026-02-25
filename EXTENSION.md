# MeTTa Language Support

Full-featured Language Server Protocol (LSP) support for the [MeTTa](https://wiki.opencog.org/w/MeTTa) language in Visual Studio Code.

## Features

- **Syntax Highlighting** — Tree-sitter powered semantic coloring for keywords, functions, variables, strings, numbers, and operators
- **Diagnostics** — Real-time checks for syntax errors, undefined names, arity/type mismatches, and overload ambiguity
- **Go to Definition** — Jump to any function or type definition across the workspace
- **Hover Info** — View type signatures and definitions by hovering over symbols
- **Auto-Completion** — Context-aware suggestions for keywords and project symbols
- **Find All References** — Locate every usage of a symbol across the project with scope awareness
- **Rename Symbol** — Safe workspace-wide renaming with conflict detection
- **Document Symbols** — Navigate files via the Outline view (supports `=`, `:`, `->`, and macro definitions)
- **Signature Help** — Parameter hints when calling functions
- **Formatting** — Full document, range, and on-type formatting for MeTTa code

## Installation

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/iCog-Labs-Dev/MeTTa-LSP/releases)
2. Open VS Code → Extensions (`Ctrl+Shift+X`) → `⋯` menu → **Install from VSIX...**
3. Select the `.vsix` file — done!

### From Marketplace

Search for **MeTTa Language Support** in the VS Code Extensions panel.

## Diagnostics

The language server reports:

- Syntax and parse errors
- Undefined function calls
- Undefined variables in scoped blocks (`=`, `let`, `let*`)
- Undefined binding symbols for plain symbols not introduced by `bind!`
- Argument count mismatch for function calls
- Type mismatch for typed calls (`:` signatures and built-ins)
- Ambiguous overload references

## Usage

Open any `.metta` file and the language server activates automatically. All features work out of the box with no configuration required.

## License

[MIT](LICENSE)
