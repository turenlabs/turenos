// Only these locally authored, bounded fixtures may enter the VM oracle.
// No source from argv, files, extracted payloads, or workers is executed.
export function generatedFixtures() {
  let state = 0x51c0ffee
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  return Array.from({ length: 320 }, (_, index) => {
    const a = random() % 1000
    const b = (random() % 97) + 1
    const word = `unit${index}`
    const escaped = [...word]
      .map((char, i) =>
        i % 2
          ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      )
      .join("")
    const expressions = [
      [`"${escaped}" + "!"`, `${word}!`],
      [`(${a} + ${b}) * 2 - ${b}`, (a + b) * 2 - b],
      [`["ignored", "${escaped}" + "!"][1]`, `${word}!`],
      [`("${escaped}" + (${a} + ${b}))`, word + (a + b)],
      [`(${a} % ${b}) + (${b} * 3)`, (a % b) + b * 3],
      [`[${a}, ${b}, ${a} + ${b}][2]`, a + b],
      [
        `String.fromCharCode(${65 + (index % 26)}, 0x00ff, 0xd83d, 0xde00)`,
        String.fromCharCode(65 + (index % 26), 255, 0xd83d, 0xde00),
      ],
      [`atob("${Buffer.from(word + "\xff", "latin1").toString("base64")}")`, word + "\xff"],
    ]
    const selected = expressions[index % expressions.length]
    return {
      name: `generated-${index}`,
      source: `trace.push("before"); result = ${selected[0]}; trace.push(result);`,
      expected: selected[1],
      options: index % 8 >= 6 ? { assumeStandardBuiltins: true } : {},
    }
  })
}

export const semanticFixtures = [
  ["shadowed-atob", 'function f(atob) { return atob("QQ==") } result=f(x=>"shadow:"+x);'],
  ["shadowed-String", 'function f(String) { return String.fromCharCode(65) } result=f({fromCharCode:x=>"shadow"+x});'],
  ["reassigned-atob", 'atob=x=>"changed"; result=atob("QQ==");'],
  ["computed-atob-write", 'globalThis["at"+"ob"]=()=>"changed"; result=atob("QQ==");'],
  ["defined-atob-write", 'Object.defineProperty(globalThis,"at"+"ob",{value:()=>"changed"}); result=atob("QQ==");'],
  ["reassigned-intrinsic", 'String.fromCharCode=x=>"changed"; result=String.fromCharCode(65);'],
  ["closure-shadow", 'const x="outer"; function f(){ const x="inner"; return ()=>x+"!" } result=f()();'],
  ["closure-write", 'let x="old"; const f=()=>x+"!"; x="new"; result=f();'],
  ["table-write", 'const t=["old"]; t[0]="new"; result=t[0]+"!";'],
  ["table-escape", 'const t=["old"]; function change(a){a[0]="new";trace.push("write")} change(t); result=t[0];'],
  ["getter", 'const t={get value(){trace.push("getter");return "x"}}; result=t.value+"!";'],
  ["array-getter", 'const t=["x"]; Object.defineProperty(t,"0",{get(){trace.push("get");return "y"}}); result=t[0];'],
  ["tdz", 'result=x+"!"; const x="late";', "ReferenceError"],
  ["typeof-tdz", 'result=typeof x; const x="late";', "ReferenceError"],
  ["switch-tdz", 'switch(1){case 0: const x="zero"; break; case 1: result=x;}', "ReferenceError"],
  ["assignment-target", "let x=1; x=2; result=x;"],
  ["update-target", "let x=1; trace.push(x++); result=++x;"],
  ["destructuring-target", "let x=1; [x]=[3]; result=x;"],
  ["typeof-absent", "result=typeof notDeclared;"],
  ["directive-insertion", '"use " + "strict"; result=(function(){return this===undefined})() ;'],
  ["comment-directive-insertion", '/* prologue */ "use " + "strict"; result=(function(){return this===undefined})();'],
  ["asm-directive-insertion", '"use asm"; "use " + "strict"; result=(function(){return this===undefined})();'],
  ["escaped-parameter-atob", 'function f(\\u0061tob){return atob("QQ==")} result=f(x=>"custom:"+x);'],
  [
    "with-comment-customscope",
    'const customscope={atob:x=>"custom:"+x}; with/*comment*/(customscope) result=atob("QQ==");',
  ],
  ["fromcharcode-large-coercion", "result=String.fromCharCode(1e20,-1e20);"],
  ["strict-directive", '"use strict"; result=(function(){return this===undefined})();'],
  ["asi-return", 'result=(function(){return\n "a"+"b"})();'],
  ["asi-postfix", "let x=1; let y=2; x\n++y; result=[x,y];"],
  ["regex", 'result=/a\\/b/.test("a/b") + ":" + /[+]/.source;'],
  ["template", 'result=`a${1+2}b${"c"+"d"}`;'],
  ["tagged-template", "function tag(s){trace.push(s.raw[0]);return s[0]} result=tag`\\u0061`;"],
  ["lone-surrogate", 'result="\\ud800"+"x";'],
  ["braced-lone-surrogate", 'result="\\u{d800}"+"x";'],
  ["astral-utf16", 'result=[("😀"+"!").length, "😀"[0], "😀"[1]];'],
  ["large-integer", "result=[9007199254740993+1, 9007199254740991+2];"],
  ["negative-zero", "result=[-0, 0 * -1, 1 / -0];"],
  ["nonfinite", "result=[0/0, 1/0, -1/0];"],
  ["bigint", "result=(9007199254740993n+2n).toString();"],
  ["base64-latin1", 'result=atob("AP+A");'],
  ["base64-invalid", 'result=atob("!!");', "InvalidCharacterError"],
  ["base64-extra-argument-effect", 'result=atob("QQ==", trace.push("extra"));'],
  ["base64-extra-argument-error", 'result=atob("QQ==", missingArgument);', "ReferenceError"],
  ["number-overflow", "result=1e308+1e308;"],
  ["nonfinite-literal-unary", "result=-1e309;"],
  ["nonfinite-literal-string", 'result=""+1e309;'],
  ["number-string-exponent", 'result=[""+1e21, ""+1e-7, ""+1e20];'],
  ["number-string-negative-zero", 'result=""+(0*(0-1));'],
  ["unicode-before-span", '/* 😀é */ result="a"+"b";'],
  ["computed-property", 'const o={}; o["a"+"b"]=2; result=o.ab;'],
  ["short-circuit", 'result=false && (trace.push("wrong"), "a"+"b");'],
  ["conditional-effects", 'result=true ? (trace.push("yes"), "a"+"b") : trace.push("no");'],
  ["throw-trace", 'trace.push("before"); throw new TypeError("fixture");', "TypeError"],
].map(([name, source, error]) => ({ name, source, error }))

