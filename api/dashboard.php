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

$today = today();

// Week boundaries
$weekStart     = date('Y-m-d', strtotime('monday this week'));
$lastWeekStart = date('Y-m-d', strtotime('monday last week'));
$lastWeekEnd   = date('Y-m-d', strtotime('sunday last week'));

// Helper
function trendPct(int $now, int $prev): ?int {
    if ($prev === 0) return $now > 0 ? 100 : null;
    return (int)round((($now - $prev) / $prev) * 100);
}

// Total clients + weekly trend
$totalClients    = (int)$pdo->query("SELECT COUNT(*) FROM clients WHERE deleted_at IS NULL")->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE deleted_at IS NULL AND created_at >= ?");
$s->execute([$weekStart]); $clientsThisWeek = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ?");
$s->execute([$lastWeekStart, $lastWeekEnd . ' 23:59:59']); $clientsLastWeek = (int)$s->fetchColumn();

// Total records + weekly trend
$totalRecords    = (int)$pdo->query("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL")->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND transdate >= ?");
$s->execute([$weekStart]); $recordsThisWeek = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND transdate BETWEEN ? AND ?");
$s->execute([$lastWeekStart, $lastWeekEnd]); $recordsLastWeek = (int)$s->fetchColumn();

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

// Expired
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND renewaldate < ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$today]); $expired = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND renewaldate < ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$lastWeekStart]); $expiredLastWeek = (int)$s->fetchColumn();

// Expiring soon (within 15 days)
$future = date('Y-m-d', strtotime('+15 days'));
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND renewaldate BETWEEN ? AND ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$today, $future]); $expiring = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND renewaldate BETWEEN ? AND ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$lastWeekStart, date('Y-m-d', strtotime($lastWeekEnd . ' +15 days'))]); $expiringLastWeek = (int)$s->fetchColumn();

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

// Last 7 days chart
$chart = [];
for ($i = 6; $i >= 0; $i--) {
    $date     = date('Y-m-d', strtotime("-$i days"));
    $dayLabel = date('D', strtotime($date));
    $s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND transdate = ?");
    $s->execute([$date]);
    $chart[] = ['day' => $dayLabel, 'date' => $date, 'count' => (int)$s->fetchColumn()];
}

// Month stats
$monthStart = date('Y-m-01');
$monthEnd   = date('Y-m-t');

$s = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE deleted_at IS NULL AND created_at >= ?");
$s->execute([$monthStart]); $monthNewClients = (int)$s->fetchColumn();

$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND transdate BETWEEN ? AND ? AND servicetype = 'renewal'");
$s->execute([$monthStart, $monthEnd]); $monthRenewals = (int)$s->fetchColumn();

$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND renewaldate BETWEEN ? AND ? AND servicetype = 'renewal'");
$s->execute([$monthStart, $monthEnd]); $monthDue = (int)$s->fetchColumn();

jsonOut([
    'username'          => $username,
    'userid'            => $userid,
    'total_clients'     => $totalClients,
    'total_records'     => $totalRecords,
    'resolution_rate' => [
        'pct'      => $resolutionRate,
        'resolved' => $queriesResolved,
        'opened'   => $queriesOpened,
    ],
    'expired'           => $expired,
    'expiring_soon'     => $expiring,
    'upcoming_renewals' => $upcoming,
    'followup_today'    => $followupToday,
    'chart_data'        => $chart,
    'month_stats' => [
        'new_clients' => $monthNewClients,
        'renewals'    => $monthRenewals,
        'due'         => $monthDue,
    ],
    'trends' => [
        'clients'  => ['this_week' => $clientsThisWeek,  'last_week' => $clientsLastWeek,  'pct' => trendPct($clientsThisWeek,  $clientsLastWeek)],
        'records'  => ['this_week' => $recordsThisWeek,  'last_week' => $recordsLastWeek,  'pct' => trendPct($recordsThisWeek,  $recordsLastWeek)],
        'expired'  => ['this_week' => $expired,          'last_week' => $expiredLastWeek,  'pct' => trendPct($expired,          $expiredLastWeek)],
        'expiring' => ['this_week' => $expiring,         'last_week' => $expiringLastWeek, 'pct' => trendPct($expiring,         $expiringLastWeek)],
    ],
]);