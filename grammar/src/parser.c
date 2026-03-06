#include "tree_sitter/parser.h"

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#define LANGUAGE_VERSION 14
#define STATE_COUNT 14
#define LARGE_STATE_COUNT 12
#define SYMBOL_COUNT 14
#define ALIAS_COUNT 0
#define TOKEN_COUNT 8
#define EXTERNAL_TOKEN_COUNT 0
#define FIELD_COUNT 4
#define MAX_ALIAS_SEQUENCE_LENGTH 4
#define PRODUCTION_ID_COUNT 5

enum ts_symbol_identifiers {
  anon_sym_LPAREN = 1,
  anon_sym_RPAREN = 2,
  sym_variable = 3,
  sym_number = 4,
  sym_string = 5,
  sym_symbol = 6,
  sym_comment = 7,
  sym_source_file = 8,
  sym__expr = 9,
  sym_list = 10,
  sym_atom = 11,
  aux_sym_source_file_repeat1 = 12,
  aux_sym_list_repeat1 = 13,
};

static const char * const ts_symbol_names[] = {
  [ts_builtin_sym_end] = "end",
  [anon_sym_LPAREN] = "(",
  [anon_sym_RPAREN] = ")",
  [sym_variable] = "variable",
  [sym_number] = "number",
  [sym_string] = "string",
  [sym_symbol] = "symbol",
  [sym_comment] = "comment",
  [sym_source_file] = "source_file",
  [sym__expr] = "_expr",
  [sym_list] = "list",
  [sym_atom] = "atom",
  [aux_sym_source_file_repeat1] = "source_file_repeat1",
  [aux_sym_list_repeat1] = "list_repeat1",
};

static const TSSymbol ts_symbol_map[] = {
  [ts_builtin_sym_end] = ts_builtin_sym_end,
  [anon_sym_LPAREN] = anon_sym_LPAREN,
  [anon_sym_RPAREN] = anon_sym_RPAREN,
  [sym_variable] = sym_variable,
  [sym_number] = sym_number,
  [sym_string] = sym_string,
  [sym_symbol] = sym_symbol,
  [sym_comment] = sym_comment,
  [sym_source_file] = sym_source_file,
  [sym__expr] = sym__expr,
  [sym_list] = sym_list,
  [sym_atom] = sym_atom,
  [aux_sym_source_file_repeat1] = aux_sym_source_file_repeat1,
  [aux_sym_list_repeat1] = aux_sym_list_repeat1,
};

static const TSSymbolMetadata ts_symbol_metadata[] = {
  [ts_builtin_sym_end] = {
    .visible = false,
    .named = true,
  },
  [anon_sym_LPAREN] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RPAREN] = {
    .visible = true,
    .named = false,
  },
  [sym_variable] = {
    .visible = true,
    .named = true,
  },
  [sym_number] = {
    .visible = true,
    .named = true,
  },
  [sym_string] = {
    .visible = true,
    .named = true,
  },
  [sym_symbol] = {
    .visible = true,
    .named = true,
  },
  [sym_comment] = {
    .visible = true,
    .named = true,
  },
  [sym_source_file] = {
    .visible = true,
    .named = true,
  },
  [sym__expr] = {
    .visible = false,
    .named = true,
  },
  [sym_list] = {
    .visible = true,
    .named = true,
  },
  [sym_atom] = {
    .visible = true,
    .named = true,
  },
  [aux_sym_source_file_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_list_repeat1] = {
    .visible = false,
    .named = false,
  },
};

enum ts_field_identifiers {
  field_argument = 1,
  field_close = 2,
  field_head = 3,
  field_open = 4,
};

static const char * const ts_field_names[] = {
  [0] = NULL,
  [field_argument] = "argument",
  [field_close] = "close",
  [field_head] = "head",
  [field_open] = "open",
};

static const TSFieldMapSlice ts_field_map_slices[PRODUCTION_ID_COUNT] = {
  [1] = {.index = 0, .length = 3},
  [2] = {.index = 3, .length = 1},
  [3] = {.index = 4, .length = 4},
  [4] = {.index = 8, .length = 2},
};

