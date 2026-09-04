<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

$pdo = getDB();
requireAuth($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $search   = trim($_GET['search'] ?? '');
    $filter   = $_GET['filter'] ?? 'all';
    $page     = max(1, (int)($_GET['page'] ?? 1));
    $pageSize = 100;
    $offset   = ($page - 1) * $pageSize;
    $params   = [];
    $where    = [];

    if ($search) {
        $like = "%$search%";
        $where[] = "(phonenumber LIKE ? OR clientname LIKE ? OR note LIKE ?)";
        $params = array_merge($params, [$like, $like, $like]);
    }
    if ($filter === 'pending') { $where[] = "status = 'pending'"; }
    if ($filter === 'done')    { $where[] = "status = 'done'"; }
    if ($filter === 'clients') { $where[] = "type = 'client'"; }
    if ($filter === 'leads')   { $where[] = "is_lead = 1"; }

    $whereSql = $where ? (" WHERE " . implode(' AND ', $where)) : '';

    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM followup" . $whereSql);
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $sql  = "SELECT * FROM followup" . $whereSql . " ORDER BY reminderdate DESC LIMIT ? OFFSET ?";
    $stmt = $pdo->prepare($sql);
    $i = 1;
    foreach ($params as $val) { $stmt->bindValue($i++, $val); }
    $stmt->bindValue($i++, $pageSize, PDO::PARAM_INT);
    $stmt->bindValue($i++, $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();

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

    if ($action === 'update') {
        $stmt = $pdo->prepare("UPDATE followup SET status = :status WHERE id = :id");
        $stmt->execute([':status' => $body['status'], ':id' => (int)$body['id']]);
        logAction($pdo, "Follow-up #" . $body['id'] . " marked as " . $body['status']);
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);