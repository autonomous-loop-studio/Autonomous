<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom TTS endpoint payload: custom model/voice pass through, blanks fill.
 *
 * Usage: php tests/php/audio.test.php
 *
 * A custom endpoint is usually a local OpenAI-compatible TTS server with its
 * own model and voice names. Two regressions lived here:
 *
 *   - speak() validated the voice against the cloud provider's voice list even
 *     for custom-endpoint requests, so a local voice name was silently
 *     replaced with the catalogue default before it ever reached the server.
 *   - a whitespace-only model is truthy in PHP, so '   ' sailed past the
 *     blank check and reached strict local servers that reject blank fields
 *     instead of defaulting them.
 *
 * The rule now: with a custom endpoint set, the configured model and voice go
 * out exactly as given, and only a blank (or whitespace-only) one is filled
 * with the OpenAI canonical pair tts-1/alloy. Without a custom endpoint the
 * provider catalogue validation applies exactly as before.
 *
 * The test boots a mock TTS server on loopback (`php -S`) that records each
 * request body, then calls Audio::speak() against it and asserts on what was
 * actually sent. The cloud-validation half needs no network: unknown
 * provider, empty text and Groq's speech flag all return before any request.
 *
 * Exits 0 on success, 1 on any failure.
 */

$root = dirname(__DIR__, 2);
require $root . '/autoload.php';

use Src\Audio;

$pass = 0;
$fail = 0;
$errors = array();

function ok($cond, $name)
{
    global $pass, $fail, $errors;
    if ($cond) {
        $pass++;
        return true;
    }
    $fail++;
    $errors[] = 'FAIL: ' . $name;
    return false;
}

echo "custom TTS endpoint payload tests\n";
echo str_repeat('-', 60) . "\n";

if (!function_exists('proc_open')) {
    echo "  SKIP: proc_open is disabled, cannot start a mock TTS server\n";
    echo "0 passed, 0 failed\n";
    exit(0);
}
if (!function_exists('curl_init')) {
    echo "  SKIP: curl is unavailable, speak() cannot run\n";
    echo "0 passed, 0 failed\n";
    exit(0);
}

require_once __DIR__ . '/free-port.php';

// --- mock server -----------------------------------------------------------
$tmp = rtrim(str_replace('\\', '/', sys_get_temp_dir()), '/') . '/router-audio-test-' . getmypid();
@mkdir($tmp, 0777, true);
$capture = $tmp . '/last-body.json';
@unlink($capture);

// Isolate the test from the operator's own config: an active proxy there
// would route even this loopback request through it, and the test would
// assert on the proxy's refusal instead of the mock server's recording.
file_put_contents($tmp . '/config.json', json_encode(array('proxy_active' => '')));
putenv('ROUTER_CONFIG=' . $tmp . '/config.json');

$router = $tmp . '/router.php';
file_put_contents($router, <<<'PHP'
<?php
// Mock OpenAI-compatible TTS server: record the request, answer with audio.
$capture = getenv('TTS_CAPTURE_FILE');
if (is_string($capture) && $capture !== '') {
    @file_put_contents($capture, file_get_contents('php://input'));
}
header('Content-Type: audio/mpeg');
echo 'FAKEAUDIOBYTES';
PHP
);

$log = $tmp . '/server.log';
$proc = null;
$port = 0;

$stop = function () use (&$proc, $log, $router, $capture) {
    if (is_resource($proc)) {
        @proc_terminate($proc);
        @proc_close($proc);
        $proc = null;
    }
    foreach (array($router, $capture, $log, dirname($router) . '/config.json') as $f) {
        @unlink($f);
    }
    $dir = dirname($router);
    @rmdir($dir);
};
// A fatal error or an early exit must not leave a server on the port.
register_shutdown_function($stop);

