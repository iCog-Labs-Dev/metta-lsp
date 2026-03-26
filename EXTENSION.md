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

## Semantic Color Legend

The extension uses colors to help you quickly spot what each word means.

| Color | What it usually means |
|---|---|
| <span style="color:#A855F7;font-size:1.2em">■</span> Purple | Built-in macros and special command-like words |
| <span style="color:#2563EB;font-size:1.2em">■</span> Blue | Type names |
| <span style="color:#16A34A;font-size:1.2em">■</span> Green | Built-in type names |
| <span style="color:#F97316;font-size:1.2em">■</span> Orange | Return type (the output side of `->`) |
| <span style="color:#EAB308;font-size:1.2em">■</span> Yellow | Built-in return type |
| <span style="color:#06B6D4;font-size:1.2em">■</span> Cyan | Built-in constants like `True` / `False` |
| <span style="color:#A16207;font-size:1.2em">■</span> Brown | Bound names (for example names created with `bind!`) |
| <span style="color:#DC2626;font-size:1.2em">■</span> Red | Unknown variable (not found) |
| <span style="color:#DB2777;font-size:1.2em">■</span> Pink | Unknown function (not found) |
| <span style="color:#22D3EE;font-size:1.2em">■</span> Bright cyan | Unknown bound/property name (not found) |

If a color looks different, your VS Code theme may be overriding it.

## What You Can Change

You can change both behavior and colors in VS Code Settings.

Easy behavior controls:

- Duplicate definition warnings: turn on/off.
- Duplicate check range: only this file, or also imported files.
- Unknown type warnings: turn on/off.
- Type mismatch warnings: turn on/off.
- Wrong number of arguments warnings: turn on/off.
- Hover comments: show/hide comments above your own function definitions.

Color controls:

- Keep semantic colors enabled.
- Replace any default MeTTa color with your own favorite color.

If you like editing `settings.json`, use this example:

```json
{
  "metta.diagnostics.duplicateDefinitions": true,
  "metta.diagnostics.duplicateDefinitionsMode": "global",
  "metta.hover.userDefinitionComments": false,
  "editor.semanticTokenColorCustomizations": {
    "enabled": true,
    "rules": {
      "macro:metta": "#FF4D4F",
      "type:metta": "#1D4ED8",
      "type.returnType:metta": "#EA580C",
      "function.undefined:metta": "#BE123C"
    }
  }
}
```

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
