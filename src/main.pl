:- ensure_loaded(metta).
:- use_module(library(error)).
:- catch(use_module(library(time)), _, true).

metta_browser_run(CodeIn, OptionsIn, ResultDict) :-
    normalize_code_input(CodeIn, CodeString),
    normalize_browser_options(OptionsIn, Options),
    get_time(StartTime),
    with_output_to(string(StdoutText),
                   execute_metta_browser(CodeString, Options, RunState)),
    get_time(EndTime),
    DurationMs is round((EndTime - StartTime) * 1000),
    finalize_run_state(RunState, StdoutText, DurationMs, ResultDict).

normalize_browser_options(OptionsIn, browser_options{silent:Silent, timeout_ms:TimeoutMs, imports:Imports}) :-
    option_value(OptionsIn, silent, false, Silent0),
    option_value(OptionsIn, timeout_ms, 5000, Timeout0),
    option_value(OptionsIn, imports, disabled, Imports0),
    must_be(boolean, Silent0),
    must_be(integer, Timeout0),
    ( Timeout0 >= 0
      -> true
      ; domain_error(not_less_than_zero, Timeout0) ),
    normalize_import_policy(Imports0, Imports),
    Silent = Silent0,
    TimeoutMs = Timeout0.

option_value(OptionsIn, _, Default, Default) :- var(OptionsIn), !.
option_value(OptionsIn, Key, Default, Value) :-
    is_dict(OptionsIn),
    !,
    ( get_dict(Key, OptionsIn, V)
      -> Value = V
      ; Value = Default ).
option_value(OptionsIn, Key, Default, Value) :-
    is_list(OptionsIn),
    !,
    ( memberchk(Key=V, OptionsIn)
      -> Value = V
      ; memberchk(Key-V, OptionsIn)
        -> Value = V
        ; Value = Default ).
option_value(OptionsIn, _, _, _) :-
    throw(error(type_error(dict_or_list, OptionsIn), context(metta_browser_run/3, 'Options must be a dict or a key-value list.'))).

normalize_import_policy(disabled, disabled) :- !.
normalize_import_policy("disabled", disabled) :- !.
normalize_import_policy(Policy, Policy).

execute_metta_browser(CodeString, Options, RunState) :-
    catch(( run_browser_goal(CodeString, Options, Results0),
            normalize_results(Results0, Results),
            RunState = run_state{ok:true,
                                 results:Results,
                                 stderr:[],
                                 error:null,
                                 timed_out:false,
                                 canceled:false}
          ),
          Exception,
          exception_run_state(Exception, RunState)).

run_browser_goal(CodeString, browser_options{silent:Silent, timeout_ms:TimeoutMs, imports:Imports}, Results) :-
    ensure_supported_import_policy(Imports),
    Goal = with_silent_mode(Silent, process_metta_string(CodeString, Results)),
    run_goal_with_timeout(TimeoutMs, Goal).

ensure_supported_import_policy(disabled) :- !.
ensure_supported_import_policy(Policy) :-
    atom_or_term_string(Policy, PolicyString),
    throw(error(browser_policy(invalid_import_policy(PolicyString)),
                context(metta_browser_run/3, 'Only imports=disabled is supported in browser runtime v1.'))).

run_goal_with_timeout(TimeoutMs, Goal) :-
    ( TimeoutMs > 0,
      current_predicate(call_with_time_limit/2)
      -> Seconds is TimeoutMs / 1000,
         call_with_time_limit(Seconds, Goal)
      ; call(Goal) ).

normalize_results([], []).
normalize_results([Result|Results], [Text|Texts]) :-
    ( catch(swrite(Result, Text), _, fail)
      -> true
      ; atom_or_term_string(Result, Text) ),
    normalize_results(Results, Texts).

exception_run_state(time_limit_exceeded,
                    run_state{ok:false,
                              results:[],
                              stderr:['Execution timed out.'],
                              error:error{type:'timeout',
                                          code:'time_limit_exceeded',
                                          message:'Execution timed out.'},
                              timed_out:true,
                              canceled:false}) :- !.
exception_run_state(error(browser_policy(Code), context(Context, Message)),
                    run_state{ok:false,
                              results:[],
                              stderr:[MessageString],
                              error:error{type:'browser_policy',
                                          code:CodeString,
                                          context:ContextString,
                                          message:MessageString},
                              timed_out:false,
                              canceled:false}) :-
    !,
    atom_or_term_string(Code, CodeString),
    atom_or_term_string(Context, ContextString),
    atom_or_term_string(Message, MessageString).
exception_run_state(error(unsupported_feature(Feature), context(Context, Message)),
                    run_state{ok:false,
                              results:[],
                              stderr:[MessageString],
                              error:error{type:'unsupported_feature',
                                          code:FeatureString,
                                          context:ContextString,
                                          message:MessageString},
                              timed_out:false,
                              canceled:false}) :-
    !,
    atom_or_term_string(Feature, FeatureString),
    atom_or_term_string(Context, ContextString),
    atom_or_term_string(Message, MessageString).
exception_run_state(error(syntax_error(Message), _),
                    run_state{ok:false,
                              results:[],
                              stderr:[MessageString],
                              error:error{type:'syntax_error',
                                          code:'syntax_error',
                                          message:MessageString},
                              timed_out:false,
                              canceled:false}) :-
    !,
    atom_or_term_string(Message, MessageString).
exception_run_state(error(Type, Context),
                    run_state{ok:false,
                              results:[],
                              stderr:[MessageString],
                              error:error{type:'runtime_error',
                                          code:TypeString,
                                          context:ContextString,
                                          message:MessageString},
                              timed_out:false,
                              canceled:false}) :-
    !,
    atom_or_term_string(Type, TypeString),
    atom_or_term_string(Context, ContextString),
    format(string(MessageString), '~w', [error(Type, Context)]).
exception_run_state(Exception,
                    run_state{ok:false,
                              results:[],
                              stderr:[MessageString],
                              error:error{type:'runtime_error',
                                          code:'exception',
                                          message:MessageString},
                              timed_out:false,
                              canceled:false}) :-
    atom_or_term_string(Exception, MessageString).

finalize_run_state(run_state{ok:Ok,
                             results:Results,
                             stderr:Stderr,
                             error:Error,
                             timed_out:TimedOut,
                             canceled:Canceled},
                   StdoutText,
                   DurationMs,
                   result{ok:Ok,
                          results:Results,
                          stdout:StdoutLines,
                          stderr:Stderr,
                          error:Error,
                          timed_out:TimedOut,
                          canceled:Canceled,
                          duration_ms:DurationMs}) :-
    split_output_lines(StdoutText, StdoutLines).

split_output_lines("", []) :- !.
split_output_lines(Text, Lines) :-
    split_string(Text, "\n", "\r", RawLines),
    exclude(is_empty_line, RawLines, Lines).

is_empty_line("").

atom_or_term_string(Value, String) :-
    ( string(Value)
      -> String = Value
      ; atom(Value)
        -> atom_string(Value, String)
        ; term_string(Value, String) ).

normalize_code_input(CodeString, CodeString) :-
    string(CodeString),
    !.
normalize_code_input(CodeAtom, CodeString) :-
    atom(CodeAtom),
    !,
    atom_string(CodeAtom, CodeString).
normalize_code_input(CodeIn, _) :-
    throw(error(type_error(text, CodeIn),
                context(metta_browser_run/3, 'Code must be a string or atom.'))).
