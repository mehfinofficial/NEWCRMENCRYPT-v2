<?php
session_start();
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../config/helpers.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { jsonOut([]); }

// ── Auth check ────────────────────────────────────────────
$pdo = getDB();

// Check session first
if (empty($_SESSION['userid'])) {
    // Try remember-me cookie
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

$username = $_SESSION['username'];
$userid   = (int)$_SESSION['userid'];

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
$totalClients    = (int)$pdo->query("SELECT COUNT(*) FROM clients")->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE created_at >= ?");
$s->execute([$weekStart]); $clientsThisWeek = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE created_at BETWEEN ? AND ?");
$s->execute([$lastWeekStart, $lastWeekEnd . ' 23:59:59']); $clientsLastWeek = (int)$s->fetchColumn();

// Total records + weekly trend
$totalRecords    = (int)$pdo->query("SELECT COUNT(*) FROM transactions")->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE transdate >= ?");
$s->execute([$weekStart]); $recordsThisWeek = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE transdate BETWEEN ? AND ?");
$s->execute([$lastWeekStart, $lastWeekEnd]); $recordsLastWeek = (int)$s->fetchColumn();

// Expired
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE renewaldate < ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$today]); $expired = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE renewaldate < ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$lastWeekStart]); $expiredLastWeek = (int)$s->fetchColumn();

// Expiring soon (within 15 days)
$future = date('Y-m-d', strtotime('+15 days'));
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE renewaldate BETWEEN ? AND ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$today, $future]); $expiring = (int)$s->fetchColumn();
$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE renewaldate BETWEEN ? AND ? AND renewaldate != '' AND renewaldate IS NOT NULL AND servicetype = 'renewal'");
$s->execute([$lastWeekStart, date('Y-m-d', strtotime($lastWeekEnd . ' +15 days'))]); $expiringLastWeek = (int)$s->fetchColumn();

// Upcoming renewals (next 30 days)
$future30 = date('Y-m-d', strtotime('+30 days'));
$upcomingStmt = $pdo->prepare("
    SELECT account, servicename, renewaldate
    FROM transactions
    WHERE renewaldate BETWEEN ? AND ?
    ORDER BY renewaldate ASC
    LIMIT 10
");
$upcomingStmt->execute([$today, $future30]);
$upcoming = $upcomingStmt->fetchAll();

// Follow-ups today
$followStmt = $pdo->prepare("
    SELECT id, phonenumber, reminderdate, status
    FROM followup
    WHERE reminderdate = ? AND status = 'pending'
    LIMIT 10
");
$followStmt->execute([$today]);
$followupToday = $followStmt->fetchAll();

// Last 7 days chart
$chart = [];
for ($i = 6; $i >= 0; $i--) {
    $date     = date('Y-m-d', strtotime("-$i days"));
    $dayLabel = date('D', strtotime($date));
    $s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE transdate = ?");
    $s->execute([$date]);
    $chart[] = ['day' => $dayLabel, 'date' => $date, 'count' => (int)$s->fetchColumn()];
}

// Month stats
$monthStart = date('Y-m-01');
$monthEnd   = date('Y-m-t');

$s = $pdo->prepare("SELECT COUNT(*) FROM clients WHERE created_at >= ?");
$s->execute([$monthStart]); $monthNewClients = (int)$s->fetchColumn();

$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE transdate BETWEEN ? AND ? AND servicetype = 'renewal'");
$s->execute([$monthStart, $monthEnd]); $monthRenewals = (int)$s->fetchColumn();

$s = $pdo->prepare("SELECT COUNT(*) FROM transactions WHERE renewaldate BETWEEN ? AND ? AND servicetype = 'renewal'");
$s->execute([$monthStart, $monthEnd]); $monthDue = (int)$s->fetchColumn();

jsonOut([
    'username'          => $username,
    'userid'            => $userid,
    'total_clients'     => $totalClients,
    'total_records'     => $totalRecords,
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