static const TSFieldMapEntry ts_field_map_entries[] = {
  [0] =
    {field_close, 2},
    {field_head, 1},
    {field_open, 0},
  [3] =
    {field_argument, 0},
  [4] =
    {field_argument, 2, .inherited = true},
    {field_close, 3},
    {field_head, 1},
    {field_open, 0},
  [8] =
    {field_argument, 0, .inherited = true},
    {field_argument, 1, .inherited = true},
};

static const TSSymbol ts_alias_sequences[PRODUCTION_ID_COUNT][MAX_ALIAS_SEQUENCE_LENGTH] = {
  [0] = {0},
};

static const uint16_t ts_non_terminal_alias_map[] = {
  0,
};

static const TSStateId ts_primary_state_ids[STATE_COUNT] = {
  [0] = 0,
  [1] = 1,
  [2] = 2,
  [3] = 3,
  [4] = 4,
  [5] = 5,
  [6] = 6,
  [7] = 7,
  [8] = 8,
  [9] = 9,
  [10] = 10,
  [11] = 11,
  [12] = 12,
  [13] = 13,
};

static bool ts_lex(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      if (eof) ADVANCE(5);
      if (lookahead == '"') ADVANCE(1);
      if (lookahead == '$') ADVANCE(3);
      if (lookahead == '(') ADVANCE(6);
      if (lookahead == ')') ADVANCE(7);
      if (lookahead == '-') ADVANCE(12);
      if (lookahead == '.') ADVANCE(2);
      if (lookahead == ';') ADVANCE(15);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(0);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(9);
      if (lookahead != 0) ADVANCE(14);
      END_STATE();
    case 1:
      if (lookahead == '"') ADVANCE(11);
      if (lookahead == '\\') ADVANCE(4);
      if (lookahead != 0 &&
          lookahead != '\n' &&
          lookahead != '\r') ADVANCE(1);
      END_STATE();
    case 2:
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(10);
      END_STATE();
    case 3:
      if (lookahead != 0 &&
          (lookahead < '\t' || '\r' < lookahead) &&
          lookahead != ' ' &&
          lookahead != '"' &&
          lookahead != '(' &&
          lookahead != ')' &&
          lookahead != ';') ADVANCE(8);
      END_STATE();
    case 4:
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(1);
      END_STATE();
    case 5:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      END_STATE();
    case 6:
      ACCEPT_TOKEN(anon_sym_LPAREN);
      END_STATE();
    case 7:
      ACCEPT_TOKEN(anon_sym_RPAREN);
      END_STATE();
    case 8:
      ACCEPT_TOKEN(sym_variable);
      if (lookahead != 0 &&
          (lookahead < '\t' || '\r' < lookahead) &&
          lookahead != ' ' &&
          lookahead != '"' &&
          lookahead != '(' &&
          lookahead != ')' &&
          lookahead != ';') ADVANCE(8);
      END_STATE();
    case 9:
      ACCEPT_TOKEN(sym_number);
      if (lookahead == '.') ADVANCE(10);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(9);
      END_STATE();
    case 10:
      ACCEPT_TOKEN(sym_number);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(10);
      END_STATE();
    case 11:
      ACCEPT_TOKEN(sym_string);
      END_STATE();
    case 12:
      ACCEPT_TOKEN(sym_symbol);
      if (lookahead == '.') ADVANCE(13);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(9);
      if (lookahead != 0 &&
          (lookahead < '\t' || '\r' < lookahead) &&
          lookahead != ' ' &&
          lookahead != '"' &&
          lookahead != '(' &&
          lookahead != ')' &&
          lookahead != ';') ADVANCE(14);
      END_STATE();
    case 13:
      ACCEPT_TOKEN(sym_symbol);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(10);
      if (lookahead != 0 &&
          (lookahead < '\t' || '\r' < lookahead) &&
          lookahead != ' ' &&
          lookahead != '"' &&
          lookahead != '(' &&
          lookahead != ')' &&
          lookahead != ';') ADVANCE(14);
      END_STATE();
    case 14:
      ACCEPT_TOKEN(sym_symbol);
      if (lookahead != 0 &&
          (lookahead < '\t' || '\r' < lookahead) &&
          lookahead != ' ' &&
          lookahead != '"' &&
          lookahead != '(' &&
          lookahead != ')' &&
          lookahead != ';') ADVANCE(14);
      END_STATE();
    case 15:
      ACCEPT_TOKEN(sym_comment);
      if (lookahead != 0 &&
          lookahead != '\n' &&
          lookahead != '\r') ADVANCE(15);
      END_STATE();
    default:
      return false;
  }
}

