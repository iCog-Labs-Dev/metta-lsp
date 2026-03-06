module.exports = grammar({
  name: 'metta',

  extras: $ => [
    $.comment,
    /\s/
  ],

  rules: {
    source_file: $ => repeat($._expr),

    _expr: $ => choice(
      $.list,
      $.atom
    ),

    list: $ => choice(
      seq("(", ")"),
      seq(
        field("open", "("),
        field("head", $._expr),
        repeat(field("argument", $._expr)),
        field("close", ")")
      )
    ),

    atom: $ => choice(
      $.variable,
      $.number,
      $.string,
      $.symbol
    ),

    variable: _ => /\$[^()\s";]+/,

    number: _ => token(prec(1, seq(
      optional('-'),
      choice(
        /\d+\.\d*/,
        /\.\d+/,
        /\d+/
      )
    ))),

    string: _ => token(seq(
      '"',
      repeat(choice(
        /[^"\\\n\r]/,
        /\\./
      )),
      '"'
    )),

    symbol: _ => token(prec(-1, /[^\d\.$()\s";][^()\s";]*/)),
    comment: _ => token(seq(';', /[^\n\r]*/))
  }
});
