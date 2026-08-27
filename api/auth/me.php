<?php
declare(strict_types=1);

/**
 * GET /api/auth/me.php
 *
 * The single identity endpoint (D7). Answers for whichever session exists and
 * says which kind it is:
 *
 *   { "type": "staff",    "user": {...}, "permissions": [...], "catalogue": [...] }
 *   { "type": "customer", "customer": {...} }
 *
 * 401 when nobody is signed in, which api.js turns into a redirect to the login
 * view — so a portal opened with an expired session lands on the login screen
 * rather than rendering an empty dashboard.
 *
 * WHY ONE ENDPOINT
 * ----------------
 * Staff and customers have always shared PHP sessions and bcrypt. What was
 * still split was identity *reporting*: this file answered for staff, shop/me.php
 * for customers, and neither knew the other existed. Nothing owned the question
 * "who is this request from?", which is how a mock customer login — one that
 * title-cased the local part of any email and called it an account — survived as
 * long as it did. Nothing was positioned to notice.
 *
 * The two session keys stay separate (eb_user_id vs eb_customer_id) so a shopper
 * can never satisfy an Rbac check. One endpoint reports; it does not merge them.
 *
 * A customer gets no `permissions` key at all rather than an empty array —
 * absent is harder to misread than empty, and no customer holds any permission.
 *
 * Role and permissions are re-read from the database here, never trusted from
 * the session, so a role change or an archived account takes effect on the very
 * next request.
 */

require __DIR__ . '/../core/bootstrap.php';

Response::requireMethod('GET');

$user = Auth::user();
if ($user !== null) {
    Response::ok([
        'type' => 'staff',
        'user' => [
            'id'     => $user['id'],
            'name'   => $user['name'],
            'email'  => $user['email'],
            'avatar' => $user['avatar'],
            'role'   => $user['role'],
        ],
        'permissions' => Rbac::forRole((int) $user['role_id'], (bool) $user['is_system']),
        'catalogue'   => Rbac::catalogue(),
        'csrf'        => Csrf::token(),
    ]);
}

$customer = Auth::customer();
if ($customer !== null) {
    Response::ok([
        'type' => 'customer',
        'customer' => [
            'id'      => $customer['id'],
            'name'    => $customer['name'],
            'email'   => $customer['email'],
            'contact' => $customer['contact'],
        ],
        'csrf' => Csrf::token(),
    ]);
}

Response::unauthenticated('Sign in to continue.');
