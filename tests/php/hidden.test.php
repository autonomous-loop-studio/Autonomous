<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `hidden` trap: an element JS hides with the `hidden` ATTRIBUTE must
 * actually be hidden by CSS.
 *
 * Usage: php tests/php/hidden.test.php
 *
 * The bug this exists to prevent is invisible in code review. `hidden` only
 * hides an element because the user-agent stylesheet says
 * `[hidden] { display: none }` -- and ANY author rule that sets `display` on
 * that element outranks it. A class rule is enough:
 *
 *     .bs-empty { display: flex; }     /* the panel still paints *\/
 *     empty.hidden = true;             /* ...and the JS believes it is gone *\/
 *
 * That is not theoretical. It shipped twice: the built-in Browser's "Browser
 * not running" panel painted over a live page for good (a translucent veil
 * that never went away), and the notification badge sat on the bell at zero
 * notifications as an empty red dot. Both looked like a broken overlay and
 * neither threw an error, so the only reliable check is the one below: read
 * every stylesheet rule that displays something, read every place the JS
 * toggles `hidden`, and require a matching `[hidden]` rule on every element in
 * both sets.
 *
 * How the join is made: a rule is a risk when its LAST compound is a single
 * class or id (the element's own rule -- not `.foo.open`, which is a state
 * modifier) and that same token appears on, or within three lines before, a
 * `hidden` assignment in `ui/js`. It is safe when some rule in `ui/css` carries
 * the same token together with `[hidden]` and declares `display: none`.
 *
 * Exemptions are named, with a reason, and are the only way round the check --
 * the same discipline as `layers.test.php`. A new surface cannot join the pile
 * by accident.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name, &$pass, &$fail, &$errors)
{
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

/** Class and id tokens in a selector or a line of JS. */
function tokens($str)
{
    preg_match_all('/[.#][A-Za-z][A-Za-z0-9_-]*/', (string) $str, $m);
    return array_values(array_unique($m[0]));
}

/** Split a grouped selector into its parts. */
function selector_parts($selector)
{
    $out = array();
    foreach (explode(',', $selector) as $part) {
        $part = trim($part);
        if ($part !== '') {
            $out[] = $part;
        }
    }
    return $out;
}

/**
 * The element a selector names, as a class or id token, or null when the last
 * compound is anything else (a pseudo-class, an attribute test, a tagged
 * element, a descendant combinator to a state modifier).
 */
function subject_token($selector)
{
    $chunks = preg_split('/\s+|[>+~]/', trim($selector));
    $last = trim((string) end($chunks));
    if (preg_match('/^[.#][A-Za-z][A-Za-z0-9_-]*$/', $last)) {
        return $last;
    }
    return null;
}

/**
 * Every rule in a stylesheet, with the selector it belongs to and the line it
 * starts on. Comments are blanked first so a rule inside a comment cannot be
 * read as code.
 */
