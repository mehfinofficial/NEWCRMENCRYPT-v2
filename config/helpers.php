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
            $stmt = $pdo->prepare("SELECT uid, username FROM users WHERE remember_token = ? AND token_expires > ? LIMIT 1");
            $stmt->execute([$token, date('Y-m-d H:i:s')]);
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

        $stmt = $pdo->prepare("INSERT INTO logs (message, user, created_at) VALUES (?, ?, ?)");
        $stmt->execute([$message, $user, date('Y-m-d H:i:s')]);

        // Every log = a write action, so bump sync timestamp too
        bumpSync($pdo);
    } catch(Exception $e) {}
}

// ── ROLE-BASED ACCESS CONTROL ──────────────────────────────────────────
// Every permission a user can hold. This is the single source of truth —
// role presets below just pick starting values for these keys; the actual
// enforcement everywhere else always reads a user's own `permissions` row,
// never their role directly. That's what makes per-user overrides possible
// on top of a role "template".
const ALL_PERMISSION_KEYS = [
    'can_add_client', 'can_edit_client', 'can_delete_client',
    'can_add_record', 'can_edit_record', 'can_delete_record',
    'can_add_followup', 'can_edit_followup', 'can_delete_followup',
    'view_phone_clients', 'view_phone_renewals', 'view_phone_followups',
    'access_renewals', 'access_inactive_clients', 'access_add_transaction',
    'access_transaction_history', 'access_pending_records',
    'view_clients', 'view_records', 'view_followups', 'view_logs',
];

// Starting values applied when a user is created with a given role, or
// when an admin clicks "reset to role default" in Set User. After
// creation these are just normal per-user toggles — the role label
// itself is never checked anywhere except here and for display.
function getRolePermissionDefaults(string $role): array {
    $all = array_fill_keys(ALL_PERMISSION_KEYS, true);

    if ($role === 'admin') return $all;

    if ($role === 'support') {
        return array_merge($all, [
            'can_delete_client'   => false,
            'can_delete_record'   => false,
            'can_delete_followup' => false,
            'view_phone_clients'  => false, // cards + client detail modal
        ]);
    }

    if ($role === 'onsite') {
        return array_merge($all, [
            'can_edit_client'     => false, 'can_delete_client'   => false,
            'can_edit_record'     => false, 'can_delete_record'   => false,
            'can_edit_followup'   => false, 'can_delete_followup' => false,
            'view_phone_clients'  => false,
            'view_phone_renewals' => false,
            'view_phone_followups'=> false,
        ]);
    }

    if ($role === 'viewer') {
        return array_merge($all, [
            'can_add_client' => false, 'can_edit_client' => false, 'can_delete_client' => false,
            'can_add_record' => false, 'can_edit_record' => false, 'can_delete_record' => false,
            'can_add_followup' => false, 'can_edit_followup' => false, 'can_delete_followup' => false,
            'view_phone_clients'  => false,
            'view_phone_renewals' => false,
            'view_phone_followups'=> false,
        ]);
    }

    return $all; // unknown role → safest is full access, matches "admin" fallback used at login
}

// Auto-migrate: add role/permissions columns to `users`, and backfill any
// row that predates this feature (role IS NULL) as a full-access admin so
// nobody already using the app gets locked out on deploy.
function ensureUserPermissionColumns(PDO $pdo): void {
    try {
        $cols = array_column($pdo->query("PRAGMA table_info(users)")->fetchAll(), 'name');
        if (!in_array('role', $cols)) {
            $pdo->exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT NULL");
        }
        if (!in_array('permissions', $cols)) {
            $pdo->exec("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT NULL");
        }
        $needsBackfill = $pdo->query("SELECT uid FROM users WHERE role IS NULL OR permissions IS NULL")->fetchAll();
        if ($needsBackfill) {
            $json = json_encode(getRolePermissionDefaults('admin'));
            $stmt = $pdo->prepare("UPDATE users SET role = 'admin', permissions = ? WHERE uid = ?");
            foreach ($needsBackfill as $row) {
                $stmt->execute([$json, $row['uid']]);
            }
        }
    } catch (Exception $e) {}
}