static const TSLexMode ts_lex_modes[STATE_COUNT] = {
  [0] = {.lex_state = 0},
  [1] = {.lex_state = 0},
  [2] = {.lex_state = 0},
  [3] = {.lex_state = 0},
  [4] = {.lex_state = 0},
  [5] = {.lex_state = 0},
  [6] = {.lex_state = 0},
  [7] = {.lex_state = 0},
  [8] = {.lex_state = 0},
  [9] = {.lex_state = 0},
  [10] = {.lex_state = 0},
  [11] = {.lex_state = 0},
  [12] = {.lex_state = 0},
  [13] = {.lex_state = 0},
};

static const uint16_t ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT] = {
  [0] = {
    [ts_builtin_sym_end] = ACTIONS(1),
    [anon_sym_LPAREN] = ACTIONS(1),
    [anon_sym_RPAREN] = ACTIONS(1),
    [sym_variable] = ACTIONS(1),
    [sym_number] = ACTIONS(1),
    [sym_string] = ACTIONS(1),
    [sym_symbol] = ACTIONS(1),
    [sym_comment] = ACTIONS(3),
  },
  [1] = {
    [sym_source_file] = STATE(13),
    [sym__expr] = STATE(2),
    [sym_list] = STATE(2),
    [sym_atom] = STATE(2),
    [aux_sym_source_file_repeat1] = STATE(2),
    [ts_builtin_sym_end] = ACTIONS(5),
    [anon_sym_LPAREN] = ACTIONS(7),
    [sym_variable] = ACTIONS(9),
    [sym_number] = ACTIONS(9),
    [sym_string] = ACTIONS(9),
    [sym_symbol] = ACTIONS(11),
    [sym_comment] = ACTIONS(3),
  },
  [2] = {
    [sym__expr] = STATE(4),
    [sym_list] = STATE(4),
    [sym_atom] = STATE(4),
    [aux_sym_source_file_repeat1] = STATE(4),
    [ts_builtin_sym_end] = ACTIONS(13),
    [anon_sym_LPAREN] = ACTIONS(7),
    [sym_variable] = ACTIONS(9),
    [sym_number] = ACTIONS(9),
    [sym_string] = ACTIONS(9),
    [sym_symbol] = ACTIONS(11),
    [sym_comment] = ACTIONS(3),
  },
  [3] = {
    [sym__expr] = STATE(12),
    [sym_list] = STATE(12),
    [sym_atom] = STATE(12),
    [aux_sym_list_repeat1] = STATE(5),
    [anon_sym_LPAREN] = ACTIONS(7),
    [anon_sym_RPAREN] = ACTIONS(15),
    [sym_variable] = ACTIONS(9),
    [sym_number] = ACTIONS(9),
    [sym_string] = ACTIONS(9),
    [sym_symbol] = ACTIONS(11),
    [sym_comment] = ACTIONS(3),
  },
  [4] = {
    [sym__expr] = STATE(4),
    [sym_list] = STATE(4),
    [sym_atom] = STATE(4),
    [aux_sym_source_file_repeat1] = STATE(4),
    [ts_builtin_sym_end] = ACTIONS(17),
    [anon_sym_LPAREN] = ACTIONS(19),
    [sym_variable] = ACTIONS(22),
    [sym_number] = ACTIONS(22),
    [sym_string] = ACTIONS(22),
    [sym_symbol] = ACTIONS(25),
    [sym_comment] = ACTIONS(3),
  },
  [5] = {
    [sym__expr] = STATE(12),
    [sym_list] = STATE(12),
    [sym_atom] = STATE(12),
    [aux_sym_list_repeat1] = STATE(6),
    [anon_sym_LPAREN] = ACTIONS(7),
    [anon_sym_RPAREN] = ACTIONS(28),
    [sym_variable] = ACTIONS(9),
    [sym_number] = ACTIONS(9),
    [sym_string] = ACTIONS(9),
    [sym_symbol] = ACTIONS(11),
    [sym_comment] = ACTIONS(3),
  },
  [6] = {
    [sym__expr] = STATE(12),
    [sym_list] = STATE(12),
    [sym_atom] = STATE(12),
    [aux_sym_list_repeat1] = STATE(6),
    [anon_sym_LPAREN] = ACTIONS(30),
    [anon_sym_RPAREN] = ACTIONS(33),
    [sym_variable] = ACTIONS(35),
    [sym_number] = ACTIONS(35),
    [sym_string] = ACTIONS(35),
    [sym_symbol] = ACTIONS(38),
    [sym_comment] = ACTIONS(3),
  },
  [7] = {
    [sym__expr] = STATE(3),
    [sym_list] = STATE(3),
    [sym_atom] = STATE(3),
    [anon_sym_LPAREN] = ACTIONS(7),
    [anon_sym_RPAREN] = ACTIONS(41),
    [sym_variable] = ACTIONS(9),
    [sym_number] = ACTIONS(9),
    [sym_string] = ACTIONS(9),
    [sym_symbol] = ACTIONS(11),
    [sym_comment] = ACTIONS(3),
  },
  [8] = {
    [ts_builtin_sym_end] = ACTIONS(43),
    [anon_sym_LPAREN] = ACTIONS(43),
    [anon_sym_RPAREN] = ACTIONS(43),
    [sym_variable] = ACTIONS(43),
    [sym_number] = ACTIONS(43),
    [sym_string] = ACTIONS(43),
    [sym_symbol] = ACTIONS(45),
    [sym_comment] = ACTIONS(3),
  },
  [9] = {
    [ts_builtin_sym_end] = ACTIONS(47),
    [anon_sym_LPAREN] = ACTIONS(47),
    [anon_sym_RPAREN] = ACTIONS(47),
    [sym_variable] = ACTIONS(47),
    [sym_number] = ACTIONS(47),
    [sym_string] = ACTIONS(47),
    [sym_symbol] = ACTIONS(49),
    [sym_comment] = ACTIONS(3),
  },
  [10] = {
    [ts_builtin_sym_end] = ACTIONS(51),
    [anon_sym_LPAREN] = ACTIONS(51),
    [anon_sym_RPAREN] = ACTIONS(51),
    [sym_variable] = ACTIONS(51),
    [sym_number] = ACTIONS(51),
    [sym_string] = ACTIONS(51),
    [sym_symbol] = ACTIONS(53),
    [sym_comment] = ACTIONS(3),
  },
  [11] = {
    [ts_builtin_sym_end] = ACTIONS(55),
    [anon_sym_LPAREN] = ACTIONS(55),
    [anon_sym_RPAREN] = ACTIONS(55),
    [sym_variable] = ACTIONS(55),
    [sym_number] = ACTIONS(55),
    [sym_string] = ACTIONS(55),
    [sym_symbol] = ACTIONS(57),
    [sym_comment] = ACTIONS(3),
  },
};

