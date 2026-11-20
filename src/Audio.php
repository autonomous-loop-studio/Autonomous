<?php
/*
 * Copyright 2026 M. Bryce Hudson
 * SPDX-License-Identifier: Apache-2.0
 */

// Audio — speech synthesis and transcription, proxied server-side.
//
// Why a proxy at all: the browser cannot call these endpoints directly (CORS
// on both providers), and routing through the server means a provider's base
// URL is never handed to client-side code that could retarget it. Keys are
// passed through per request and never written to disk, exactly like the chat
// relay in ModelManager.
//
// Only allowlisted hosts and only audio paths are reachable. The path check
// is the important half: without it, the localhost entry in the host list
// would turn this into an open proxy against anything listening on the
// machine. A custom endpoint may additionally point at the LAN (a GPU box
// running a local TTS server): the path check still applies, so only the
// audio paths are reachable there too.
namespace Src;

class Audio {
    /** Hosts this class will ever contact. */
    private static $hostAllow = [
        'api.openai.com',
        'api.groq.com',
        'localhost',
        '127.0.0.1',
        '::1',
    ];

    /** Paths, per host family, that carry audio. Nothing else is reachable. */
    private static $pathAllow = [
        '/v1/audio/speech',
        '/openai/v1/audio/speech',
        '/v1/audio/transcriptions',
        '/openai/v1/audio/transcriptions',
    ];

    /** OpenAI caps `input` at 4096 characters; stay under so a long agent
     *  reply is chunked by the caller rather than rejected upstream. */
    const MAX_CHARS = 4000;

    /** Uploads beyond this are refused before any bytes leave the host. */
    const MAX_UPLOAD = 25 * 1024 * 1024;

    /**
     * Per-provider endpoints, voices and defaults.
     *
     * Only providers with a real OpenAI-compatible audio API appear here.
     * OpenRouter and NVIDIA are chat-only and are deliberately absent, so the
     * settings picker can never offer an endpoint that will 404.
     *
     * `speech` says whether the provider can still synthesize. Groq's PlayAI
     * models were decommissioned, so it now transcribes but cannot speak —
     * flagged rather than left to fail at request time.
     */
    public static function catalogue() {
        return [
            'openai' => [
                'label' => 'OpenAI',
                'speech' => true,
                'speech_error' => '',
                'base' => 'https://api.openai.com/v1',
                'speech_model' => 'tts-1',
                'stt' => 'whisper-1',
                'voice' => 'alloy',
                'voices' => [
                    'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
                    'nova', 'onyx', 'sage', 'shimmer',
                ],
            ],
            'groq' => [
                'label' => 'Groq',
                'speech' => false,
                'speech_error' => 'Groq decommissioned its PlayAI text-to-speech models, '
                    . 'so Groq can transcribe speech but cannot synthesize it. '
                    . 'Use OpenAI for reading replies aloud.',
                'base' => 'https://api.groq.com/openai/v1',
                'speech_model' => '',
                'stt' => 'whisper-large-v3',
                'voice' => '',
                'voices' => [],
            ],
        ];
    }

    /** Public shape for the settings picker: no secrets, no endpoints. */
    public static function capabilities() {
        $out = [];
        foreach (self::catalogue() as $id => $p) {
            $out[$id] = [
                'label' => $p['label'],
                'speech' => (bool)$p['speech'],
                'speech_error' => $p['speech_error'],
                'speech_model' => $p['speech_model'],
                'stt_model' => $p['stt'],
                'voices' => $p['voices'],
                'default_voice' => $p['voice'],
            ];
        }
        return $out;
    }

