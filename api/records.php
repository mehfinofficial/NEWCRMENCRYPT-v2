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

// Auto-migrate: soft-delete column. This one table backs Records, Add
// Transaction, and Transaction History (filtered by servicetype), so a
// single deleted_at column here covers archiving for all three instead of
// needing separate columns/logic per screen.
try {
    $cols = array_column($pdo->query("PRAGMA table_info(transactions)")->fetchAll(), 'name');
    if (!in_array('deleted_at', $cols)) {
        $pdo->exec("ALTER TABLE transactions ADD COLUMN deleted_at DATETIME DEFAULT NULL");
    }
} catch (Exception $e) {}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    requirePermission($pdo, 'view_records');

    if (isset($_GET['services'])) {
        $stmt = $pdo->query("SELECT serviceid, servicename, servicetype, price FROM services ORDER BY servicename ASC");
        jsonOut(['services' => $stmt->fetchAll()]);
    }

    // Transaction History: a money-focused view across every servicetype
    // that carries a payment_amount — direct payments (Add Transaction),
    // renewal payments, and installation payments. Kept as a separate
    // branch (rather than reusing the filter/search below) because it
    // needs its own WHERE base (payment_amount IS NOT NULL) and returns
    // extra aggregate totals the plain records list doesn't need.
    if (isset($_GET['history'])) {
        $search   = trim($_GET['search'] ?? '');
        $page     = max(1, (int)($_GET['page'] ?? 1));
        $pageSize = 50;
        $offset   = ($page - 1) * $pageSize;
        $where    = ["payment_amount IS NOT NULL", "deleted_at IS NULL"];
        $params   = [];

        if ($search) {
            $like    = "%$search%";
            $where[] = "(account LIKE ? OR servicename LIKE ? OR payment_info LIKE ?)";
            $params  = array_merge($params, [$like, $like, $like]);
        }
        if (!empty($_GET['type']) && in_array($_GET['type'], ['payment', 'renewal', 'install'], true)) {
            $where[] = "servicetype = ?";
            $params[] = $_GET['type'];
        }
        if (!empty($_GET['date'])) {
            $where[] = "DATE(transdate) = ?";
            $params[] = $_GET['date'];
        }

        $whereSql = " WHERE " . implode(' AND ', $where);

        // Totals are computed over the *whole* filtered set (not just the
        // current page) so the summary strip stays accurate while scrolling.
        $totalsStmt = $pdo->prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(payment_amount),0) AS amt FROM transactions" . $whereSql);
        $totalsStmt->execute($params);
        $totals = $totalsStmt->fetch();
        $total  = (int)($totals['cnt'] ?? 0);

        $typeTotalsStmt = $pdo->prepare("
            SELECT servicetype, COUNT(*) AS cnt, COALESCE(SUM(payment_amount),0) AS amt
            FROM transactions" . $whereSql . "
            GROUP BY servicetype
        ");
        $typeTotalsStmt->execute($params);
        $typeTotals = $typeTotalsStmt->fetchAll();

        $sql  = "SELECT t.*, (SELECT COUNT(*) FROM files f WHERE f.record_id = t.id) AS file_count
                 FROM transactions t" . $whereSql . " ORDER BY t.transdate DESC, t.id DESC LIMIT ? OFFSET ?";
        $stmt = $pdo->prepare($sql);
        $i = 1;
        foreach ($params as $val) { $stmt->bindValue($i++, $val); }
        $stmt->bindValue($i++, $pageSize, PDO::PARAM_INT);
        $stmt->bindValue($i++, $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();

        jsonOut([
            'records'     => $rows,
            'page'        => $page,
            'total'       => $total,
            'totalAmount' => (float)($totals['amt'] ?? 0),
            'typeTotals'  => $typeTotals,
            'hasMore'     => ($offset + count($rows)) < $total,
        ]);
    }

    $search   = trim($_GET['search'] ?? '');
    $filter   = $_GET['filter'] ?? 'all';
    $page     = max(1, (int)($_GET['page'] ?? 1));
    $pageSize = 100;
    $offset   = ($page - 1) * $pageSize;
    // Direct payments (Add Transaction) are a plain money log, not an
    // operational query/service item, so they're excluded from the
    // general Records/Queries screen — Transaction History (above) is
    // where they belong. The client ledger (client detail "History" tab)
    // is the one exception: it wants a client's complete trail, payments
    // included, so it passes include_payments=1 to opt back in.
    $where    = !empty($_GET['include_payments']) ? [] : ["(servicetype IS NULL OR servicetype != 'payment')"];
    $where[]  = "deleted_at IS NULL";
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

    $sql  = "SELECT t.*, (SELECT COUNT(*) FROM files f WHERE f.record_id = t.id) AS file_count
             FROM transactions t" . $whereSql . " ORDER BY t.transdate DESC, t.id DESC LIMIT ? OFFSET ?";
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
        requirePermission($pdo, 'can_add_record');
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
            // Capture the new record's id immediately — logAction() below does
            // its own INSERT (into `logs`), which would otherwise overwrite
            // lastInsertId() with the logs row's id instead of this record's.
            $newRecordId = $pdo->lastInsertId();

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
            jsonOut(['success' => true, 'id' => $newRecordId, 'transid' => $transid]);

        } catch (Throwable $e) {
            // Log the real error server-side for debugging...
            error_log('[records.php add] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            // ...but never expose internals (paths, SQL, table names) to the browser.
            jsonOut(['error' => 'Something went wrong while saving this record. Please try again.'], 500);
        }
    }

    // Add Transaction — a direct client payment, logged on its own rather
    // than tied to a support/renewal/install service. Lives in the same
    // transactions table (so Transaction History can pull it alongside
    // renewal/installation payments with one query) but is tagged
    // servicetype='payment' and always status='done' — there's no
    // pending/in-progress state for a payment that's already been taken.
    if ($action === 'add_payment') {
        // Same table as regular records (see the deleted_at comment above),
        // so it shares can_add_record rather than needing its own key.
        requirePermission($pdo, 'can_add_record');
        try {
            $account = trim($body['account'] ?? '');
            if ($account === '') {
                jsonOut(['error' => 'Select a client'], 400);
            }

            $paymentAmount = null;
            if (isset($body['payment_amount']) && $body['payment_amount'] !== '' && $body['payment_amount'] !== null) {
                $paymentAmount = (float)$body['payment_amount'];
            }
            if ($paymentAmount === null || $paymentAmount <= 0) {
                jsonOut(['error' => 'Enter a valid payment amount'], 400);
            }

            $transid  = 'TXN' . strtoupper(substr(uniqid(), -6));
            $userid   = (int)($_SESSION['userid'] ?? 1);
            $username = $_SESSION['username'] ?? 'Admin';

            $stmt = $pdo->prepare("
                INSERT INTO transactions
                    (transid, account, servicename, serviceid, servicetype, systemid,
                     transdate, renewaldate, next_renewal, payment_info, payment_amount,
                     status, `query`, query_note, new_systemid, user, userid, created_at)
                VALUES
                    (:transid, :account, 'Payment', 0, 'payment', '',
                     :transdate, NULL, NULL, :payment_info, :payment_amount,
                     'done', '', :query_note, '', :user, :userid, :created_at)
            ");
            $stmt->execute([
                ':transid'        => $transid,
                ':account'        => $account,
                ':transdate'      => $body['transdate']    ?? date('Y-m-d'),
                ':payment_info'   => $body['payment_info'] ?? null,
                ':payment_amount' => $paymentAmount,
                ':query_note'     => $body['note']         ?? '',
                ':user'           => $username,
                ':userid'         => $userid,
                ':created_at'     => date('Y-m-d H:i:s'),
            ]);
            // Same lastInsertId()-clobbering issue as the 'add' action above —
            // capture it before logAction() runs its own INSERT.
            $newPaymentId = $pdo->lastInsertId();

            $logClient = $pdo->prepare("SELECT firmname FROM clients WHERE clientname = ?");
            $logClient->execute([$account]);
            $logFirm = $logClient->fetchColumn() ?: $account;

            logAction($pdo, "Payment of " . number_format($paymentAmount, 2) . " recorded for " . $logFirm);
            jsonOut(['success' => true, 'id' => $newPaymentId, 'transid' => $transid]);

        } catch (Throwable $e) {
            error_log('[records.php add_payment] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            jsonOut(['error' => 'Something went wrong while saving this payment. Please try again.'], 500);
        }
    }

    if ($action === 'update_status') {
        requirePermission($pdo, 'can_edit_record');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $pdo->prepare("UPDATE transactions SET status = ? WHERE id = ?")->execute([$body['status'] ?? 'done', $id]);
        logAction($pdo, "Record #$id marked as " . ($body['status'] ?? 'done'));
        jsonOut(['success' => true]);
    }

    // Full edit — covers both a regular record (support/renewal/system
    // change/install) and a direct payment (Add Transaction), since both
    // live in this same table. Only columns actually present in the
    // request body are touched, so a payment edit (which never sends
    // servicename/systemid/etc.) doesn't clobber those fields with blanks.
    if ($action === 'update') {
        requirePermission($pdo, 'can_edit_record');
        try {
            $id = (int)($body['id'] ?? 0);
            if (!$id) jsonOut(['error' => 'Invalid ID'], 400);

            $existingStmt = $pdo->prepare("SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL");
            $existingStmt->execute([$id]);
            $existing = $existingStmt->fetch();
            if (!$existing) jsonOut(['error' => 'Record not found'], 404);

            // Editable column => value, falling back to the existing stored
            // value for any field this particular edit form doesn't send.
            $paymentAmount = $existing['payment_amount'];
            if (array_key_exists('payment_amount', $body)) {
                $paymentAmount = ($body['payment_amount'] === '' || $body['payment_amount'] === null)
                    ? null : (float)$body['payment_amount'];
            }

            $fields = [
                'account'        => $body['account']        ?? $existing['account'],
                'transdate'      => $body['transdate']       ?? $existing['transdate'],
                'renewaldate'    => $body['renewaldate']     ?? $existing['renewaldate'],
                'next_renewal'   => $body['next_renewal']    ?? $existing['next_renewal'],
                'payment_info'   => $body['payment_info']    ?? $existing['payment_info'],
                'payment_amount' => $paymentAmount,
                'status'         => $body['status']          ?? $existing['status'],
                'query'          => $body['query']           ?? $existing['query'],
                'query_note'     => $body['query_note'] ?? $body['note'] ?? $existing['query_note'],
                'systemid'       => $body['systemid']        ?? $existing['systemid'],
                'new_systemid'   => $body['new_systemid']    ?? $existing['new_systemid'],
            ];

            $stmt = $pdo->prepare("
                UPDATE transactions
                SET account = :account, transdate = :transdate, renewaldate = :renewaldate,
                    next_renewal = :next_renewal, payment_info = :payment_info,
                    payment_amount = :payment_amount, status = :status,
                    `query` = :query, query_note = :query_note,
                    systemid = :systemid, new_systemid = :new_systemid
                WHERE id = :id
            ");
            $stmt->execute($fields + [':id' => $id]);

            // Same side effects as 'add' — keep the client record consistent
            // if a system-change/renewal edit changed the relevant date/id.
            if (!empty($fields['new_systemid']) && strtolower($existing['servicetype']) === 'system change') {
                $pdo->prepare("UPDATE clients SET system_id = ? WHERE clientname = ?")
                    ->execute([$fields['new_systemid'], $fields['account']]);
            }
            if (strtolower($existing['servicetype']) === 'renewal' && !empty($fields['next_renewal'])) {
                $pdo->prepare("UPDATE clients SET renewal_date = ? WHERE clientname = ?")
                    ->execute([$fields['next_renewal'], $fields['account']]);
            }

            logAction($pdo, "Record updated: " . ($existing['servicename'] ?: 'Payment') . " for " . $fields['account'] . " (id=$id)");
            jsonOut(['success' => true]);
        } catch (Throwable $e) {
            error_log('[records.php update] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            jsonOut(['error' => 'Something went wrong while updating this record. Please try again.'], 500);
        }
    }

    if ($action === 'delete') {
        requirePermission($pdo, 'can_delete_record');
        $id = (int)($body['id'] ?? 0);
        if (!$id) jsonOut(['error' => 'Invalid ID'], 400);
        $stmt = $pdo->prepare("SELECT account, servicename FROM transactions WHERE id = ? AND deleted_at IS NULL");
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) jsonOut(['error' => 'Record not found'], 404);
        // Soft delete — recoverable from Archives for 30 days, same pattern
        // as clients.php, rather than an immediate unrecoverable DELETE.
        $deletedAt = date('Y-m-d H:i:s');
        $pdo->prepare("UPDATE transactions SET deleted_at = ? WHERE id = ?")->execute([$deletedAt, $id]);
        // Any files attached to this record archive right along with it —
        // they'll come back together on restore and expire together too.
        archiveRecordFiles($pdo, $id, $deletedAt);
        logAction($pdo, "Record deleted: " . ($row['servicename'] ?: 'Payment') . " for " . $row['account'] . " (id=$id)");
        jsonOut(['success' => true]);
    }

    jsonOut(['error' => 'Unknown action'], 400);
}

jsonOut(['error' => 'Method not allowed'], 405);