function css_rules($path)
{
    $css = @file_get_contents($path);
    if ($css === false) {
        return array();
    }
    $css = preg_replace('~/\*.*?\*/~s', '', $css);
    $out = array();
    if (!preg_match_all('~([^{}]+)\{([^{}]*)\}~s', $css, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
        return $out;
    }
    foreach ($m as $hit) {
        $selector = trim(preg_replace('/\s+/', ' ', $hit[1][0]));
        if ($selector === '' || $selector[0] === '@') {
            continue;   // an @media header, not a rule
        }
        $out[] = array(
            'selector' => $selector,
            'body' => $hit[2][0],
            'line' => substr_count(substr($css, 0, (int) $hit[1][1]), "\n") + 1,
        );
    }
    return $out;
}

/** Does this rule set a display value other than `none`? */
function displays($body)
{
    if (!preg_match_all('/display\s*:\s*([^;}]+)/', $body, $m)) {
        return false;
    }
    foreach ($m[1] as $value) {
        if (strtolower(trim($value)) !== 'none') {
            return true;
        }
    }
    return false;
}

/** The offending token for one rule, or null when the rule is safe. */
function rule_violation($rule, $toggled, $guarded, $exempt)
{
    if (strpos($rule['selector'], '[hidden]') !== false) {
        return null;        // this rule is one of the guards
    }
    if (!displays($rule['body'])) {
        return null;
    }
    foreach (selector_parts($rule['selector']) as $part) {
        $token = subject_token($part);
        if ($token === null || $token === '.hidden') {
            continue;
        }
        if (!isset($toggled[$token]) || isset($guarded[$token]) || isset($exempt[$token])) {
            continue;
        }
        return $token;
    }
    return null;
}

// ------------------------------------------------------------------ the CSS

$files = glob($root . '/ui/css/*.css');
sort($files);
$rules = array();
$guarded = array();     // token => 'file:line' of the [hidden] rule that protects it
foreach ($files as $path) {
    $rel = 'ui/css/' . basename($path);
    foreach (css_rules($path) as $rule) {
        $rule['file'] = $rel;
        $rules[] = $rule;
        if (strpos($rule['selector'], '[hidden]') !== false && preg_match('/display\s*:\s*none/', $rule['body'])) {
            foreach (tokens($rule['selector']) as $t) {
                if (!isset($guarded[$t])) {
                    $guarded[$t] = $rel . ':' . $rule['line'];
                }
            }
        }
    }
}

ok(count($rules) > 100,
    'the audit read the stylesheets (' . count($rules) . ' rules, ' . count($files) . ' files)',
    $pass, $fail, $errors);

ok(count($guarded) > 3,
    'the audit found the [hidden] guards already in the CSS (' . count($guarded) . ' elements protected)',
    $pass, $fail, $errors);

// --------------------------------------------------------------- the JS side

$js = array();
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/ui/js', FilesystemIterator::SKIP_DOTS));
foreach ($it as $file) {
    if (substr($file->getFilename(), -3) === '.js') {
        $js[] = (string) $file;
    }
}
sort($js);

$toggled = array();     // token => 'file:line' of the hidden assignment
foreach ($js as $path) {
    $lines = @file($path);
    if ($lines === false) {
        continue;
    }
    $rel = 'ui/js/' . ltrim(str_replace($root . '/ui/js', '', str_replace('\\', '/', $path)), '/');
    foreach ($lines as $i => $line) {
        if (!preg_match('/\.hidden\s*=|setAttribute\(\s*[\'"]hidden|toggleAttribute\(\s*[\'"]hidden/', $line)) {
            continue;
        }
        $context = implode(' ', array_slice($lines, max(0, $i - 3), 4));
        foreach (tokens($context) as $t) {
            if (!isset($toggled[$t])) {
                $toggled[$t] = $rel . ':' . ($i + 1);
            }
        }
    }
}

// The assignment itself rarely names the element: `.bs-empty` is toggled as
// `empty.hidden = ...` on a variable fetched a hundred lines away and a
// hundred lines after the tag that created it. So read the markup too -- every
// tag authored with the `hidden` attribute IS hidden by attribute, and its
// classes are the selectors a stylesheet will use to paint over it.
$markup = $js;
foreach (array($root . '/index.html', $root . '/ui/index.html') as $path) {
    if (is_file($path)) {
        $markup[] = $path;
    }
}
$idClasses = array();   // '#bsEmpty' => array('.bs-empty')
foreach ($markup as $path) {
    $text = @file_get_contents($path);
    if ($text === false) {
        continue;
    }
    if (!preg_match_all('/<[a-z][a-z0-9-]*\b[^<>]*>/i', $text, $tags, PREG_OFFSET_CAPTURE)) {
        continue;
    }
    $rel = str_replace('\\', '/', str_replace($root . '/', '', $path));
    foreach ($tags[0] as $tag) {
        $html = $tag[0];
        $classes = array();
        if (preg_match('/class\s*=\s*["\']([^"\']*)["\']/i', $html, $cm)) {
            foreach (preg_split('/\s+/', trim($cm[1])) as $class) {
                if ($class !== '') {
                    $classes[] = '.' . $class;
                }
            }
        }
        $id = null;
        if (preg_match('/id\s*=\s*["\']([^"\']*)["\']/i', $html, $im) && trim($im[1]) !== '') {
            $id = '#' . trim($im[1]);
            if ($classes) {
                $idClasses[$id] = $classes;
            }
        }
        // A bare `hidden` attribute -- not `data-hidden`, not `aria-hidden`.
        if (!preg_match('/\shidden(?=[\s>=]|$)/i', $html)) {
            continue;
        }
        $line = substr_count(substr($text, 0, (int) $tag[1]), "\n") + 1;
        foreach (array_merge($classes, $id ? array($id) : array()) as $t) {
            if (!isset($toggled[$t])) {
                $toggled[$t] = $rel . ':' . $line . ' (markup)';
            }
        }
    }
}

// An id toggled from JS points at the same element its classes paint: bridge
// the two so a rule on `.bs-empty` is checked when only `#bsEmpty` is assigned.
foreach (array_keys($toggled) as $t) {
    if ($t[0] === '#' && isset($idClasses[$t])) {
        foreach ($idClasses[$t] as $class) {
            if (!isset($toggled[$class])) {
                $toggled[$class] = $toggled[$t] . ' via ' . $t;
            }
        }
    }
}

ok(count($toggled) > 10,
    'the audit found the places hidden is toggled or authored (' . count($toggled) . ' selectors across ' . count($js) . ' JS files)',
    $pass, $fail, $errors);

// ------------------------------------------------------- the named exemptions
// Each of these is a decision, not a threshold. Anything else that CSS displays
// while JS hides it is a bug the audit reports.
$exempt = array(
    '.d26-chat-expand' => 'injected with hidden=true and revealed by Desktop 2026 CSS by design; the base rule hides it in Classic',
    '.d26-chat-resize' => 'same injected desktop-only control, hidden by the base rule in Classic',
);

// --------------------------------------------------------------- the verdict

$violations = array();
foreach ($rules as $rule) {
    $token = rule_violation($rule, $toggled, $guarded, $exempt);
    if ($token !== null) {
        $violations[] = $token . ' (' . $rule['file'] . ':' . $rule['line'] . ', hidden at ' . $toggled[$token] . ')';
    }
}

ok(empty($violations),
    'every element JS hides with the hidden attribute is hidden by CSS: ' . implode('; ', $violations),
    $pass, $fail, $errors);

// ---------------------------------------------------------------- the control
// A guard that cannot fail is not a guard. Prove the detection works on a
// synthetic case, so a refactor that empties $rules or $toggled fails here
// rather than passing the sweep above by finding nothing to look at.
$probeRule = array('selector' => '.hidden-probe', 'body' => 'display: flex;', 'file' => 'probe.css', 'line' => 1);
ok(rule_violation($probeRule, array('.hidden-probe' => 'probe.js:1'), array(), array()) === '.hidden-probe',
    'the audit flags a rule that displays an element the JS hides',
    $pass, $fail, $errors);
ok(rule_violation($probeRule, array('.hidden-probe' => 'probe.js:1'), array('.hidden-probe' => 'guard.css:1'), array()) === null,
    'and accepts the same rule once a [hidden] guard exists',
    $pass, $fail, $errors);

// ------------------------------------------------------- the ones that shipped
// Pinned by name: each is a bug that reached the operator, and removing its
// guard has to fail loudly here rather than showing up as another "overlay".
foreach (array('.bs-empty', '.notif-badge', '.t3d-popup', '.d26-floor') as $token) {
    ok(isset($guarded[$token]),
        $token . ' keeps its [hidden] guard (found at ' . (isset($guarded[$token]) ? $guarded[$token] : 'nowhere') . ')',
        $pass, $fail, $errors);
}

// ------------------------------------------------------------------- report
echo str_repeat('-', 60) . "\n";
if ($fail) {
    echo implode("\n", $errors) . "\n";
    echo $fail . ' failed, ' . $pass . ' passed' . "\n";
    exit(1);
}
echo $pass . ' passed' . "\n";
