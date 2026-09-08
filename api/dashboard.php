<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

// ── Auth check ────────────────────────────────────────────
// Was previously a hand-rolled duplicate of requireAuth()'s session/
// remember-me check that stopped short of calling enforceAccountAccess() —
// meaning a disabled account, or one whose login-hours window had closed,
// could sit on the Dashboard tab (the default landing page) indefinitely
// without ever being kicked, even though every other screen would catch it.
// requireAuth() does the same session + remember-me check plus that
// enforcement, so this now behaves identically to the rest of the API.
$pdo = getDB();
requireAuth($pdo);

$username = $_SESSION['username'];
$userid   = (int)$_SESSION['userid'];

// Every query below now excludes archived (soft-deleted) rows — see the
// per-query comments — so this guards against a query failing with "no
// such column" on a brand-new install where Dashboard happens to load
// before Clients/Records/Followups have ever run their own migration.
// Cheap no-op once the column already exists, same pattern used there.
foreach (['clients' => 'clients', 'transactions' => 'transactions', 'followup' => 'followup'] as $table) {
    try {
        $cols = array_column($pdo->query("PRAGMA table_info($table)")->fetchAll(), 'name');
        if (!in_array('deleted_at', $cols)) {
            $pdo->exec("ALTER TABLE $table ADD COLUMN deleted_at DATETIME DEFAULT NULL");
        }
    } catch (Exception $e) {}
}

$today     = today();
$weekStart = date('Y-m-d', strtotime('monday this week'));

// Resolution rate: of the queries opened this week (excludes the
// servicetype='payment' rows Add Transaction creates, same as Records list),
// how many are already marked done.
$s = $pdo->prepare("
    SELECT
        COUNT(*) AS opened,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS resolved
    FROM transactions
    WHERE deleted_at IS NULL
      AND transdate >= ?
      AND (servicetype IS NULL OR servicetype != 'payment')
");
$s->execute([$weekStart]);
$resRow = $s->fetch();
$queriesOpened   = (int)($resRow['opened'] ?? 0);
$queriesResolved = (int)($resRow['resolved'] ?? 0);
$resolutionRate  = $queriesOpened > 0 ? (int)round(($queriesResolved / $queriesOpened) * 100) : 0;

// Upcoming renewals (next 7 days) — pulled from clients.renewal_date, the
// same source the FAB "Upcoming Renewals" list uses, instead of the
// transactions table (which only has a row once a renewal has actually been
// logged and was why this list showed empty while the FAB version worked).
$weekAhead = date('Y-m-d', strtotime('+7 days'));
$upcomingStmt = $pdo->prepare("
    SELECT id, clientname, firmname, renewal_date
    FROM clients
    WHERE deleted_at IS NULL
      AND renewal_date IS NOT NULL AND renewal_date != ''
      AND renewal_date BETWEEN ? AND ?
    ORDER BY renewal_date ASC
    LIMIT 10
");
$upcomingStmt->execute([$today, $weekAhead]);
$upcoming = $upcomingStmt->fetchAll();

// Follow-ups today
$followStmt = $pdo->prepare("
    SELECT id, phonenumber, clientname, type, reminderdate, status
    FROM followup
    WHERE deleted_at IS NULL AND reminderdate = ? AND status = 'pending'
    LIMIT 10
");
$followStmt->execute([$today]);
$followupToday = $followStmt->fetchAll();

// Mask phone numbers here per the same view_phone_followups permission
// followups.php already enforces on the Follow-ups tab — this dashboard
// card reads from the same table and was returning phonenumber
// unconditionally, which let a restricted user see numbers here that
// were correctly hidden everywhere else.
if (!getUserPermissions($pdo)['view_phone_followups']) {
    foreach ($followupToday as &$fu) { $fu['phonenumber'] = null; }
    unset($fu);
}

// Last 7 days chart
$chart = [];
for ($i = 6; $i >= 0; $i--) {
    $date     = date('Y-m-d', strtotime("-$i days"));
    $dayLabel = date('D', strtotime($date));
    $s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND transdate = ?");
    $s->execute([$date]);
    $chart[] = ['day' => $dayLabel, 'date' => $date, 'count' => (int)$s->fetchColumn()];
}

jsonOut([
    'username'          => $username,
    'userid'            => $userid,
    'resolution_rate' => [
        'pct'      => $resolutionRate,
        'resolved' => $queriesResolved,
        'opened'   => $queriesOpened,
    ],
    'upcoming_renewals' => $upcoming,
    'followup_today'    => $followupToday,
    'chart_data'        => $chart,
]);