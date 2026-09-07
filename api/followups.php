<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);

// Auto-migrate: soft-delete column, same 30-day-Archives pattern as clients
// and transactions.
try {
    $cols = array_column($pdo->query("PRAGMA table_info(followup)")->fetchAll(), 'name');
    if (!in_array('deleted_at', $cols)) {
        $pdo->exec("ALTER TABLE followup ADD COLUMN deleted_at DATETIME DEFAULT NULL");
    }
} catch (Exception $e) {}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    requirePermission($pdo, 'view_followups');
    $search   = trim($_GET['search'] ?? '');
    $filter   = $_GET['filter'] ?? 'all';
    $page     = max(1, (int)($_GET['page'] ?? 1));
    $pageSize = 100;
    $offset   = ($page - 1) * $pageSize;
    $params   = [];
    $where    = ["deleted_at IS NULL"];

    if ($search) {
        $like = "%$search%";
        $where[] = "(phonenumber LIKE ? OR clientname LIKE ? OR note LIKE ?)";
        $params = array_merge($params, [$like, $like, $like]);
    }
    if ($filter === 'pending')   { $where[] = "status = 'pending'"; }
    if ($filter === 'done')      { $where[] = "status = 'done'"; }
    if ($filter === 'cancelled') { $where[] = "status = 'cancelled'"; }
    if ($filter === 'clients') { $where[] = "type = 'client'"; }
    if ($filter === 'leads')   { $where[] = "is_lead = 1"; }

    $whereSql = $where ? (" WHERE " . implode(' AND ', $where)) : '';

    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM followup" . $whereSql);
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    // Pending follow-ups first (oldest reminder date first, so overdue ones
    // surface at the very top, then today, then upcoming), resolved ones
    // (done or cancelled) last. Plain "reminderdate DESC" used to bury
    // overdue items at the bottom of the list under future-dated pending
    // ones. Keyed off "!= pending" rather than "= done" so cancelled
    // follow-ups also sink to the bottom instead of mixing in with pending.
    $sql  = "SELECT * FROM followup" . $whereSql . "
             ORDER BY (status != 'pending') ASC, reminderdate ASC
             LIMIT ? OFFSET ?";
    $stmt = $pdo->prepare($sql);
    $i = 1;
    foreach ($params as $val) { $stmt->bindValue($i++, $val); }
    $stmt->bindValue($i++, $pageSize, PDO::PARAM_INT);
    $stmt->bindValue($i++, $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();

    // Mask phone numbers here (not in app.js) so a restricted user can't
    // just read the field out of the network response — same reasoning as
    // clients.php. Follow-up phones are stored in plain text (unlike
    // client phones, which are encrypted at rest), but the masking rule
    // is the same either way: strip the field server-side per permission.
    $canViewPhone = getUserPermissions($pdo)['view_phone_followups'];
    if (!$canViewPhone) {
        foreach ($rows as &$r) { $r['phonenumber'] = null; }
        unset($r);
    }

    jsonOut([
        'followups' => $rows,
        'page'      => $page,
        'total'     => $total,
        'hasMore'   => ($offset + count($rows)) < $total,
    ]);
}

if ($method === 'POST') {
    $body = jsonIn();
    $action = $body['action'] ?? '';

    if ($action === 'add') {
        requirePermission($pdo, 'can_add_followup');
        $stmt = $pdo->prepare("
            INSERT INTO followup (phonenumber, reminderdate, status, type, clientname, note, is_lead)
            VALUES (:phonenumber, :reminderdate, :status, :type, :clientname, :note, :is_lead)
        ");
        $stmt->execute([
            ':phonenumber'  => $body['phonenumber']  ?? '',
            ':reminderdate' => $body['reminderdate']  ?? today(),
            ':status'       => $body['status']        ?? 'pending',
            ':type'         => $body['type']          ?? 'new',
            ':clientname'   => $body['clientname']    ?? '',
            ':note'         => $body['note']          ?? '',
            ':is_lead'      => (int)($body['is_lead'] ?? 0),
        ]);
        logAction($pdo, "Follow-up added for: " . ($body['phonenumber'] ?? ''));
        jsonOut(['success' => true]);
    }

    // Status-only change (Mark Complete / Cancelled buttons). Its own
    // permission key, separate from can_edit_followup — closing out a
    // follow-up's state isn't the same as editing its details, and a role
    // can have one without the other (e.g. Onsite: no edit, but can still
    // mark done/cancelled after a visit).
    if ($action === 'update') {
        requirePermission($pdo, 'can_update_followup_status');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $stmt = $pdo->prepare("UPDATE followup SET status = :status WHERE id = :id");
        $stmt->execute([':status' => $body['status'], ':id' => $id]);
        logAction($pdo, "Follow-up #" . $id . " marked as " . $body['status']);
        jsonOut(['success' => true]);
    }

    // Full edit — phone/note/date/type/lead, as opposed to 'update' above
    // which only ever touches status.
    if ($action === 'edit') {
        requirePermission($pdo, 'can_edit_followup');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $existingStmt = $pdo->prepare("SELECT * FROM followup WHERE id = ? AND deleted_at IS NULL");
        $existingStmt->execute([$id]);
        $existing = $existingStmt->fetch();
        if (!$existing) jsonOut(['error' => 'Follow-up not found'], 404);

        $stmt = $pdo->prepare("
            UPDATE followup
            SET phonenumber  = :phonenumber,
                reminderdate = :reminderdate,
                status       = :status,
                type         = :type,
                clientname   = :clientname,
                note         = :note,
                is_lead      = :is_lead
            WHERE id = :id
        ");
        $stmt->execute([
            ':phonenumber'  => $body['phonenumber']  ?? $existing['phonenumber'],
            ':reminderdate' => $body['reminderdate'] ?? $existing['reminderdate'],
            ':status'       => $body['status']       ?? $existing['status'],
            ':type'         => $body['type']         ?? $existing['type'],
            ':clientname'   => $body['clientname']   ?? $existing['clientname'],
            ':note'         => $body['note']         ?? $existing['note'],
            ':is_lead'      => (int)($body['is_lead'] ?? $existing['is_lead']),
            ':id'           => $id,
        ]);
        logAction($pdo, "Follow-up updated for: " . ($body['phonenumber'] ?? $existing['phonenumber']) . " (id=$id)");
        jsonOut(['success' => true]);
    }

    if ($action === 'delete') {
        requirePermission($pdo, 'can_delete_followup');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $stmt = $pdo->prepare("SELECT phonenumber, clientname FROM followup WHERE id = ? AND deleted_at IS NULL");
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) jsonOut(['error' => 'Follow-up not found'], 404);
        $pdo->prepare("UPDATE followup SET deleted_at = ? WHERE id = ?")->execute([date('Y-m-d H:i:s'), $id]);
        logAction($pdo, "Follow-up deleted: " . ($row['clientname'] ?: $row['phonenumber']) . " (id=$id)");
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);