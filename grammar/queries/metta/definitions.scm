; Simplified definitions for symbols and operators
; We use positional patterns and filter by text in analyzer.js

; (op (symbol) (list (symbol))) e.g. (= (func ...) ...) or (: func (-> ...))
(list
  (atom (symbol) @op)
  (list (atom (symbol) @name)))

; (op (symbol) (symbol)) e.g. (: func Type) or (= func result)
(list
  (atom (symbol) @op)
  (atom (symbol) @name))

; Function definitions starting with arrow (->)
(list
  (atom (symbol) @op (#eq? @op "->"))
  (list (atom (symbol) @name)))

(list
  (atom (symbol) @op (#eq? @op "->"))
  (atom (symbol) @name))

; Macro definitions
(list
  (atom (symbol) @op (#any-of? @op "macro" "defmacro"))
  (list (atom (symbol) @name)))
