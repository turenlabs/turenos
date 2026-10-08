use base64::Engine;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Expression as E, Statement as S};
use oxc_ast_visit::{Visit, walk};
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Write, ops::Range};
use wasm_bindgen::prelude::*;

const INPUT: usize = 1 << 20;
const OPTIONS: usize = 4096;
const CODE: usize = 2 << 20;
const VALUE: usize = 64 << 10;
const TRANSFORMS: usize = 256;
const PAYLOADS: usize = 128;
const PAYLOAD_TEXT: usize = 256 << 10;
const REPORT: usize = 4 << 20;
const DEPTH: usize = 64;

type Patch = (Range<usize>, String, &'static str);

#[derive(Serialize)]
struct Transformation {
    kind: &'static str,
    start: usize,
    end: usize,
}
#[derive(Serialize)]
struct Payload {
    kind: &'static str,
    start: usize,
    end: usize,
    code: String,
    sha256: String,
}
#[derive(Default)]
struct Options {
    extract: bool,
    builtins: bool,
    builtin_safe: bool,
}

#[wasm_bindgen]
pub fn deobfuscate(bytes: &[u8], options_json: &str) -> String {
    match run(bytes, options_json) {
        Ok(value) => encode(value),
        Err((code, message)) => encode(json!({"schema_version":1,"error":code,"message":message})),
    }
}

fn run(bytes: &[u8], option_text: &str) -> Result<Value, (&'static str, String)> {
    if bytes.len() > INPUT {
        return Err(("input_too_large", "Input exceeds 1 MiB.".into()));
    }
    if option_text.len() > OPTIONS {
        return Err(("options_too_large", "Options exceed 4 KiB.".into()));
    }
    let source =
        std::str::from_utf8(bytes).map_err(|_| ("invalid_utf8", "Input must be UTF-8.".into()))?;
    let mut options = parse_options(option_text)?;
    preflight(source).map_err(|m| ("depth_limit", m))?;

    let allocator = Allocator::default();
    let script = Parser::new(&allocator, source, SourceType::cjs()).parse();
    let (program, source_type) = if script.diagnostics.is_empty() {
        (script.program, SourceType::cjs())
    } else {
        let module = Parser::new(&allocator, source, SourceType::mjs()).parse();
        if !module.diagnostics.is_empty() {
            return Err(("parse_error", "Invalid JavaScript script or module.".into()));
        }
        (module.program, SourceType::mjs())
    };
    let mut guard = AstDepthGuard {
        depth: 0,
        exceeded: false,
    };
    guard.visit_program(&program);
    if guard.exceeded {
        return Err(("depth_limit", "JavaScript AST depth exceeds 64.".into()));
    }
    options.builtin_safe = options.builtins && safe_builtin_program(&program.body);

    let mut patches = Vec::new();
    let mut payloads = Vec::new();
    let mut warnings = Vec::new();
    for statement in &program.body {
        visit_statement(
            statement,
            source,
            &options,
            &mut patches,
            &mut payloads,
            &mut warnings,
            0,
        );
    }
    if options.builtins {
        warn(
            &mut warnings,
            "Standard builtin decoding is explicitly assumption-based.",
        );
    }
    if options.builtins && !options.builtin_safe {
        warn(
            &mut warnings,
            "Skipped intrinsic decoding because the program contains dynamic or unsupported effects.",
        );
    }
    let patches_capped = patches.len() > TRANSFORMS;
    patches.sort_by(|a: &Patch, b| {
        a.0.start
            .cmp(&b.0.start)
            .then_with(|| b.0.end.cmp(&a.0.end))
    });
    let mut selected = Vec::new();
    let mut covered = 0;
    for patch in patches {
        if patch.0.start < covered || patch.0.end > source.len() {
            continue;
        }
        if selected.len() == TRANSFORMS {
            warn(&mut warnings, "Transformation limit reached.");
            break;
        }
        covered = patch.0.end;
        selected.push(patch);
    }
    let mut code = source.to_owned();
    for (span, replacement, _) in selected.iter().rev() {
        code.replace_range(span.clone(), replacement);
    }
    let formatted = Parser::new(&allocator, &code, source_type).parse();
    if formatted.diagnostics.is_empty() {
        code = Codegen::new().build(&formatted.program).code;
    }
    if code.len() > CODE {
        return Err(("code_too_large", "Output code exceeds 2 MiB.".into()));
    }
    let transformations: Vec<_> = selected
        .iter()
        .map(|(r, _, kind)| Transformation {
            kind,
            start: r.start,
            end: r.end,
        })
        .collect();
    let truncated = selected.len() == TRANSFORMS
        || patches_capped
        || payloads.len() == PAYLOADS
        || payloads.iter().map(|p| p.code.len()).sum::<usize>() >= PAYLOAD_TEXT
        || warnings.iter().any(|w| w.contains("limit reached"));
    if truncated {
        warn(
            &mut warnings,
            "A report limit was reached; some static results may be omitted.",
        );
    }
    Ok(json!({
        "schema_version":1,"language":"js",
        "input":{"bytes":bytes.len(),"sha256":hex(&Sha256::digest(bytes))},
        "code":code,"transformations":transformations,"payloads":payloads,"warnings":warnings,
        "truncated":truncated
    }))
}

fn safe_builtin_program(body: &[S<'_>]) -> bool {
    // An earlier statement or unknown expression may mutate the assumed globals.
    if body.len() != 1 {
        return false;
    }
    match &body[0] {
        S::ExpressionStatement(s) => safe_builtin_root(&s.expression),
        S::VariableDeclaration(s) if s.declarations.len() == 1 => s.declarations.iter().all(|d| matches!(&d.id, oxc_ast::ast::BindingPattern::BindingIdentifier(id) if id.name != "atob" && id.name != "String") && d.init.as_ref().is_none_or(safe_builtin_root)),
        _ => false,
    }
}

fn safe_builtin_root(e: &E<'_>) -> bool {
    match e {
        E::ParenthesizedExpression(x) => safe_builtin_root(&x.expression),
        E::AssignmentExpression(x) => x.operator.as_str() == "=" && matches!(&x.left, oxc_ast::ast::AssignmentTarget::AssignmentTargetIdentifier(id) if id.name != "atob" && id.name != "String") && safe_builtin_root(&x.right),
        E::CallExpression(x) if matches!(&x.callee, E::Identifier(id) if id.name == "eval") => x.arguments.len() == 1 && x.arguments[0].as_expression().is_some_and(|arg| matches!(arg, E::CallExpression(inner) if is_intrinsic(&inner.callee) && inner.arguments.iter().all(|a| a.as_expression().is_some_and(safe_builtin_expr)))),
        _ => safe_builtin_expr(e),
    }
}

fn safe_builtin_expr(e: &E<'_>) -> bool {
    match e {
        E::StringLiteral(_) | E::NumericLiteral(_) | E::BooleanLiteral(_) | E::NullLiteral(_) => {
            true
        }
        E::ParenthesizedExpression(x) => safe_builtin_expr(&x.expression),
        E::UnaryExpression(x) => safe_builtin_expr(&x.argument),
        E::BinaryExpression(x) => safe_builtin_expr(&x.left) && safe_builtin_expr(&x.right),
        E::CallExpression(x) if is_intrinsic(&x.callee) => x
            .arguments
            .iter()
            .all(|a| a.as_expression().is_some_and(safe_builtin_expr)),
        _ => false,
    }
}

struct AstDepthGuard {
    depth: usize,
    exceeded: bool,
}
impl<'a> Visit<'a> for AstDepthGuard {
    fn visit_expression(&mut self, expression: &E<'a>) {
        if self.depth >= DEPTH {
            self.exceeded = true;
            return;
        }
        self.depth += 1;
        walk::walk_expression(self, expression);
        self.depth -= 1;
    }
    fn visit_statement(&mut self, statement: &S<'a>) {
        if self.depth >= DEPTH {
            self.exceeded = true;
            return;
        }
        self.depth += 1;
        walk::walk_statement(self, statement);
        self.depth -= 1;
    }
    fn visit_binding_pattern(&mut self, pattern: &oxc_ast::ast::BindingPattern<'a>) {
        if self.depth >= DEPTH {
            self.exceeded = true;
            return;
        }
        self.depth += 1;
        walk::walk_binding_pattern(self, pattern);
        self.depth -= 1;
    }
}

fn parse_options(text: &str) -> Result<Options, (&'static str, String)> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| ("invalid_options", "Options must be a JSON object.".into()))?;
    let object = value
        .as_object()
        .ok_or(("invalid_options", "Options must be a JSON object.".into()))?;
    let mut options = Options::default();
    for (key, value) in object {
        match key.as_str() {
            "language" if value.as_str() == Some("js") => (),
            "language" => {
                return Err((
                    "unsupported_language",
                    "Only JavaScript is supported.".into(),
                ));
            }
            "extractPayloads" => {
                options.extract = value
                    .as_bool()
                    .ok_or(("invalid_options", "extractPayloads must be boolean.".into()))?
            }
            "assumeStandardBuiltins" => {
                options.builtins = value.as_bool().ok_or((
                    "invalid_options",
                    "assumeStandardBuiltins must be boolean.".into(),
                ))?
            }
            _ => return Err(("unknown_option", format!("Unknown option: {key}"))),
        }
    }
    Ok(options)
}

// A quote/comment-aware structural guard also counts un-delimited conditional and exponent chains.
fn preflight(source: &str) -> Result<(), String> {
    let (mut depth, mut deep_ops) = (0usize, 0usize);
    let (mut quote, mut escaped, mut line, mut block) = (None, false, false, false);
    let (mut regex, mut regex_class, mut regex_escaped) = (false, false, false);
    let mut regex_allowed = true;
    let mut template_expr = Vec::new();
    let mut chars = source.chars().peekable();
    while let Some(ch) = chars.next() {
        if line {
            if ch == '\n' {
                line = false;
            }
            continue;
        }
        if block {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block = false;
            }
            continue;
        }
        if regex {
            if regex_escaped {
                regex_escaped = false;
                continue;
            }
            if ch == '\\' {
                regex_escaped = true;
                continue;
            }
            if ch == '[' {
                regex_class = true;
                continue;
            }
            if ch == ']' {
                regex_class = false;
                continue;
            }
            if ch == '/' && !regex_class {
                regex = false;
                regex_allowed = false;
            }
            continue;
        }
        if let Some(q) = quote {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if q == '`' && ch == '$' && chars.peek() == Some(&'{') {
                chars.next();
                depth += 1;
                template_expr.push(depth);
                quote = None;
                if depth > DEPTH {
                    return Err("JavaScript structural depth exceeds 64.".into());
                }
                continue;
            }
            if ch == q {
                quote = None;
                regex_allowed = false;
            }
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            line = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            block = true;
            continue;
        }
        if ch == '/' && regex_allowed {
            regex = true;
            regex_class = false;
            continue;
        }
        if ch == '\'' || ch == '"' || ch == '`' {
            quote = Some(ch);
            continue;
        }
        if ch.is_alphabetic() || ch == '_' || ch == '$' {
            let mut word = String::from(ch);
            while chars
                .peek()
                .is_some_and(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
            {
                word.push(chars.next().unwrap());
            }
            regex_allowed = matches!(
                word.as_str(),
                "return"
                    | "throw"
                    | "case"
                    | "yield"
                    | "await"
                    | "typeof"
                    | "void"
                    | "delete"
                    | "new"
                    | "else"
                    | "do"
                    | "in"
                    | "instanceof"
            );
            continue;
        }
        if matches!(ch, '(' | '[' | '{') {
            depth += 1;
            if depth > DEPTH {
                return Err("JavaScript structural depth exceeds 64.".into());
            }
        }
        if matches!(ch, ')' | ']' | '}') {
            depth = depth.saturating_sub(1);
            if ch == '}' && template_expr.last() == Some(&(depth + 1)) {
                template_expr.pop();
                quote = Some('`');
            }
        }
        if ch == ';' {
            deep_ops = 0;
        }
        if matches!(ch, '?' | '+' | '-' | '/' | '*' | '!') {
            deep_ops += 1;
            if deep_ops > DEPTH {
                return Err("JavaScript expression depth exceeds 64.".into());
            }
            if ch == '*' && chars.peek() == Some(&'*') {
                chars.next();
            }
        }
        if !ch.is_whitespace() {
            regex_allowed = matches!(
                ch,
                '=' | '('
                    | '['
                    | '{'
                    | '}'
                    | ','
                    | ':'
                    | ';'
                    | '!'
                    | '?'
                    | '+'
                    | '-'
                    | '*'
                    | '/'
                    | '%'
                    | '&'
                    | '|'
                    | '^'
                    | '~'
                    | '<'
                    | '>'
            );
        }
    }
    Ok(())
}

fn visit_statement(
    s: &S<'_>,
    source: &str,
    opts: &Options,
    patches: &mut Vec<Patch>,
    payloads: &mut Vec<Payload>,
    warnings: &mut Vec<String>,
    depth: usize,
) {
    if depth > DEPTH {
        return;
    }
    match s {
        S::ExpressionStatement(x) => visit(
            &x.expression,
            source,
            opts,
            patches,
            payloads,
            warnings,
            depth + 1,
        ),
        S::VariableDeclaration(x) => {
            for d in &x.declarations {
                if let Some(e) = &d.init {
                    visit(e, source, opts, patches, payloads, warnings, depth + 1);
                }
            }
        }
        S::ReturnStatement(x) => {
            if let Some(e) = &x.argument {
                visit(e, source, opts, patches, payloads, warnings, depth + 1);
            }
        }
        S::ThrowStatement(x) => visit(
            &x.argument,
            source,
            opts,
            patches,
            payloads,
            warnings,
            depth + 1,
        ),
        S::BlockStatement(x) => {
            for child in &x.body {
                visit_statement(child, source, opts, patches, payloads, warnings, depth + 1);
            }
        }
        S::IfStatement(x) => {
            visit(
                &x.test,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            visit_statement(
                &x.consequent,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            if let Some(a) = &x.alternate {
                visit_statement(a, source, opts, patches, payloads, warnings, depth + 1);
            }
        }
        S::FunctionDeclaration(x) => {
            if let Some(b) = &x.body {
                for child in &b.statements {
                    visit_statement(child, source, opts, patches, payloads, warnings, depth + 1);
                }
            }
        }
        _ => (),
    }
}

fn visit(
    e: &E<'_>,
    source: &str,
    opts: &Options,
    patches: &mut Vec<Patch>,
    payloads: &mut Vec<Payload>,
    warnings: &mut Vec<String>,
    depth: usize,
) {
    if depth > DEPTH {
        return;
    }
    match e {
        E::BinaryExpression(x) => {
            visit(
                &x.left,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            visit(
                &x.right,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            if let (Some(a), Some(b)) = (static_value(&x.left), static_value(&x.right)) {
                if let Some(result) = fold(x.operator.as_str(), a, b) {
                    patch(e, result, "literal-fold", patches);
                }
            }
        }
        E::UnaryExpression(x) => {
            visit(
                &x.argument,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            if x.operator.as_str() == "-" {
                if let Some(n) = literal(&x.argument).and_then(number) {
                    patch(e, number_text(-n), "literal-fold", patches);
                }
            }
        }
        E::CallExpression(x) => {
            if opts.extract && sink(&x.callee) {
                let i = if matches!(&x.callee, E::Identifier(id) if id.name == "Function") {
                    x.arguments.len().checked_sub(1)
                } else {
                    Some(0)
                };
                if let Some(code) = i
                    .and_then(|i| x.arguments.get(i))
                    .and_then(|a| a.as_expression())
                    .and_then(|arg| recovered_string(arg, opts))
                {
                    let total: usize = payloads.iter().map(|p| p.code.len()).sum();
                    if code.len() <= VALUE
                        && payloads.len() < PAYLOADS
                        && total.saturating_add(code.len()) <= PAYLOAD_TEXT
                    {
                        payloads.push(Payload {
                            kind: "potential-execution-argument",
                            start: x.span.start as usize,
                            end: x.span.end as usize,
                            sha256: hex(&Sha256::digest(code.as_bytes())),
                            code,
                        });
                    } else {
                        warn(warnings, "Payload count or aggregate limit reached.");
                    }
                }
            }
            for a in &x.arguments {
                if let Some(a) = a.as_expression() {
                    visit(a, source, opts, patches, payloads, warnings, depth + 1);
                }
            }
            if opts.builtins && opts.builtin_safe && is_intrinsic(&x.callee) {
                if let Some(value) = decode_builtin(x) {
                    patch(e, quote(&value), "assumed-builtin-decode", patches);
                } else {
                    warn(
                        warnings,
                        "Skipped builtin decoding because identity or static arguments were not proven.",
                    );
                }
            }
        }
        E::ArrayExpression(x) => {
            for a in &x.elements {
                if let Some(a) = a.as_expression() {
                    visit(a, source, opts, patches, payloads, warnings, depth + 1);
                }
            }
        }
        E::ParenthesizedExpression(x) => visit(
            &x.expression,
            source,
            opts,
            patches,
            payloads,
            warnings,
            depth + 1,
        ),
        E::AssignmentExpression(x) => visit(
            &x.right,
            source,
            opts,
            patches,
            payloads,
            warnings,
            depth + 1,
        ),
        E::SequenceExpression(x) => {
            for a in &x.expressions {
                visit(a, source, opts, patches, payloads, warnings, depth + 1);
            }
        }
        E::LogicalExpression(x) => {
            visit(
                &x.left,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            visit(
                &x.right,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
        }
        E::ConditionalExpression(x) => {
            visit(
                &x.test,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            visit(
                &x.consequent,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            visit(
                &x.alternate,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
        }
        E::StaticMemberExpression(x) => visit(
            &x.object,
            source,
            opts,
            patches,
            payloads,
            warnings,
            depth + 1,
        ),
        E::ComputedMemberExpression(x) => {
            visit(
                &x.object,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
            visit(
                &x.expression,
                source,
                opts,
                patches,
                payloads,
                warnings,
                depth + 1,
            );
        }
        _ => (),
    }
}

fn literal(e: &E<'_>) -> Option<Lit> {
    match e {
        E::StringLiteral(x) if !x.lone_surrogates && x.value.len() <= VALUE => {
            Some(Lit::String(x.value.to_string()))
        }
        E::NumericLiteral(x) if x.value.is_finite() => Some(Lit::Number(x.value)),
        E::BooleanLiteral(x) => Some(Lit::Bool(x.value)),
        E::NullLiteral(_) => Some(Lit::Null),
        E::ParenthesizedExpression(x) => static_value(&x.expression),
        _ => None,
    }
}
fn static_value(e: &E<'_>) -> Option<Lit> {
    static_value_at(e, 0)
}
fn static_value_at(e: &E<'_>, depth: usize) -> Option<Lit> {
    if depth > DEPTH {
        return None;
    }
    match e {
        E::BinaryExpression(x) => {
            let a = static_value_at(&x.left, depth + 1)?;
            let b = static_value_at(&x.right, depth + 1)?;
            if x.operator.as_str() == "+" {
                if matches!(a, Lit::String(_)) || matches!(b, Lit::String(_)) {
                    let left = primitive_string(&a);
                    let right = primitive_string(&b);
                    if left.len().saturating_add(right.len()) > VALUE {
                        return None;
                    }
                    return Some(Lit::String(format!("{left}{right}")));
                }
                if let (Lit::Number(a), Lit::Number(b)) = (&a, &b) {
                    let n = a + b;
                    return n.is_finite().then_some(Lit::Number(n));
                }
            }
            if let (Lit::Number(a), Lit::Number(b)) = (a, b) {
                let n = match x.operator.as_str() {
                    "-" => a - b,
                    "*" => a * b,
                    "/" if b != 0.0 => a / b,
                    "%" if b != 0.0 => a % b,
                    _ => return None,
                };
                return n.is_finite().then_some(Lit::Number(n));
            }
            None
        }
        E::ParenthesizedExpression(x) => static_value_at(&x.expression, depth + 1),
        E::UnaryExpression(x) if x.operator.as_str() == "-" => {
            let Lit::Number(n) = static_value_at(&x.argument, depth + 1)? else {
                return None;
            };
            Some(Lit::Number(-n))
        }
        E::UnaryExpression(x) if x.operator.as_str() == "+" => {
            let Lit::Number(n) = static_value_at(&x.argument, depth + 1)? else {
                return None;
            };
            Some(Lit::Number(n))
        }
        _ => literal_atom(e),
    }
}
fn literal_atom(e: &E<'_>) -> Option<Lit> {
    match e {
        E::StringLiteral(x) if !x.lone_surrogates && x.value.len() <= VALUE => {
            Some(Lit::String(x.value.to_string()))
        }
        E::NumericLiteral(x) if x.value.is_finite() => Some(Lit::Number(x.value)),
        E::BooleanLiteral(x) => Some(Lit::Bool(x.value)),
        E::NullLiteral(_) => Some(Lit::Null),
        _ => None,
    }
}
#[derive(Clone)]
enum Lit {
    String(String),
    Number(f64),
    Bool(bool),
    Null,
}
fn number(v: Lit) -> Option<f64> {
    if let Lit::Number(n) = v {
        Some(n)
    } else {
        None
    }
}
fn primitive_string(v: &Lit) -> String {
    match v {
        Lit::String(s) => s.clone(),
        Lit::Number(n) => js_number_string(*n),
        Lit::Bool(b) => b.to_string(),
        Lit::Null => "null".into(),
    }
}
fn js_number_string(n: f64) -> String {
    if n == 0.0 { "0".into() } else { number_text(n) }
}
fn fold(op: &str, a: Lit, b: Lit) -> Option<String> {
    if op == "+" {
        if matches!(a, Lit::String(_)) || matches!(b, Lit::String(_)) {
            let s = format!("{}{}", primitive_string(&a), primitive_string(&b));
            return (s.len() <= VALUE).then(|| quote(&s));
        }
        if let (Lit::Number(a), Lit::Number(b)) = (&a, &b) {
            let n = a + b;
            return n.is_finite().then(|| number_text(n));
        }
    }
    if let (Lit::Number(a), Lit::Number(b)) = (a, b) {
        let n = match op {
            "-" => a - b,
            "*" => a * b,
            "/" if b != 0.0 => a / b,
            "%" if b != 0.0 => a % b,
            _ => return None,
        };
        if n.is_finite() {
            return Some(number_text(n));
        }
    }
    None
}
fn constant_string(e: &E<'_>) -> Option<String> {
    match e {
        E::BinaryExpression(x) if x.operator.as_str() == "+" => {
            let a = static_value(&x.left)?;
            let b = static_value(&x.right)?;
            (matches!(a, Lit::String(_)) || matches!(b, Lit::String(_)))
                .then(|| format!("{}{}", primitive_string(&a), primitive_string(&b)))
        }
        _ => match literal(e)? {
            Lit::String(s) => Some(s),
            _ => None,
        },
    }
}
fn recovered_string(e: &E<'_>, opts: &Options) -> Option<String> {
    constant_string(e).or_else(|| match e {
        E::CallExpression(call)
            if opts.builtins && opts.builtin_safe && is_intrinsic(&call.callee) =>
        {
            decode_builtin(call)
        }
        _ => None,
    })
}
fn sink(e: &E<'_>) -> bool {
    matches!(e,E::Identifier(i) if matches!(i.name.as_str(),"eval"|"Function"|"setTimeout"|"setInterval"))
}
fn is_intrinsic(e: &E<'_>) -> bool {
    matches!(e,E::Identifier(i) if i.name=="atob")
        || matches!(e,E::StaticMemberExpression(m) if m.object.is_specific_id("String")&&m.property.name=="fromCharCode")
}
fn decode_builtin(call: &oxc_ast::ast::CallExpression<'_>) -> Option<String> {
    let atob = matches!(&call.callee,E::Identifier(i) if i.name=="atob");
    let from = matches!(&call.callee,E::StaticMemberExpression(m) if m.object.is_specific_id("String")&&m.property.name=="fromCharCode");
    if atob {
        if call.arguments.len() != 1 {
            return None;
        }
        let input = constant_string(call.arguments.first()?.as_expression()?)?;
        if input.len().saturating_mul(3) / 4 > VALUE {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(input)
            .ok()?;
        if bytes.len() > VALUE {
            return None;
        }
        return Some(bytes.into_iter().map(char::from).collect());
    }
    if from {
        if call.arguments.len() > VALUE / 2 {
            return None;
        }
        let mut units = Vec::new();
        for arg in &call.arguments {
            let n = number(static_value(arg.as_expression()?)?)?;
            if !n.is_finite() {
                return None;
            }
            units.push(n.trunc().rem_euclid(65536.0) as u16);
        }
        if units.len() > VALUE / 2 {
            return None;
        }
        return String::from_utf16(&units).ok();
    }
    None
}
fn number_text(n: f64) -> String {
    if n == 0.0 && n.is_sign_negative() {
        return "-0".into();
    }
    if !n.is_finite() {
        return "0".into();
    }
    dragonbox_ecma::Buffer::new().format_finite(n).to_owned()
}
fn quote(s: &str) -> String {
    let mut o = String::from("'");
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '\'' => o.push_str("\\'"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            '\u{2028}' => o.push_str("\\u2028"),
            '\u{2029}' => o.push_str("\\u2029"),
            _ => o.push(c),
        }
    }
    o.push('\'');
    o
}
fn patch(e: &E<'_>, value: String, kind: &'static str, p: &mut Vec<Patch>) {
    let wrapped = format!("({value})");
    if wrapped.len() <= VALUE && p.len() < TRANSFORMS + 1 {
        p.push((
            e.span().start as usize..e.span().end as usize,
            wrapped,
            kind,
        ));
    }
}
fn warn(w: &mut Vec<String>, s: &str) {
    if w.len() < 64 {
        w.push(s.into());
    }
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn encode(value: Value) -> String {
    struct Capped(Vec<u8>);
    impl Write for Capped {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if self.0.len().saturating_add(b.len()) > REPORT {
                return Err(std::io::Error::other("report limit"));
            }
            self.0.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut out = Capped(Vec::new());
    if serde_json::to_writer(&mut out, &value).is_ok() {
        return String::from_utf8(out.0).unwrap_or_default();
    }
    "{\"schema_version\":1,\"error\":\"report_too_large\",\"message\":\"Serialized report exceeds 4 MiB.\"}".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn invoke(s: &str, o: &str) -> Value {
        serde_json::from_str(&deobfuscate(s.as_bytes(), o)).unwrap()
    }
    #[test]
    fn closed_folds() {
        assert_eq!(
            invoke("const a='a'+'b'; const n=(19+23)*2;", "{}")["code"],
            "const a = \"ab\";\nconst n = 84;\n"
        );
    }
    #[test]
    fn reports_payload_not_execution() {
        let r = invoke(
            "eval('x'+'y'); Function('a','b'); setTimeout('timer',1);",
            "{\"extractPayloads\":true}",
        );
        assert_eq!(r["payloads"].as_array().unwrap().len(), 3);
        assert_eq!(r["payloads"][0]["code"], "xy");
        assert_eq!(r["payloads"][1]["code"], "b");
    }
    #[test]
    fn decodes_intrinsic_sink_argument_under_closed_assumption() {
        let r = invoke(
            "eval(atob('YWxlcnQoMSk='));",
            "{\"extractPayloads\":true,\"assumeStandardBuiltins\":true}",
        );
        assert_eq!(r["payloads"][0]["code"], "alert(1)");
    }
    #[test]
    fn regex_is_opaque_to_structural_depth_guard() {
        let s = "result=/[ +100 '{' + ]/.source;";
        assert_eq!(invoke(s, "{}")["error"], Value::Null);
    }
    #[test]
    fn computed_global_override_disables_builtin_fold() {
        let s = "globalThis['at'+'ob']=()=> 'x'; result=atob('QQ==');";
        assert_eq!(
            invoke(s, "{\"assumeStandardBuiltins\":true}")["transformations"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
    #[test]
    fn builtin_assumption_and_shadow_block() {
        assert_eq!(
            invoke("atob('YQ==');", "{\"assumeStandardBuiltins\":true}")["code"],
            "(\"a\");\n"
        );
        assert_eq!(
            invoke(
                "function f(atob){return atob('YQ==')}",
                "{\"assumeStandardBuiltins\":true}"
            )["code"],
            "function f(atob) {\n\treturn atob(\"YQ==\");\n}\n"
        );
    }
    #[test]
    fn directives_and_script_with() {
        assert_eq!(
            invoke("'use ' + 'strict'; with (obj) { x = 1 }", "{}")["code"],
            "(\"use strict\");\nwith(obj) {\n\tx = 1;\n}\n"
        );
    }
    #[test]
    fn limits_and_hash() {
        assert_eq!(invoke("", "{\"what\":true}")["error"], "unknown_option");
        let r = invoke("const s='é'+'x';", "{}");
        assert_eq!(r["input"]["bytes"], 17);
    }
    #[test]
    fn preserves_lone_surrogate_escapes() {
        let s = r#"result="\ud800"+"x";"#;
        assert!(
            invoke(s, "{}")["code"]
                .as_str()
                .unwrap()
                .contains("\\ud800")
        );
    }
    #[test]
    fn preserves_js_number_string_coercion() {
        assert_eq!(
            invoke("result=''+1e21; other=''+-0;", "{}")["code"],
            "result = \"1e+21\";\nother = \"0\";\n"
        );
    }
    #[test]
    fn prior_sink_and_nested_effects_disable_intrinsic_folds() {
        for source in [
            "eval(atob('eA==')); atob('QQ==');",
            "eval(atob('eA==')) + atob('QQ==');",
            "x; atob('QQ==');",
            "String.fromCharCode((atob = other), 65);",
        ] {
            let report = invoke(source, "{\"assumeStandardBuiltins\":true}");
            assert!(
                report["transformations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|entry| entry["kind"] != "assumed-builtin-decode")
            );
        }
    }
    #[test]
    fn comma_separated_deep_expression_is_bounded() {
        let source = format!("result={};", "true ? (0,1) : ".repeat(80) + "0");
        assert_eq!(invoke(&source, "{}")["error"], "depth_limit");
    }
    #[test]
    fn regex_after_keyword_and_escaped_template_are_opaque() {
        let regex = format!("function f(){{return /[{}]/;}}", "{".repeat(100));
        assert!(invoke(&regex, "{}")["error"].is_null());
        let template = format!("result=`\\${{{}}}`;", "(".repeat(100));
        assert!(invoke(&template, "{}")["error"].is_null());
    }
}
