<?php
// config/helpers.php

date_default_timezone_set('Asia/Kolkata'); 

function jsonOut(array $data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
    } else {
        header('Access-Control-Allow-Origin: *');
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function jsonIn(): array {
    $raw = file_get_contents('php://input');
    return json_decode($raw, true) ?: [];
}

// ── Require a logged-in session, else stop the request with 401 ───────
// Mirrors the check dashboard.php already used, so behavior is unchanged
// for that endpoint and consistent everywhere else. Uses whatever PDO
// connection the caller already has open. Must be called after
// session_start().
function requireAuth(PDO $pdo): void {
    if (empty($_SESSION['userid'])) {
        // Try remember-me cookie before giving up
        $token = $_COOKIE['crm_remember'] ?? '';
        if ($token) {
            $stmt = $pdo->prepare("SELECT uid, username FROM users WHERE remember_token = ? AND token_expires > datetime('now') LIMIT 1");
            $stmt->execute([$token]);
            $user = $stmt->fetch();
            if ($user) {
                $_SESSION['userid']   = $user['uid'];
                $_SESSION['username'] = $user['username'];
            }
        }
    }

    if (empty($_SESSION['userid'])) {
        jsonOut(['error' => 'Unauthorized', 'redirect' => 'login.html'], 401);
    }
}

function today(): string {
    return date('Y-m-d');
}

// ── Bump last_modified timestamp ──────────────────────────────────────
function bumpSync(PDO $pdo): void {
    try {
        $pdo->exec("CREATE TABLE IF NOT EXISTS sync_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )");
        $now  = date('Y-m-d H:i:s');
        $stmt = $pdo->prepare("INSERT INTO sync_meta (key, value)
                               VALUES ('last_modified', ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        $stmt->execute([$now]);
    } catch (Exception $e) {}
}

function logAction(PDO $pdo, string $message): void {
    try {
        // Create table with user column
        $pdo->exec("CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL,
            user TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )");

        // Auto-migrate: add user column to existing tables that don't have it
        try {
            $cols = array_column($pdo->query("PRAGMA table_info(logs)")->fetchAll(), 'name');
            if (!in_array('user', $cols)) {
                $pdo->exec("ALTER TABLE logs ADD COLUMN user TEXT DEFAULT NULL");
            }
        } catch (Exception $e) {}

        // Get current logged-in user from session
        if (session_status() === PHP_SESSION_NONE) session_start();
        $user = $_SESSION['username'] ?? $_SESSION['user'] ?? 'unknown';

        $stmt = $pdo->prepare("INSERT INTO logs (message, user) VALUES (?, ?)");
        $stmt->execute([$message, $user]);

        // Every log = a write action, so bump sync timestamp too
        bumpSync($pdo);
    } catch(Exception $e) {}
}