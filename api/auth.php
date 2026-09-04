<?php
// api/auth.php
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

// Detect HTTPS automatically so cookies get the "secure" flag on your real
// site (required for it to matter) but still work over plain HTTP on
// localhost/XAMPP during development.
$isSecure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['SERVER_PORT'] ?? '') == 443)
    || ((!empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');

$action = $_GET['action'] ?? '';

// ── LOGOUT ──────────────────────────────────────────────
if ($action === 'logout') {
    session_start();
    session_unset();
    session_destroy();
    setcookie('crm_remember', '', time() - 3600, '/', '', $isSecure, true);
    jsonOut(['success' => true]);
}

// ── CHECK SESSION ────────────────────────────────────────
if ($action === 'check') {
    session_start();

    $pdo = getDB();
    try { $pdo->exec("ALTER TABLE users ADD COLUMN remember_token TEXT DEFAULT NULL"); } catch(Exception $e) {}
    try { $pdo->exec("ALTER TABLE users ADD COLUMN token_expires DATETIME DEFAULT NULL"); } catch(Exception $e) {}

    if (!empty($_SESSION['userid'])) {
        jsonOut([
            'logged_in' => true,
            'userid'    => (int)$_SESSION['userid'],
            'username'  => $_SESSION['username'],
        ]);
    }

    $token = $_COOKIE['crm_remember'] ?? '';
    if ($token) {
        $stmt = $pdo->prepare("SELECT uid, username FROM users WHERE remember_token = ? AND token_expires > ? LIMIT 1");
        $stmt->execute([$token, date('Y-m-d H:i:s')]);
        $user = $stmt->fetch();
        if ($user) {
            $_SESSION['userid']   = $user['uid'];
            $_SESSION['username'] = $user['username'];
            jsonOut([
                'logged_in' => true,
                'userid'    => (int)$user['uid'],
                'username'  => $user['username'],
            ]);
        }
    }

    jsonOut(['logged_in' => false]);
}

// ── LOGIN ────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'login') {
    $body     = jsonIn();
    $username = trim($body['username'] ?? '');
    $password = $body['password'] ?? '';
    $remember = !empty($body['remember']);

    if (!$username || !$password) {
        jsonOut(['success' => false, 'error' => 'Username and password are required.'], 400);
    }

    $pdo = getDB();

    // ── Ensure brute-force table exists ──────────────────
    $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT NOT NULL,
        ip         TEXT NOT NULL,
        attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )");

    // ── Ensure schema is up to date ──────────────────────
    try { $pdo->exec("ALTER TABLE users ADD COLUMN remember_token TEXT DEFAULT NULL"); } catch(Exception $e) {}
    try { $pdo->exec("ALTER TABLE users ADD COLUMN token_expires DATETIME DEFAULT NULL"); } catch(Exception $e) {}

    $ip          = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $maxAttempts = 5;
    $lockMinutes = 15;
    $lockWindow  = date('Y-m-d H:i:s', time() - ($lockMinutes * 60));

    // ── Count recent failed attempts for this username OR ip ──
    $stmt = $pdo->prepare("
        SELECT COUNT(*) FROM login_attempts
        WHERE (username = ? OR ip = ?) AND attempted_at > ?
    ");
    $stmt->execute([$username, $ip, $lockWindow]);
    $attempts = (int)$stmt->fetchColumn();

    if ($attempts >= $maxAttempts) {
        jsonOut([
            'success' => false,
            'error'   => "Too many failed attempts. Please try again after {$lockMinutes} minutes.",
            'locked'  => true,
        ], 429);
    }

    // ── Fetch user ───────────────────────────────────────
    $stmt = $pdo->prepare("SELECT uid, username, password FROM users WHERE username = ? LIMIT 1");
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user) {
        // Record attempt even for unknown usernames (prevents username enumeration)
        $pdo->prepare("INSERT INTO login_attempts (username, ip, attempted_at) VALUES (?, ?, ?)")->execute([$username, $ip, date('Y-m-d H:i:s')]);
        jsonOut(['success' => false, 'error' => 'Invalid username or password.'], 401);
    }

    // ── Verify password (supports legacy plain-text + MD5 → bcrypt upgrade) ──
    $valid = false;
    if (password_verify($password, $user['password'])) {
        $valid = true;
    } elseif ($user['password'] === $password || $user['password'] === md5($password)) {
        $valid = true;
        $hash  = password_hash($password, PASSWORD_DEFAULT);
        $pdo->prepare("UPDATE users SET password = ? WHERE uid = ?")->execute([$hash, $user['uid']]);
    }

    if (!$valid) {
        // Record this failed attempt
        $pdo->prepare("INSERT INTO login_attempts (username, ip, attempted_at) VALUES (?, ?, ?)")->execute([$username, $ip, date('Y-m-d H:i:s')]);

        // Tell user how many tries remain
        $remaining = $maxAttempts - ($attempts + 1);
        $msg = $remaining > 0
            ? "Invalid username or password. {$remaining} attempt(s) remaining."
            : "Too many failed attempts. Please try again after {$lockMinutes} minutes.";

        jsonOut(['success' => false, 'error' => $msg], 401);
    }

    // ── Login success — clear all past attempts for this user ──
    $pdo->prepare("DELETE FROM login_attempts WHERE username = ? OR ip = ?")->execute([$username, $ip]);

    // ── Start session ────────────────────────────────────
    $normalTTL = 13 * 60 * 60;
    session_set_cookie_params([
        'lifetime' => $normalTTL,
        'path'     => '/',
        'secure'   => $isSecure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
    session_regenerate_id(true);
    $_SESSION['userid']   = $user['uid'];
    $_SESSION['username'] = $user['username'];

    if ($remember) {
        $token   = bin2hex(random_bytes(32));
        $expires = date('Y-m-d H:i:s', time() + (3 * 24 * 60 * 60));
        $pdo->prepare("UPDATE users SET remember_token = ?, token_expires = ? WHERE uid = ?")
            ->execute([$token, $expires, $user['uid']]);
        setcookie('crm_remember', $token, time() + (3 * 24 * 60 * 60), '/', '', $isSecure, true);
    } else {
        $pdo->prepare("UPDATE users SET remember_token = NULL, token_expires = NULL WHERE uid = ?")
            ->execute([$user['uid']]);
        setcookie('crm_remember', '', time() - 3600, '/', '', $isSecure, true);
    }

    jsonOut([
        'success'  => true,
        'userid'   => (int)$user['uid'],
        'username' => $user['username'],
    ]);
}

jsonOut(['error' => 'Invalid request'], 400);