export const payloadFixtures = [
  { name: "eval-concat", source: '/* é😀 */ eval("globalThis." + "fixture = 7");', payload: "globalThis.fixture = 7" },
  { name: "function-body", source: 'Function("return " + "42");', payload: "return 42" },
  { name: "timer", source: 'setTimeout("fixture" + " = 9", 1);', payload: "fixture = 9" },
  { name: "interval", source: 'setInterval("fixture" + " = 10", 1);', payload: "fixture = 10" },
  {
    name: "encoded-eval",
    source: 'eval(atob("YWxlcnQoMSk="));',
    payload: "alert(1)",
    options: { assumeStandardBuiltins: true },
  },
]

export function boundaryFixtures() {
  const KiB = 1024
  return [
    { name: "malformed-utf8", input: new Uint8Array([0xc0, 0xaf]), reject: true },
    { name: "utf8-truncated", input: new Uint8Array([0xf0, 0x9f]), reject: true },
    { name: "input-at-limit", source: " ".repeat(1024 * KiB - 2) + "0;", success: true },
    { name: "input-over-limit", source: " ".repeat(1024 * KiB + 1), reject: true },
    { name: "options-at-limit", source: "0;", optionsJSON: "{}" + " ".repeat(4 * KiB - 2), success: true },
    { name: "options-over-limit", source: "0;", optionsJSON: "{}" + " ".repeat(4 * KiB - 1), reject: true },
    { name: "unknown-option", source: "0;", optionsJSON: '{"execute":true}', reject: true },
    { name: "invalid-language", source: "0;", optionsJSON: '{"language":"python"}', reject: true },
    { name: "invalid-options-json", source: "0;", optionsJSON: "{", reject: true },
    { name: "wrong-options-type", source: "0;", optionsJSON: "[]", reject: true },
    { name: "wrong-option-value", source: "0;", optionsJSON: '{"extractPayloads":"yes"}', reject: true },
    { name: "syntax-error", source: "const = ;", reject: true },
    { name: "nesting-near-64", source: "result=" + "(".repeat(60) + "1+2" + ")".repeat(60) + ";" },
    { name: "deep-ast", source: "result=" + "f(".repeat(100) + "0" + ")".repeat(100) + ";", reject: true },
    {
      name: "deep-quoted-not-ast",
      source: "result=" + JSON.stringify("(".repeat(5000) + ")".repeat(5000)) + ";",
      success: true,
    },
    { name: "deep-unary-ast", source: "result=" + "!".repeat(100) + "true;", reject: true },
    {
      name: "deep-template-ast",
      source: "result=`${" + "f(".repeat(100) + "0" + ")".repeat(100) + "}`;",
      reject: true,
    },
    { name: "regex-brackets-not-ast", source: "result=/[" + "{".repeat(100) + "]/.source;", success: true },
    { name: "deep-binary-ast", source: "result=" + "1+".repeat(100) + "1;", boundedSkip: true },
    { name: "deep-comma-conditional", source: "result=" + "true ? (0,1) : ".repeat(80) + "0;", reject: true },
    { name: "regex-after-return", source: "function f(){return /[" + "{".repeat(100) + "]/;}", success: true },
    {
      name: "many-transforms",
      source: Array.from({ length: 700 }, (_, i) => `sink${i}="a"+"b";`).join(""),
      success: true,
    },
    {
      name: "value-64KiB",
      source: "result=" + JSON.stringify("a".repeat(32 * KiB)) + "+" + JSON.stringify("b".repeat(32 * KiB)) + ";",
    },
    {
      name: "value-over-64KiB",
      source: "result=" + JSON.stringify("a".repeat(32 * KiB)) + "+" + JSON.stringify("b".repeat(32 * KiB + 1)) + ";",
    },
    {
      name: "payload-aggregate",
      source: Array.from({ length: 80 }, () => "eval(" + JSON.stringify("x".repeat(4096)) + ");").join(""),
      optionsJSON: '{"extractPayloads":true}',
    },
    { name: "payload-count", source: 'eval("x");'.repeat(140), optionsJSON: '{"extractPayloads":true}' },
    // Printing escaped control characters stresses code/report expansion without exceeding input.
    { name: "code-report-expansion", source: 'result="' + "\\x01".repeat(220000) + '";' },
    { name: "never-execute", source: 'while(true){}; throw new Error("must never run");', success: true },
  ]
}