static const uint16_t ts_small_parse_table[] = {
  [0] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(61), 1,
      sym_symbol,
    ACTIONS(59), 5,
      anon_sym_LPAREN,
      anon_sym_RPAREN,
      sym_variable,
      sym_number,
      sym_string,
  [14] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(63), 1,
      ts_builtin_sym_end,
};

static const uint32_t ts_small_parse_table_map[] = {
  [SMALL_STATE(12)] = 0,
  [SMALL_STATE(13)] = 14,
};

static const TSParseActionEntry ts_parse_actions[] = {
  [0] = {.entry = {.count = 0, .reusable = false}},
  [1] = {.entry = {.count = 1, .reusable = false}}, RECOVER(),
  [3] = {.entry = {.count = 1, .reusable = true}}, SHIFT_EXTRA(),
  [5] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 0, 0, 0),
  [7] = {.entry = {.count = 1, .reusable = true}}, SHIFT(7),
  [9] = {.entry = {.count = 1, .reusable = true}}, SHIFT(8),
  [11] = {.entry = {.count = 1, .reusable = false}}, SHIFT(8),
  [13] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 1, 0, 0),
  [15] = {.entry = {.count = 1, .reusable = true}}, SHIFT(10),
  [17] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0),
  [19] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(7),
  [22] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(8),
  [25] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(8),
  [28] = {.entry = {.count = 1, .reusable = true}}, SHIFT(11),
  [30] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_list_repeat1, 2, 0, 4), SHIFT_REPEAT(7),
  [33] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_list_repeat1, 2, 0, 4),
  [35] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_list_repeat1, 2, 0, 4), SHIFT_REPEAT(8),
  [38] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_list_repeat1, 2, 0, 4), SHIFT_REPEAT(8),
  [41] = {.entry = {.count = 1, .reusable = true}}, SHIFT(9),
  [43] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_atom, 1, 0, 0),
  [45] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_atom, 1, 0, 0),
  [47] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_list, 2, 0, 0),
  [49] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_list, 2, 0, 0),
  [51] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_list, 3, 0, 1),
  [53] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_list, 3, 0, 1),
  [55] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_list, 4, 0, 3),
  [57] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_list, 4, 0, 3),
  [59] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_list_repeat1, 1, 0, 2),
  [61] = {.entry = {.count = 1, .reusable = false}}, REDUCE(aux_sym_list_repeat1, 1, 0, 2),
  [63] = {.entry = {.count = 1, .reusable = true}},  ACCEPT_INPUT(),
};

