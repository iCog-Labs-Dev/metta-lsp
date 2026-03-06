; Indent after an opening paren, outdent at closing.
; This works in editors that support Tree-sitter indent queries.
(
  "(" @indent
  ")" @outdent
)