// Two attempts: the picked port is free, but another process can take it in
// between, and a busy port is environmental, not a failure of this file.
for ($attempt = 1; $attempt <= 2 && $port === 0; $attempt++) {
    $p = free_port();
    if (!$p) {
        break;
    }
    $cmd = array(PHP_BINARY, '-S', '127.0.0.1:' . $p, $router);
    // Inherit the whole environment: a bare one-variable env breaks socket
    // setup on Windows (Winsock reads SystemRoot), and the server then fails
    // to listen with no useful reason.
    $env = getenv();
    if (!is_array($env)) {
        $env = array();
    }
    $env['TTS_CAPTURE_FILE'] = $capture;
    $proc = @proc_open($cmd, array(1 => array('file', $log, 'a'), 2 => array('file', $log, 'a')), $pipes, $tmp, $env);
    if (!is_resource($proc)) {
        continue;
    }
    $deadline = microtime(true) + 8.0;
    while (microtime(true) < $deadline) {
        $raw = (string) @file_get_contents('http://127.0.0.1:' . $p . '/v1/audio/speech');
        if ($raw === 'FAKEAUDIOBYTES') {
            $port = $p;
            break;
        }
        usleep(100000);
    }
    if ($port === 0) {
        @proc_terminate($proc);
        @proc_close($proc);
        $proc = null;
    }
}

if ($port === 0) {
    echo "  SKIP: could not start a mock TTS server on a loopback port\n";
    if (is_file($log)) {
        foreach (array_slice(explode("\n", (string) @file_get_contents($log)), 0, 4) as $line) {
            if (trim($line) !== '') {
                echo '        ' . trim($line) . "\n";
            }
        }
    }
    echo "0 passed, 0 failed\n";
    exit(0);
}

$endpoint = 'http://127.0.0.1:' . $port . '/v1';
@unlink($capture);

/** Speak through the mock server and return the JSON payload it received. */
function spoke($endpoint, $model, $voice)
{
    global $capture;
    @unlink($capture);
    $result = Audio::speak(array(
        'provider' => 'openai',
        'endpoint' => $endpoint,
        'api_key' => 'test-key',
        'model' => $model,
        'voice' => $voice,
        'text' => 'Hello there.',
    ));
    if (!isset($result['audio']) || $result['audio'] !== 'FAKEAUDIOBYTES') {
        return array(null, $result);
    }
    $raw = is_file($capture) ? (string) @file_get_contents($capture) : '';
    return array(json_decode($raw, true), $result);
}

// --- custom names pass through as-is ---------------------------------------
list($body) = spoke($endpoint, 'my-model', 'my-voice');
ok(is_array($body), 'custom endpoint: the request reaches the server');
ok(($body['model'] ?? null) === 'my-model', 'custom endpoint: a custom model passes through as-is');
ok(($body['voice'] ?? null) === 'my-voice', 'custom endpoint: a custom voice passes through as-is');

// A name outside the cloud catalogue must survive too: that coercion was the
// regression, and the catalogue list cannot contain every local voice.
list($body) = spoke($endpoint, 'xtts-v2', 'custom-voice-1');
ok(($body['model'] ?? null) === 'xtts-v2', 'custom endpoint: a non-catalogue model passes through as-is');
ok(($body['voice'] ?? null) === 'custom-voice-1', 'custom endpoint: a non-catalogue voice is not coerced to alloy');

// --- blanks fill with the canonical pair ------------------------------------
list($body) = spoke($endpoint, '', '');
ok(($body['model'] ?? null) === 'tts-1', 'custom endpoint: a blank model fills with tts-1');
ok(($body['voice'] ?? null) === 'alloy', 'custom endpoint: a blank voice fills with alloy');

// --- whitespace-only counts as blank -----------------------------------------
list($body) = spoke($endpoint, '   ', '  ');
ok(($body['model'] ?? null) === 'tts-1', 'custom endpoint: a whitespace-only model fills with tts-1');
ok(($body['voice'] ?? null) === 'alloy', 'custom endpoint: a whitespace-only voice fills with alloy');

// --- cloud validation is unchanged (no network: all fail before any) ---------
$r = Audio::speak(array('provider' => 'no-such-provider', 'text' => 'Hello.'));
ok(isset($r['error']) && stripos($r['error'], 'Unknown audio provider') !== false, 'cloud: an unknown provider is still refused');

$r = Audio::speak(array('provider' => 'openai', 'endpoint' => $endpoint, 'text' => '   '));
ok(isset($r['error']) && $r['error'] === 'Nothing to speak.', 'cloud: blank text is still refused before any request');

$r = Audio::speak(array('provider' => 'groq', 'endpoint' => $endpoint, 'text' => 'Hello.'));
ok(isset($r['error']) && stripos($r['error'], 'transcribe') !== false, 'cloud: Groq still reports speech as unavailable');

echo str_repeat('-', 60) . "\n";
foreach ($errors as $e) { echo $e . "\n"; }
echo "audio: {$pass} passed, {$fail} failed\n";
exit($fail ? 1 : 0);
