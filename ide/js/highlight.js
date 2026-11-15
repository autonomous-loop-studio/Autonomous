/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================
// highlight — a small dependency-free tokenizer
// ============================================
//
// The IDE has no editor library (no Monaco, no CodeMirror) by design, so this
// file is the syntax layer: a per-language list of regex rules, compiled into
// ONE alternation so each character position is tested once, producing spans
// like <span class="tk-kw">. The classes are styled in ide.css from the same
// palette the main app uses.
//
// It is deliberately approximate — regexes, not parsers. Long strings and
// comments spanning lines are handled; pathological languages are not. Files
// above 250 KB fall back to plain escaped text so typing never stalls.

const MAX_HL = 250000;

// ---- keyword tables -------------------------------------------------------
const KW = {
  js: 'as,async,await,break,case,catch,class,const,continue,debugger,default,delete,do,else,export,extends,finally,for,from,function,get,if,implements,import,in,instanceof,interface,let,new,of,return,set,static,super,switch,this,throw,try,typeof,var,void,while,with,yield,true,false,null,undefined,NaN',
  php: 'abstract,and,array,as,break,callable,case,catch,class,clone,const,continue,declare,default,do,echo,else,elseif,empty,enum,extends,final,finally,fn,for,foreach,function,global,goto,if,implements,include,include_once,instanceof,insteadof,interface,isset,list,match,namespace,new,or,print,private,protected,public,readonly,require,require_once,return,static,switch,throw,trait,try,unset,use,var,while,xor,yield,true,false,null',
  python: 'and,as,assert,async,await,break,class,continue,def,del,elif,else,except,finally,for,from,global,if,import,in,is,lambda,nonlocal,not,or,pass,raise,return,try,while,with,yield,True,False,None',
  shell: 'if,then,else,elif,fi,for,while,do,done,case,esac,function,in,echo,export,return,local,set,source',
};
const kwRe = (list) => `(?:${list.split(',').sort((a, b) => b.length - a.length).join('|')})`;

// ---- rule tables ----------------------------------------------------------
// Order matters: alternation is leftmost-first, so comments and strings come
// before keywords. Each rule is [regexSource, class]; sticky matching walks
// the code left to right.

