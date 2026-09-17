<?php
declare(strict_types=1);

/**
 * GET /api/customers/list.php?page=&limit=&search=&status=active|retailer|archived|all
 *
 * Requires users.manage — the Customer tab sits inside User Management.
 *
 * Order counts and lifetime spend are aggregated in SQL rather than by loading
 * every order and summing in PHP. The join is on customer_id, so walk-in and
 * guest orders (customer_id NULL) correctly count toward nobody.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');
Rbac::require('users.manage');

$q      = $_GET;
$paging = Validate::paging($q, 25, 200);

$where  = [];
$params = [];

$search = trim((string) ($q['search'] ?? ''));
if ($search !== '') {
    $where[] = '(c.name LIKE ? OR c.email LIKE ? OR c.contact LIKE ?)';
    $like = '%' . $search . '%';
    array_push($params, $like, $like, $like);
}

$status = (string) ($q['status'] ?? 'all');
if (in_array($status, ['active', 'retailer', 'archived'], true)) {
    $where[] = 'c.status = ?';
    $params[] = $status;
}

$sql = 'FROM customers c';
if ($where) { $sql .= ' WHERE ' . implode(' AND ', $where); }

$total = (int) Database::scalar("SELECT COUNT(*) $sql", $params);

/* Lifetime spend uses the one revenue definition (D2). The spend params come
   FIRST because the sub-select appears before $sql in the statement. */
[$spendSql, $spendParams] = Revenue::spendSql('c.id');
$rows = Database::all(
    /* canSignIn, NOT the hash. The column is never sent — a staff screen has
       no use for it and shipping password material to a browser is how it ends
       up in a log, a cache or a screenshot. Only the yes/no leaves the server. */
    "SELECT c.id, c.name, c.email, c.contact, c.status, c.joined,
            (c.password IS NOT NULL) AS can_sign_in,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count,
            $spendSql AS lifetime_spend
     $sql
     ORDER BY c.name ASC
     LIMIT {$paging['limit']} OFFSET {$paging['offset']}",
    array_merge($spendParams, $params)
);

Response::ok(array_map(static fn(array $r): array => [
    'id'       => $r['id'],
    'name'     => $r['name'],
    'email'    => $r['email'],
    'contact'  => $r['contact'],
    'status'   => $r['status'],
    /* FALSE MEANS THIS PERSON CANNOT SIGN IN, and the table must say so.

       api/customers/save.php deliberately never sets a password — an admin form
       that could set someone else's is an account-takeover vector, and its
       header makes that argument. The consequence was left invisible: every
       customer staff created through Add Customer could never sign in, nothing
       on the screen said so, and the sign-in form answered "Email or password
       is incorrect" forever. That is a fortnight of somebody retyping a correct
       password.

       Showing it here is the safe half of the fix. Inside the portal, behind
       users.manage, "this record has no sign-in" is operational detail staff
       need. On the public sign-in form the same fact is account enumeration,
       which is why Auth::attemptCustomer still refuses all three cases
       identically. */
    'canSignIn' => (bool) $r['can_sign_in'],
    'joined'   => $r['joined'],
    'orders'   => (int) $r['order_count'],
    'spend'    => (float) $r['lifetime_spend'],
], $rows), [
    'page'  => $paging['page'],
    'limit' => $paging['limit'],
    'total' => $total,
    'pages' => (int) ceil($total / $paging['limit']),
]);
