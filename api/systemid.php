<?php
// api/systemid.php — System ID Checker
//
// Looks a pasted system ID up against:
//   1. clients.system_id   — whoever currently holds it
//   2. transactions.systemid / transactions.new_systemid — every record
//      that ever recorded this ID as "the system ID on file at the time"
//      (support / renewal / install rows) or as the target of a System
//      Change. This is how an ID that has since moved to a different
//      client (or off a deleted one) still shows its trail.
//
// Errors are logged server-side, never shown to the browser — same policy
// as the rest of the API (see records.php).
ini_set('display_errors', 0);
ini_set('log_errors', 1);
error_reporting(E_ALL);
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo    = getDB();
requireAuth($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET' && isset($_GET['check'])) {
    $query = trim($_GET['check'] ?? '');
    if ($query === '') {
        jsonOut(['error' => 'System ID is required'], 400);
    }

    try {
        // ── Who currently holds this ID? (normally 0 or 1 clients, but we
        // return every match so a duplicate assignment surfaces as a flag
        // instead of silently picking one) ──────────────────────────────
        $stmt = $pdo->prepare("
            SELECT id, clientname, firmname, status, renewal_date,
                   software_type, software_version, created_at
            FROM clients
            WHERE system_id = ? COLLATE NOCASE
            ORDER BY id ASC
        ");
        $stmt->execute([$query]);
        $currentRows = $stmt->fetchAll();

        // For each holder, find "since when": the most recent System Change
        // transaction that moved them onto this ID. If there isn't one, the
        // ID has been theirs since the client record was created.
        $sinceStmt = $pdo->prepare("
            SELECT transdate FROM transactions
            WHERE account = ? AND new_systemid = ? COLLATE NOCASE
            ORDER BY transdate DESC, id DESC LIMIT 1
        ");
        $currentClients = [];
        foreach ($currentRows as $c) {
            $sinceStmt->execute([$c['clientname'], $query]);
            $changeDate = $sinceStmt->fetchColumn();
            $currentClients[] = [
                'id'               => (int)$c['id'],
                'clientname'       => $c['clientname'],
                'firmname'         => $c['firmname'],
                'status'           => (int)$c['status'],
                'renewal_date'     => $c['renewal_date'],
                'software_type'    => $c['software_type'],
                'software_version' => $c['software_version'],
                'since'            => $changeDate ?: $c['created_at'],
                'since_source'     => $changeDate ? 'system_change' : 'client_created',
            ];
        }

        // ── Full trail: every transaction that ever touched this ID, either
        // as the system ID on file at the time, or as a System Change target.
        // Left-joined to clients for the current firm name in case the
        // account the record was logged under has since been renamed or
        // removed. ─────────────────────────────────────────────────────────
        $histStmt = $pdo->prepare("
            SELECT t.id, t.transid, t.account, t.servicename, t.servicetype,
                   t.systemid, t.new_systemid, t.transdate, t.query_note, t.status,
                   c.firmname
            FROM transactions t
            LEFT JOIN clients c ON c.clientname = t.account
            WHERE t.systemid = ? COLLATE NOCASE OR t.new_systemid = ? COLLATE NOCASE
            ORDER BY t.transdate DESC, t.id DESC
        ");
        $histStmt->execute([$query, $query]);
        $history = array_map(function ($r) {
            return [
                'transid'     => $r['transid'],
                'account'     => $r['account'],
                'firmname'    => $r['firmname'],
                'servicename' => $r['servicename'],
                'servicetype' => $r['servicetype'],
                'from'        => $r['systemid'],
                'to'          => $r['new_systemid'] ?: null,
                'date'        => $r['transdate'],
                'note'        => $r['query_note'],
                'status'      => $r['status'],
            ];
        }, $histStmt->fetchAll());

        jsonOut([
            'query'           => $query,
            'in_use'          => count($currentClients) > 0,
            'duplicate'       => count($currentClients) > 1,
            'current_clients' => $currentClients,
            'history'         => $history,
            'ever_used'       => count($currentClients) > 0 || count($history) > 0,
        ]);

    } catch (Throwable $e) {
        error_log('[systemid.php check] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
        jsonOut(['error' => 'Something went wrong while checking this system ID.'], 500);
    }
}

jsonOut(['error' => 'Unknown request'], 400);
