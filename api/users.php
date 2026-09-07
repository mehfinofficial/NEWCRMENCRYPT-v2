<?php
// api/users.php — Add User / Set User screens.
// Everything here is admin-only, and that check is hard-coded (not a
// toggle) because letting a non-admin reach user management at all would
// let them grant themselves any permission — this is the one gate that
// can't itself be gated.
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);
ensureUserPermissionColumns($pdo);

if (getUserRole($pdo) !== 'admin') {
    jsonOut(['error' => 'Admin access required'], 403);
}

$method = $_SERVER['REQUEST_METHOD'];

// ── LIST USERS (for the Set User screen) ────────────────────────────────
if ($method === 'GET') {
    $rows = $pdo->query("SELECT uid, username, role, permissions FROM users ORDER BY username ASC")->fetchAll();
    $users = array_map(function ($row) {
        $stored = json_decode($row['permissions'] ?? '', true) ?: [];
        return [
            'uid'         => (int)$row['uid'],
            'username'    => $row['username'],
            'role'        => $row['role'] ?: 'viewer',
            'permissions' => array_merge(array_fill_keys(ALL_PERMISSION_KEYS, true), $stored),
        ];
    }, $rows);
    jsonOut(['users' => $users, 'permission_keys' => ALL_PERMISSION_KEYS]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';

    // ── ADD USER ─────────────────────────────────────────────────────
    if ($action === 'add') {
        $username = trim($body['username'] ?? '');
        $password = $body['password'] ?? '';
        $role     = $body['role'] ?? 'viewer';

        if (!$username || !$password) {
            jsonOut(['success' => false, 'error' => 'Username and password are required.'], 400);
        }
        if (strlen($password) < 6) {
            jsonOut(['success' => false, 'error' => 'Password must be at least 6 characters.'], 400);
        }
        if (!in_array($role, ['admin', 'support', 'onsite', 'viewer'], true)) {
            jsonOut(['success' => false, 'error' => 'Invalid role.'], 400);
        }

        $stmt = $pdo->prepare("SELECT uid FROM users WHERE username = ? LIMIT 1");
        $stmt->execute([$username]);
        if ($stmt->fetch()) {
            jsonOut(['success' => false, 'error' => 'That username is already taken.'], 409);
        }

        $hash        = password_hash($password, PASSWORD_DEFAULT);
        $permissions = json_encode(getRolePermissionDefaults($role));

        $stmt = $pdo->prepare("INSERT INTO users (username, password, role, permissions) VALUES (?, ?, ?, ?)");
        $stmt->execute([$username, $hash, $role, $permissions]);

        logAction($pdo, "Staff account created: {$username} ({$role})");
        jsonOut(['success' => true, 'uid' => (int)$pdo->lastInsertId()]);
    }

    // ── RESET A USER TO THEIR ROLE'S DEFAULT PERMISSIONS ────────────────
    if ($action === 'apply_role_preset') {
        $uid  = (int)($body['uid'] ?? 0);
        $role = $body['role'] ?? '';
        if (!$uid || !in_array($role, ['admin', 'support', 'onsite', 'viewer'], true)) {
            jsonOut(['success' => false, 'error' => 'Invalid uid or role.'], 400);
        }
        $permissions = json_encode(getRolePermissionDefaults($role));
        $pdo->prepare("UPDATE users SET role = ?, permissions = ? WHERE uid = ?")
            ->execute([$role, $permissions, $uid]);

        logAction($pdo, "Permissions reset to {$role} default for user #{$uid}");
        jsonOut(['success' => true]);
    }

    // ── SET INDIVIDUAL PERMISSION TOGGLES ───────────────────────────────
    if ($action === 'set_permissions') {
        $uid     = (int)($body['uid'] ?? 0);
        $changes = $body['permissions'] ?? [];
        if (!$uid || !is_array($changes)) {
            jsonOut(['success' => false, 'error' => 'Invalid uid or permissions.'], 400);
        }

        // Only accept known keys with boolean values — never trust the
        // request body's shape blindly for something that controls access.
        $changes = array_intersect_key($changes, array_flip(ALL_PERMISSION_KEYS));
        foreach ($changes as $k => $v) { $changes[$k] = (bool)$v; }

        $stmt = $pdo->prepare("SELECT permissions FROM users WHERE uid = ? LIMIT 1");
        $stmt->execute([$uid]);
        $row = $stmt->fetch();
        if (!$row) jsonOut(['success' => false, 'error' => 'User not found.'], 404);

        $current = json_decode($row['permissions'] ?? '', true) ?: [];
        $updated = array_merge($current, $changes);

        $pdo->prepare("UPDATE users SET permissions = ? WHERE uid = ?")
            ->execute([json_encode($updated), $uid]);

        logAction($pdo, "Permissions updated for user #{$uid}");
        jsonOut(['success' => true, 'permissions' => array_merge(array_fill_keys(ALL_PERMISSION_KEYS, true), $updated)]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);
