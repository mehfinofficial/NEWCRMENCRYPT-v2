<?php
// Errors are logged server-side, never shown to the browser. Showing raw
// PHP errors to visitors leaks file paths, table/column names, and SQL
// details — useful info for anyone probing the API, and a bad look if a
// real user hits it.
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

if ($method === 'GET') {

    if (isset($_GET['services'])) {
        $stmt = $pdo->query("SELECT serviceid, servicename, servicetype, price FROM services ORDER BY servicename ASC");
        jsonOut(['services' => $stmt->fetchAll()]);
    }

    $search   = trim($_GET['search'] ?? '');
    $filter   = $_GET['filter'] ?? 'all';
    $page     = max(1, (int)($_GET['page'] ?? 1));
    $pageSize = 100;
    $offset   = ($page - 1) * $pageSize;
    $where    = [];
    $params   = [];

    if ($search) {
        $like    = "%$search%";
        $where[] = "(account LIKE ? OR servicename LIKE ? OR systemid LIKE ? OR query_note LIKE ?)";
        $params  = array_merge($params, [$like, $like, $like, $like]);
    }
    if ($filter === 'pending') { $where[] = "status = 'pending'"; }
    elseif ($filter === 'done') { $where[] = "status = 'done'"; }
    elseif ($filter === 'date' && !empty($_GET['date'])) {
        $where[] = "DATE(transdate) = ?";
        $params[] = $_GET['date'];
    }

    $whereSql = $where ? (" WHERE " . implode(' AND ', $where)) : '';

    // Total count for this filter/search, so the client knows when it has
    // reached the end instead of guessing from a hardcoded row cap.
    $countStmt = $pdo->prepare("SELECT COUNT(*) FROM transactions" . $whereSql);
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $sql  = "SELECT * FROM transactions" . $whereSql . " ORDER BY transdate DESC, id DESC LIMIT ? OFFSET ?";
    $stmt = $pdo->prepare($sql);
    $i = 1;
    foreach ($params as $val) { $stmt->bindValue($i++, $val); }
    $stmt->bindValue($i++, $pageSize, PDO::PARAM_INT);
    $stmt->bindValue($i++, $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();

    jsonOut([
        'records' => $rows,
        'page'    => $page,
        'total'   => $total,
        'hasMore' => ($offset + count($rows)) < $total,
    ]);
}

if ($method === 'POST') {
    $body   = jsonIn();
    $action = $body['action'] ?? '';

    if ($action === 'add') {
        try {
            $transid  = 'TXN' . strtoupper(substr(uniqid(), -6));
            $userid   = (int)($_SESSION['userid'] ?? 1);
            $username = $_SESSION['username'] ?? 'Admin';

            $svcStmt = $pdo->prepare("SELECT servicename, servicetype FROM services WHERE serviceid = ?");
            $svcStmt->execute([(int)($body['serviceid'] ?? 0)]);
            $svc = $svcStmt->fetch() ?: [];

            $servicename = $svc['servicename'] ?? ($body['servicename'] ?? '');
            $servicetype = $svc['servicetype'] ?? ($body['servicetype'] ?? '');
            $newSystemid = trim($body['new_systemid'] ?? '');

            // Payment amount comes in as a string from the form; normalize to
            // a float (or null when blank) so it stores/sorts correctly.
            $paymentAmount = null;
            if (isset($body['payment_amount']) && $body['payment_amount'] !== '' && $body['payment_amount'] !== null) {
                $paymentAmount = (float)$body['payment_amount'];
            }

            $stmt = $pdo->prepare("
                INSERT INTO transactions
                    (transid, account, servicename, serviceid, servicetype, systemid,
                     transdate, renewaldate, next_renewal, payment_info, payment_amount,
                     status, `query`, query_note, new_systemid, user, userid, created_at)
                VALUES
                    (:transid, :account, :servicename, :serviceid, :servicetype, :systemid,
                     :transdate, :renewaldate, :next_renewal, :payment_info, :payment_amount,
                     :status, :query, :query_note, :new_systemid, :user, :userid, :created_at)
            ");
            $stmt->execute([
                ':transid'        => $transid,
                ':account'        => $body['account']      ?? '',
                ':servicename'    => $servicename,
                ':serviceid'      => (int)($body['serviceid'] ?? 0),
                ':servicetype'    => $servicetype,
                ':systemid'       => $body['systemid']     ?? '',
                ':transdate'      => $body['transdate']    ?? date('Y-m-d'),
                ':renewaldate'    => $body['renewaldate']  ?? null,
                ':next_renewal'   => $body['next_renewal'] ?? null,
                ':payment_info'   => $body['payment_info'] ?? null,
                ':payment_amount' => $paymentAmount,
                ':status'         => $body['status']       ?? 'pending',
                ':query'          => $body['query']        ?? '',
                ':query_note'     => $body['query_note']   ?? '',
                ':new_systemid'   => $newSystemid,
                ':user'           => $username,
                ':userid'         => $userid,
                ':created_at'     => date('Y-m-d H:i:s'),
            ]);

            if ($newSystemid && strtolower($servicetype) === 'system change') {
                $pdo->prepare("UPDATE clients SET system_id = ? WHERE clientname = ?")
                    ->execute([$newSystemid, $body['account'] ?? '']);
            }

            // If renewal service — update client's renewal_date to next_renewal
            if (strtolower($servicetype) === 'renewal' && !empty($body['next_renewal'])) {
                $pdo->prepare("UPDATE clients SET renewal_date = ? WHERE clientname = ?")
                    ->execute([$body['next_renewal'], $body['account'] ?? '']);
            }

            // Look up firmname for log message
            $logClient = $pdo->prepare("SELECT firmname FROM clients WHERE clientname = ?");
            $logClient->execute([$body['account'] ?? '']);
            $logFirm = $logClient->fetchColumn() ?: ($body['account'] ?? '');

            logAction($pdo, "Record added: {$servicename} for " . $logFirm);
            jsonOut(['success' => true, 'id' => $pdo->lastInsertId(), 'transid' => $transid]);

        } catch (Throwable $e) {
            // Log the real error server-side for debugging...
            error_log('[records.php add] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            // ...but never expose internals (paths, SQL, table names) to the browser.
            jsonOut(['error' => 'Something went wrong while saving this record. Please try again.'], 500);
        }
    }

    if ($action === 'update_status') {
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $pdo->prepare("UPDATE transactions SET status = ? WHERE id = ?")->execute([$body['status'] ?? 'done', $id]);
        logAction($pdo, "Record #$id marked as " . ($body['status'] ?? 'done'));
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);