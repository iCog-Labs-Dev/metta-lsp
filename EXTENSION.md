# MeTTa Language Support

Full-featured Language Server Protocol (LSP) support for the [MeTTa](https://wiki.opencog.org/w/MeTTa) language in Visual Studio Code.

## Features

- Tree-sitter-based semantic highlighting with built-in/unresolved modifiers.
- Arrow type-role coloring: parameter type terms use `type`; final return type term uses `type.returnType`.
- Real-time diagnostics for syntax, scope, binding/space usage, arity, and type contracts.
- Import-aware symbol visibility for navigation and completions (`import!` / `register-module!` aware).
- Auto-import completions for symbols/types/spaces defined in other files.
- Top-level evaluated `bind!` symbols are indexed and visible across imported files.
- Go to Definition, Hover, References, Rename, Signature Help, and Document Symbols.
- Formatting support: full document, range, and on-type.
- Quick-fix code actions for unresolved symbols/types/spaces that insert `import!` directives.

## Diagnostics Coverage

- Syntax errors and missing nodes.
- Duplicate top-level definitions (same name + arity).
- Undefined function calls in evaluated contexts.
- Argument count mismatch for calls.
- Type mismatch for calls when typed overloads are available.
- Typed definition contract checks:
  - declared parameter count vs definition arity mismatch,
  - declared return type vs inferred final body type mismatch.
- Undefined types in `(: ...)` type expressions.
- Unbound atom-space symbols (for example `&space`) unless bound/imported; `&self` is always valid.
- Ambiguous `!name` symbol warning.
- Variable edge-case warnings (`#` in variable names, suspicious `;` inside variable tokens).
- Ambiguous overload/reference warnings.

## Settings

Diagnostics settings (defaults from extension settings schema):

- `metta.diagnostics.duplicateDefinitions` (default: `false`)
- `metta.diagnostics.duplicateDefinitionsMode` (default: `local`)
- `metta.diagnostics.undefinedTypes` (default: `true`)
- `metta.diagnostics.typeMismatchEnabled` (default: `true`)
- `metta.diagnostics.argumentCountMismatchEnabled` (default: `true`)

Hover settings:

- `metta.hover.userDefinitionComments` (default: `true`)

## Installation

### From VSIX

1. Download the `.vsix` from [Releases](https://github.com/iCog-Labs-Dev/MeTTa-LSP/releases)
2. Open VS Code -> Extensions (`Ctrl+Shift+X`) -> `...` menu -> Install from VSIX...
3. Select the `.vsix` file

### From Marketplace

Search for **MeTTa Language Support** in the VS Code Extensions panel.

## Usage

Open any `.metta` file and the language server activates automatically.

## License

[MIT](LICENSE)
