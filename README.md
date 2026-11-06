# Elisha Bay Foods: Online Ordering and Store Management System

A web-based online ordering, point-of-sale (POS) and inventory system built for **Elisha Bay / Juris Bay Foods**, a Philippine seafood business. Made as our Capstone 2 project for the BS Information Technology program.

Customers can browse products and order online. Staff use one portal, with role-based access, to handle orders, payments, inventory, walk-in sales and reports.

> Screenshots: add images to `docs/screenshots/` and link them here, for example
> `![Storefront](docs/screenshots/storefront.png)`

---

## Features

### Customer storefront (`public/`)
- Product catalog and shop page
- Cart and checkout with delivery or pickup
- Philippine address picker (Region → Province → City/Municipality → Barangay, from PSA PSGC data)
- Upload payment proof (GCash / bank transfer)
- Customer account: dashboard, my orders, order history, my payments, profile
- Product reviews and ratings
- Batch traceability page (look up a product's lot/batch)
- B2B partner / retailer application form

### Staff portal (`portal/`)
Five staff roles, each with its own portal and permissions:

| Role | Main work |
|------|-----------|
| Super Admin | Users, roles and permissions, system settings, audit log |
| Admin | Products, reports, B2B partners, VAT, shipping |
| Inventory Staff | Stock, batches/lots, expiry tracking |
| Cashier | POS for walk-in orders, receipts, transactions |
| Online Orders Staff | Order queue, order status, payment verification, returns |

Other modules: dashboard, notifications, sales reports with Excel export, returns, reviews, and an audit trail of staff actions.

---

## Tech stack

- **Frontend:** HTML, CSS, vanilla JavaScript (no framework, no build step)
- **Backend:** PHP 8.2 (REST-style JSON API in `api/`)
- **Database:** MySQL / MariaDB 10.4
- **Server:** Apache via XAMPP
- **Library:** PhpSpreadsheet (via Composer) for Excel export

### Security highlights
- Role-based access control (RBAC) checked on the server for every API endpoint, not just hidden in the UI
- CSRF protection on all write requests
- Prices and totals computed on the server, never trusted from the browser
- Uploads and storage folders blocked from direct access with `.htaccess`
- Real database credentials are kept out of the repository (`api/config/config.php` is git-ignored)

---

## Project structure

```
api/        PHP API endpoints (auth, orders, products, inventory, pos, payments, reports, ...)
assets/     CSS, JavaScript and images
db/         schema.sql, seed.sql, migrations/ and Philippine location data
docs/       Setup guide, API reference and project notes
portal/     Staff portal (one entry per role + shared views)
public/     Customer storefront
tools/      Helper scripts (verification, image migration, deployment)
uploads/    Product photos and payment proofs (contents not committed)
vendor/     Composer packages (PhpSpreadsheet)
```

---

## How to run it locally

Full step-by-step guide: [docs/SETUP.md](docs/SETUP.md)

1. Install **XAMPP** (PHP 8.2, MariaDB 10.4).
2. Put the project in `C:\xampp\htdocs\elishabay\`.
3. Start **Apache** and **MySQL** in the XAMPP Control Panel.
4. Import the database, in this order:
   ```bash
   C:\xampp\mysql\bin\mysql.exe -u root < db\schema.sql
   C:\xampp\mysql\bin\mysql.exe -u root < db\seed.sql
   ```
   Then run every file in `db/migrations/` in number order, and load `db/seed-ph-locations.sql` (see SETUP.md).
5. Copy `api/config/config.example.php` to `api/config/config.php` and set your database login.
6. Open **http://localhost/elishabay/**

Demo staff accounts come from `db/seed.sql`. Change all demo passwords before putting the system online.

---

## Documentation

- [Setup guide](docs/SETUP.md)
- [API reference](docs/API.md)
- [Testing notes](docs/TESTING.md)
- [Progress log](docs/PROGRESS.md)

---

## Team

Capstone 2 project, BS Information Technology.

| Member | GitHub | Role |
|--------|--------|------|
| [Your name] | [@Haydn-V](https://github.com/Haydn-V) | [e.g. Backend / API, database] |
| [Teammate name] | [GitHub username] | [e.g. Frontend, UI design] |

---

*This project was made for school. It is not an official product of Elisha Bay / Juris Bay Foods.*
