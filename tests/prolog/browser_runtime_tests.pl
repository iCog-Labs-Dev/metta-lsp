:- begin_tests(browser_runtime).

:- prolog_load_context(directory, Here),
   directory_file_path(Here, '../../src/main.pl', MainPath),
   ensure_loaded(MainPath).

default_options(_{silent:true, timeout_ms:1000, imports:disabled}).

test(success_envelope) :-
    default_options(Options),
    metta_browser_run("!(+ 1 2)", Options, Result),
    assertion(Result.ok == true),
    assertion(Result.timed_out == false),
    assertion(Result.error == null),
    assertion(Result.results == ["3"]).

test(syntax_error_envelope) :-
    default_options(Options),
    metta_browser_run("!(+ 1 2", Options, Result),
    assertion(Result.ok == false),
    assertion(Result.timed_out == false),
    assertion(Result.error.type == syntax_error).

test(deterministic_runs_same_result) :-
    default_options(Options),
    metta_browser_run("!(+ 5 6)", Options, R1),
    metta_browser_run("!(+ 5 6)", Options, R2),
    assertion(R1.ok == true),
    assertion(R2.ok == true),
    assertion(R1.results == R2.results).

test(imports_disabled_policy) :-
    default_options(Options),
    metta_browser_run("!(import! &self \"foo\")", Options, Result),
    assertion(Result.ok == false),
    assertion(Result.error.type == browser_policy),
    assertion(Result.error.code == "imports_disabled").

test(unsupported_py_call) :-
    default_options(Options),
    metta_browser_run("!(py-call (list \"math.sqrt\" 9))", Options, Result),
    assertion(Result.ok == false),
    assertion(Result.error.type == unsupported_feature),
    assertion(Result.error.code == "py_call").

test(timeout_envelope) :-
    Options = _{silent:true, timeout_ms:50, imports:disabled},
    Code = "(= (loop) (loop))\n!(loop)",
    metta_browser_run(Code, Options, Result),
    assertion(Result.ok == false),
    assertion(Result.timed_out == true),
    assertion(Result.error.type == timeout).

:- end_tests(browser_runtime).