    /**
     * Resolve the base URL for a provider, then hold it to the allowlist.
     *
     * An endpoint override is honoured (that is how a local TTS server gets
     * used) but only ever after the same host+path check, so an override can
     * redirect to a different allowed host and nothing else.
     *
     * @return string base URL with no trailing slash, e.g. .../v1
     * @throws \RuntimeException when the provider is unknown or not allowed
     */
    public static function baseFor($provider, $endpoint = '') {
        $catalogue = self::catalogue();
        $id = (string)$provider;
        if (!isset($catalogue[$id])) {
            throw new \RuntimeException(
                'Unknown audio provider "' . $id . '". Supported: '
                . implode(', ', array_keys($catalogue)) . '.'
            );
        }

        $base = $catalogue[$id]['base'];
        if ($endpoint !== '') {
            $endpoint = rtrim(trim($endpoint), '/');
            // A chat endpoint was pasted here: take everything up to /chat and
            // /completions so the audio path hangs off the same base.
            $endpoint = preg_replace('#/(chat/completions|messages)$#', '', $endpoint);
            $base = $endpoint;
        }

        $parts = parse_url($base);
        if (!$parts || empty($parts['host']) || empty($parts['scheme'])) {
            throw new \RuntimeException('Audio endpoint is not a valid URL.');
        }
        $host = strtolower($parts['host']);
        // A custom endpoint may point at another box on the LAN — a GPU host
        // running a local OpenAI-compatible TTS server — which is never on
        // the host allowlist. The same canonical local-network check the TLS
        // policy and the chat relay's LAN-runner rule use decides, and the
        // audio-path check below stays the SSRF guard either way.
        $localOverride = $endpoint !== '' && Tls::isLocalUrl($base);
        if (!in_array($host, self::$hostAllow, true) && !$localOverride) {
            throw new \RuntimeException(
                'Audio host "' . $host . '" is not allowed. Permitted: '
                . implode(', ', self::$hostAllow) . ' plus local-network hosts as a custom endpoint.'
            );
        }
        $scheme = strtolower($parts['scheme']);
        $isLoopback = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
        // Plain http never crosses the public internet from loopback or the
        // LAN, so it is fine there, exactly as the TLS AUTO policy holds.
        if ($scheme !== 'https' && !$isLoopback && !$localOverride) {
            throw new \RuntimeException('Audio endpoint must use https.');
        }

        $path = isset($parts['path']) ? rtrim($parts['path'], '/') : '';
        // /v1 -> /v1/audio/speech  ✓      /openai/v1 -> /openai/v1/audio/speech ✓
        $candidate = $path . '/audio/speech';
        $ok = false;
        foreach (self::$pathAllow as $allowed) {
            if ($candidate === $allowed) { $ok = true; break; }
        }
        if (!$ok) {
            throw new \RuntimeException(
                'Audio path "' . $candidate . '" is not allowed. Permitted: '
                . implode(', ', self::$pathAllow) . '.'
            );
        }

        $port = isset($parts['port']) ? ':' . $parts['port'] : '';
        return $scheme . '://' . $host . $port . $path;
    }

    /** Absolute URL for one of the two allowed audio operations. */
    private static function urlFor($base, $op) {
        $suffix = ($op === 'speech') ? '/audio/speech' : '/audio/transcriptions';
        $url = $base . $suffix;
        $path = parse_url($url, PHP_URL_PATH);
        if (!in_array($path, self::$pathAllow, true)) {
            throw new \RuntimeException('Audio path "' . $path . '" is not allowed.');
        }
        return $url;
    }

    private static function authHeaders($apiKey) {
        $headers = ['Content-Type: application/json', 'Accept: audio/mpeg'];
        if ($apiKey !== '') {
            $headers[] = 'Authorization: Bearer ' . $apiKey;
        }
        return $headers;
    }