#ifdef __cplusplus
extern "C" {
#endif
#ifdef TREE_SITTER_HIDE_SYMBOLS
#define TS_PUBLIC
#elif defined(_WIN32)
#define TS_PUBLIC __declspec(dllexport)
#else
#define TS_PUBLIC __attribute__((visibility("default")))
#endif

TS_PUBLIC const TSLanguage *tree_sitter_metta(void) {
  static const TSLanguage language = {
    .version = LANGUAGE_VERSION,
    .symbol_count = SYMBOL_COUNT,
    .alias_count = ALIAS_COUNT,
    .token_count = TOKEN_COUNT,
    .external_token_count = EXTERNAL_TOKEN_COUNT,
    .state_count = STATE_COUNT,
    .large_state_count = LARGE_STATE_COUNT,
    .production_id_count = PRODUCTION_ID_COUNT,
    .field_count = FIELD_COUNT,
    .max_alias_sequence_length = MAX_ALIAS_SEQUENCE_LENGTH,
    .parse_table = &ts_parse_table[0][0],
    .small_parse_table = ts_small_parse_table,
    .small_parse_table_map = ts_small_parse_table_map,
    .parse_actions = ts_parse_actions,
    .symbol_names = ts_symbol_names,
    .field_names = ts_field_names,
    .field_map_slices = ts_field_map_slices,
    .field_map_entries = ts_field_map_entries,
    .symbol_metadata = ts_symbol_metadata,
    .public_symbol_map = ts_symbol_map,
    .alias_map = ts_non_terminal_alias_map,
    .alias_sequences = &ts_alias_sequences[0][0],
    .lex_modes = ts_lex_modes,
    .lex_fn = ts_lex,
    .primary_state_ids = ts_primary_state_ids,
  };
  return &language;
}
#ifdef __cplusplus
}
#endif
