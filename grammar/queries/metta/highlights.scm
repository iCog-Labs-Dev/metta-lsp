; --- Primitives ---
(number) @number
(string) @string
(variable) @variable
(comment) @comment

; Parentheses as punctuation
"(" @punctuation.bracket
")" @punctuation.bracket

; --- Definitions ---
; (= (func_name ...) body)
(list
  head: (atom (symbol) @operator (#eq? @operator "="))
  argument: (list head: (atom (symbol) @function.definition)))

; Parameters in definitions: (= (func $p1 $p2) body)
(list
  head: (atom (symbol) @operator (#eq? @operator "="))
  argument: (list 
    argument: (atom (variable) @parameter)))

; --- Type Declarations ---
; (: func_name type_expr)
(list
  head: (atom (symbol) @operator (#eq? @operator ":"))
  argument: (atom (symbol) @function.definition))

; Function calls (fallback for other lists)
(list
  head: (atom (symbol) @function.call))

; --- Special Symbols / Keywords ---
; <<GENERATED:keywords>>
((symbol) @keyword
  (#any-of? @keyword "if" "let" "let*" "match" "case" "collapse" "superpose"))
; <</GENERATED:keywords>>

; --- Builtins ---
; <<GENERATED:builtins>>
((symbol) @function.builtin
  (#any-of? @function.builtin "%" "(@kind atom)" "+" "-" "/" "<" "<=" "=" "==" "=alpha" ">" ">=" "@desc" "@doc" "@doc-formal" "@item" "@param" "@params" "@return" "@type" "BadArgType" "BadType" "ErrorType" "abs-math" "acos-math" "add-atom" "add-atoms" "add-reduct" "add-reducts" "and" "asin-math" "assertAlphaEqual" "assertAlphaEqualMsg" "assertAlphaEqualToResult" "assertAlphaEqualToResultMsg" "assertEqual" "assertEqualMsg" "assertEqualToResult" "assertEqualToResultMsg" "assertIncludes" "atan-math" "atom-subst" "bind!" "capture" "car-atom" "cdr-atom" "ceil-math" "chain" "change-state!" "collapse-bind" "cons-atom" "context-space" "cos-math" "decons-atom" "eval" "evalc" "filter-atom" "first-from-pair" "floor-math" "foldl-atom" "for-each-in-atom" "format-args" "function" "get-atoms" "get-doc" "get-doc-atom" "get-doc-function" "get-doc-params" "get-doc-single-atom" "get-metatype" "get-state" "get-type" "get-type-space" "git-module!" "help!" "help-param!" "help-space!" "id" "if-decons-expr" "if-equal" "if-error" "import!" "include" "index-atom" "intersection" "intersection-atom" "is-function" "isinf-math" "isnan-math" "log-math" "map-atom" "match-type-or" "match-types" "max-atom" "metta" "min-atom" "mod-space!" "module-space-no-deps" "new-space" "new-state" "noeval" "nop" "noreduce-eq" "not" "or" "pow-math" "pragma!" "print-mods!" "println!" "quote" "register-module!" "remove-atom" "return" "return-on-error" "round-math" "sealed" "sin-math" "size-atom" "sort-strings" "sqrt-math" "subtraction" "subtraction-atom" "superpose-bind" "switch" "switch-internal" "tan-math" "trace!" "trunc-math" "type-cast" "undefined-doc-function-type" "unify" "union" "union-atom" "unique" "unique-atom" "unquote" "xor"))
; <</GENERATED:builtins>>

; --- Constants ---
; <<GENERATED:constants>>
((symbol) @constant
  (#any-of? @constant "True" "False" "Nil" "empty" "Cons" "Error"))
; <</GENERATED:constants>>

; Operators
((symbol) @operator
  (#any-of? @operator "=" ":" "->" "==" "~=" "+" "-" "*" "/" ">" "<" ">=" "<="))

; Fallback for other symbols
(symbol) @symbol