const RULES = {
  php: [
    ['<\\?php|<\\?=|\\?>', 'tk-tag'],
    ['/\\*[\\s\\S]*?(?:\\*/|$)', 'tk-com'],
    ['(?://|#)(?!\\[)[^\\n]*', 'tk-com'],
    ["'(?:\\\\.|[^'\\\\\\n])*'", 'tk-str'],
    ['"(?:\\\\.|[^"\\\\\\n])*"', 'tk-str'],
    ['`(?:\\\\.|[^`\\\\])*`', 'tk-str'],
    ['\\$[A-Za-z_]\\w*', 'tk-var'],
    [kwRe(KW.php), 'tk-kw'],
    ['\\b[A-Za-z_]\\w*(?=\\s*\\()', 'tk-fn'],
    ['\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', 'tk-num'],
  ],
  js: [
    ['`(?:\\\\.|[^`\\\\])*`', 'tk-str'],
    ["/(?:\\\\.|[^/\\\\\\n])+/[a-z]*", 'tk-str'],
    ['//[^\\n]*', 'tk-com'],
    ['/\\*[\\s\\S]*?(?:\\*/|$)', 'tk-com'],
    ["'(?:\\\\.|[^'\\\\\\n])*'", 'tk-str'],
    ['"(?:\\\\.|[^"\\\\\\n])*"', 'tk-str'],
    [kwRe(KW.js), 'tk-kw'],
    ['\\b[A-Za-z_$][\\w$]*(?=\\s*\\()', 'tk-fn'],
    ['\\.\\s*[A-Za-z_$][\\w$]*', 'tk-prop'],
    ['\\b0[xXbBoO][0-9a-fA-F_]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', 'tk-num'],
  ],
  html: [
    ['<!--[\\s\\S]*?(?:-->|$)', 'tk-com'],
    ['<!DOCTYPE[^>]*>', 'tk-tag'],
    ['</?[A-Za-z][\\w-]*', 'tk-tag'],
    ['[A-Za-z-]+(?==)', 'tk-attr'],
    ["'(?:[^'\\n]*)'|\"(?:[^\"\\n]*)\"", 'tk-str'],
    ['/?>', 'tk-punc'],
  ],
  css: [
    ['/\\*[\\s\\S]*?(?:\\*/|$)', 'tk-com'],
    ["'(?:\\\\.|[^'\\\\\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\"", 'tk-str'],
    ['@media|@import|@supports|@keyframes|@[\\w-]+', 'tk-kw'],
    ['[.#][A-Za-z_][\\w-]*', 'tk-tag'],
    ['[A-Za-z-]+(?=\\s*:)', 'tk-prop'],
    ['#[0-9a-fA-F]{3,8}\\b', 'tk-num'],
    ['\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?\\b', 'tk-num'],
  ],
  json: [
    ['"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', 'tk-prop'],
    ['"(?:\\\\.|[^"\\\\])*"', 'tk-str'],
    ['\\btrue\\b|\\bfalse\\b|\\bnull\\b', 'tk-kw'],
    ['-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', 'tk-num'],
  ],
  md: [
    ['^#{1,6}[^\\n]*', 'tk-kw'],
    ['```[\\s\\S]*?(?:```|$)', 'tk-str'],
    ['`[^`\\n]+`', 'tk-str'],
    ['\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__', 'tk-prop'],
    ['\\[[^\\]\\n]*\\]\\([^)\\n]*\\)', 'tk-fn'],
    ['^\\s*(?:[-*+]|\\d+\\.)\\s', 'tk-tag'],
  ],
  python: [
    ['#[^\\n]*', 'tk-com'],
    ['"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)', 'tk-str'],
    ["(?:[rRbBfFuU]{0,2})'(?:\\\\.|[^'\\\\\\n])*'|(?:[rRbBfFuU]{0,2})\"(?:\\\\.|[^\"\\\\\\n])*\"", 'tk-str'],
    [kwRe(KW.python), 'tk-kw'],
    ['\\b[A-Za-z_]\\w*(?=\\s*\\()', 'tk-fn'],
    ['\\b\\d+(?:\\.\\d+)?\\b', 'tk-num'],
  ],
  shell: [
    ['#[^\\n]*', 'tk-com'],
    ["'(?:[^'\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\"", 'tk-str'],
    ['\\$\\{?[A-Za-z_]\\w*\\}?', 'tk-var'],
    [kwRe(KW.shell), 'tk-kw'],
    ['\\b[A-Za-z_-][\\w-]*(?=\\s*\\()', 'tk-fn'],
    ['\\$\\d+|\\b\\d+\\b', 'tk-num'],
  ],
};

const COMPILED = {};
for (const [lang, rules] of Object.entries(RULES)) {
  COMPILED[lang] = {
    re: new RegExp(rules.map((r) => `(${r[0]})`).join('|'), 'g'),
    classes: rules.map((r) => r[1]),
  };
}

export function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Extension → language key. Unknown extensions render plain. */
export function detectLang(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['php', 'phtml'].includes(ext)) return 'php';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue'].includes(ext)) return 'js';
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) return 'html';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'py') return 'python';
  if (['sh', 'bash', 'bat', 'cmd', 'ps1'].includes(ext)) return 'shell';
  return 'plain';
}

export function langLabel(lang) {
  return { plain: 'text', js: 'javascript' }[lang] || lang;
}

/**
 * Highlight `code` for `lang` → HTML string. The textarea layer holds the raw
 * text and is transparent; this painted layer sits behind it.
 */
export function highlight(code, lang) {
  if (lang === 'plain' || !COMPILED[lang] || code.length > MAX_HL) {
    return escHtml(code);
  }
  const { re, classes } = COMPILED[lang];
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; } // safety: empty match
    out += escHtml(code.slice(last, m.index));
    // The first defined capture group identifies the rule that matched.
    let cls = '';
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) { cls = classes[i - 1]; break; }
    }
    out += `<span class="${cls}">${escHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += escHtml(code.slice(last));
  return out;
}