    /** Turn a curl/HTTP failure into something a person can act on. */
    private static function explain($response, $httpCode) {
        $decoded = json_decode((string)$response, true);
        $detail = '';
        if (is_array($decoded)) {
            $err = $decoded['error'] ?? null;
            if (is_array($err)) {
                $detail = (string)($err['message'] ?? $err['type'] ?? '');
            } elseif (is_string($err)) {
                $detail = $err;
            }
        }
        if ($detail === '') {
            $detail = substr(preg_replace('/\s+/', ' ', (string)$response), 0, 240);
        }
        if ($detail === '') {
            $detail = 'no response body';
        }
        // 401/403 almost always means the key exists but has no audio access,
        // which is worth saying plainly rather than surfacing as a raw 403.
        if ($httpCode === 401 || $httpCode === 403) {
            return 'Provider rejected the key for audio (' . $httpCode . '): ' . $detail;
        }
        return 'Provider error ' . $httpCode . ': ' . $detail;
    }

    /**
     * Synthesize speech.
     *
     * @return array {audio: string, mime: string} on success, {error: string} on
     *         failure. Binary audio, not JSON, is why this returns raw bytes.
     */
    public static function speak($spec) {
        $catalogue = self::catalogue();
        $provider = (string)($spec['provider'] ?? 'openai');
        if (!isset($catalogue[$provider])) {
            return ['error' => 'Unknown audio provider "' . $provider . '".'];
        }

        $text = trim((string)($spec['text'] ?? ''));
        if ($text === '') {
            return ['error' => 'Nothing to speak.'];
        }
        // Fail fast and say why, rather than spending a request to be told
        // the model no longer exists.
        if (!$catalogue[$provider]['speech']) {
            return ['error' => $catalogue[$provider]['speech_error']];
        }
        if (self::strlen_safe($text) > self::MAX_CHARS) {
            return ['error' => 'Text is ' . self::strlen_safe($text)
                . ' characters; the limit is ' . self::MAX_CHARS . '. Split it into sentences.'];
        }

        try {
            $base = self::baseFor($provider, $spec['endpoint'] ?? '');
        } catch (\RuntimeException $e) {
            return ['error' => $e->getMessage()];
        }

        $hasCustomEndpoint = trim((string)($spec['endpoint'] ?? '')) !== '';
        if ($hasCustomEndpoint) {
            $spec['api_key'] = '';
        }

        // A custom endpoint (a local OpenAI-compatible TTS server) may sit
        // behind a strict validator that rejects blank fields. The catalogue
        // already supplies the cloud defaults below; when those are still
        // blank, fall back to the OpenAI canonical pair so the request is
        // accepted as-is. Providers without an endpoint override are untouched.

        // A whitespace-only model is blank, not a name: trim first so the
        // strict local servers behind a custom endpoint never see a field of
        // spaces where a model belongs.
        $model = trim((string)($spec['model'] ?? ''));
        if ($model === '') {
            $model = $catalogue[$provider]['speech_model'];
        }
        if ($model === '' && $hasCustomEndpoint) {
            $model = 'tts-1';
        }

        $voice = (string)($spec['voice'] ?? '');
        $voiceList = $catalogue[$provider]['voices'];
        if ($hasCustomEndpoint) {
            // A local server has its own voice names, so a custom voice passes
            // through as-is; only a blank one gets the canonical default.
            if (trim($voice) === '') {
                $voice = 'alloy';
            }
        } elseif ($voice === '' || !in_array($voice, $voiceList, true)) {
            $voice = $catalogue[$provider]['voice'];
        }

        $speed = isset($spec['speed']) ? (float)$spec['speed'] : 1.0;
        if ($speed < 0.25) { $speed = 0.25; }
        if ($speed > 4.0) { $speed = 4.0; }

        $payload = [
            'model' => $model,
            'input' => $text,
            'voice' => $voice,
            'response_format' => 'mp3',
        ];
        // Groq rejects the speed field on playai-tts; OpenAI honours it. Sending
        // it only when it actually differs from 1 keeps both happy.
        if (abs($speed - 1.0) > 0.001) {
            $payload['speed'] = $speed;
        }

        $ttsUrl = self::urlFor($base, 'speech');
        $ch = curl_init($ttsUrl);
        // Cloud speech goes through the operator's proxy too, like every other
        // outbound agent call.
        $ap = Sandbox::activeProxy();
        if ($ap !== '') {
            curl_setopt($ch, CURLOPT_PROXY, $ap);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, self::authHeaders($spec['api_key'] ?? ''));
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 60);
        Tls::apply($ch, $ttsUrl);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false); // never chase a redirect off-host
        $response = curl_exec($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            return ['error' => 'Speech request failed: ' . ($curlErr !== '' ? $curlErr : 'unknown network error')];
        }
        if ($httpCode >= 400) {
            return ['error' => self::explain($response, $httpCode)];
        }
        if ($response === '') {
            return ['error' => 'Provider returned no audio.'];
        }

        return ['audio' => $response, 'mime' => 'audio/mpeg'];
    }

    /**
     * Transcribe an uploaded recording.
     *
     * @param $spec file: array from $_FILES, with tmp_name/type/name.
     * @return array {text: string} or {error: string}
     */
    public static function transcribe($spec) {
        $catalogue = self::catalogue();
        $provider = (string)($spec['provider'] ?? 'openai');
        if (!isset($catalogue[$provider])) {
            return ['error' => 'Unknown audio provider "' . $provider . '".'];
        }

        $file = $spec['file'] ?? null;
        if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file($file['tmp_name'])) {
            return ['error' => 'No audio file was uploaded.'];
        }
        $size = (int)@filesize($file['tmp_name']);
        if ($size <= 0) {
            return ['error' => 'The uploaded audio file is empty.'];
        }
        if ($size > self::MAX_UPLOAD) {
            return ['error' => 'Recording is too large (' . round($size / 1048576, 1)
                . ' MB); the limit is ' . round(self::MAX_UPLOAD / 1048576) . ' MB.'];
        }

        try {
            $base = self::baseFor($provider, $spec['endpoint'] ?? '');
        } catch (\RuntimeException $e) {
            return ['error' => $e->getMessage()];
        }

        if (trim((string)($spec['endpoint'] ?? '')) !== '') {
            $spec['api_key'] = '';
        }

        $fields = [
            'model' => (string)($spec['model'] ?? '') ?: $catalogue[$provider]['stt'],
            'file' => new \CURLFile(
                $file['tmp_name'],
                $file['type'] ?: 'audio/webm',
                $file['name'] ?: 'recording.webm'
            ),
        ];
        $language = trim((string)($spec['language'] ?? ''));
        if ($language !== '') {
            $fields['language'] = $language;
        }
        $prompt = trim((string)($spec['prompt'] ?? ''));
        if ($prompt !== '') {
            $fields['prompt'] = $prompt;
        }

        $headers = [];
        if (($spec['api_key'] ?? '') !== '') {
            $headers[] = 'Authorization: Bearer ' . $spec['api_key'];
        }

        $sttUrl = self::urlFor($base, 'transcriptions');
        $ch = curl_init($sttUrl);
        // Cloud speech goes through the operator's proxy too, like every other
        // outbound agent call.
        $ap = Sandbox::activeProxy();
        if ($ap !== '') {
            curl_setopt($ch, CURLOPT_PROXY, $ap);
            curl_setopt($ch, CURLOPT_PROXYTYPE, CURLPROXY_HTTP);
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $fields); // array form = multipart
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 120);
        Tls::apply($ch, $sttUrl);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        $response = curl_exec($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            return ['error' => 'Transcription request failed: ' . ($curlErr !== '' ? $curlErr : 'unknown network error')];
        }
        if ($httpCode >= 400) {
            return ['error' => self::explain($response, $httpCode)];
        }

        $decoded = json_decode((string)$response, true);
        $text = is_array($decoded) ? (string)($decoded['text'] ?? '') : '';
        if ($text === '') {
            return ['error' => 'Provider returned no transcript.'];
        }
        return ['text' => $text];
    }

    private static function strlen_safe($s) {
        return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
    }
}