// Reads the permissions for the given uid (defaults to the logged-in user).
// Always merges over ALL_PERMISSION_KEYS so a key added later in code
// safely defaults to true for existing users instead of being undefined.
function getUserPermissions(PDO $pdo, ?int $uid = null): array {
    ensureUserPermissionColumns($pdo);
    $uid = $uid ?? (int)($_SESSION['userid'] ?? 0);
    $stmt = $pdo->prepare("SELECT role, permissions FROM users WHERE uid = ? LIMIT 1");
    $stmt->execute([$uid]);
    $row = $stmt->fetch();
    if (!$row) return array_fill_keys(ALL_PERMISSION_KEYS, false);

    $stored = json_decode($row['permissions'] ?? '', true) ?: [];
    $base   = array_fill_keys(ALL_PERMISSION_KEYS, true);
    return array_merge($base, $stored);
}

function getUserRole(PDO $pdo, ?int $uid = null): string {
    ensureUserPermissionColumns($pdo);
    $uid = $uid ?? (int)($_SESSION['userid'] ?? 0);
    $stmt = $pdo->prepare("SELECT role FROM users WHERE uid = ? LIMIT 1");
    $stmt->execute([$uid]);
    return $stmt->fetchColumn() ?: 'viewer';
}

// Stops the request with 403 if the logged-in user lacks the given
// permission key. Call after requireAuth(). Mirrors requireAuth()'s
// jsonOut-and-exit style so callers don't need to check a return value.
function requirePermission(PDO $pdo, string $key): void {
    $perms = getUserPermissions($pdo);
    if (empty($perms[$key])) {
        jsonOut(['error' => 'Permission denied', 'permission_denied' => true, 'key' => $key], 403);
    }
}

// Returns $value unchanged if $allowed is true, otherwise null. Used to
// strip phone-number fields out of API responses server-side — hiding a
// field in the UI alone still leaves it visible in the raw network
// response, so the masking has to happen here, not just in app.js.
function maskPhone($value, bool $allowed) {
    return $allowed ? $value : null;
}

// ── ARCHIVES (30-day soft-delete recovery) ──────────────────────────────
// Table + column map for every soft-deletable entity. Single source of
// truth for archive.php's list/restore/purge actions, and for the
// automatic sweep below — add a new soft-deletable table here and all
// three actions pick it up without further changes.
const ARCHIVE_TABLES = [
    'clients'      => ['table' => 'clients',      'title' => 'clientname',  'subtitle' => 'firmname'],
    'transactions' => ['table' => 'transactions',  'title' => 'account',    'subtitle' => 'servicename'],
    'followups'    => ['table' => 'followup',      'title' => 'clientname', 'subtitle' => 'phonenumber'],
];

// Permanently removes anything that's been sitting in Archives for more
// than 30 days. No cron needed — this runs inline on ordinary traffic
// (auth.php's session check, hit once per page load/app open, plus
// archive.php itself whenever the Archives screen is opened) so the
// cleanup happens naturally without depending on hosting supporting
// scheduled tasks. Cheap no-op query on every other table, so calling it
// often costs nothing.
function purgeExpiredArchives(PDO $pdo): void {
    $cutoff = date('Y-m-d H:i:s', time() - 30 * 24 * 60 * 60);
    foreach (ARCHIVE_TABLES as $meta) {
        $table = $meta['table'];
        try {
            $cols = array_column($pdo->query("PRAGMA table_info($table)")->fetchAll(), 'name');
            if (!in_array('deleted_at', $cols)) continue;
            $pdo->prepare("DELETE FROM $table WHERE deleted_at IS NOT NULL AND deleted_at < ?")->execute([$cutoff]);
        } catch (Exception $e) {}
    }
}