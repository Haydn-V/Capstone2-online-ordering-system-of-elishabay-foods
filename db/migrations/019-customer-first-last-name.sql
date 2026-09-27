-- 019: First and last name stored separately for customers.
--
-- `name` stays and is still what every screen, order and invoice reads; it is
-- kept equal to "first last" by register.php and profile.php. The two new
-- columns are what the sign-up and My Profile forms edit.
--
-- Not backfilled: splitting an existing "Rain Eugene De Lara" in SQL would
-- guess wrong for compound surnames. Until a customer saves their profile,
-- api/core/CustomerName.php suggests a split (surname particles like
-- "De", "Dela", "Delos", "San" start the last name) and the form shows it.
--
-- Run once on the live database (phpMyAdmin > SQL).

ALTER TABLE customers
    ADD COLUMN first_name VARCHAR(60) NULL AFTER name,
    ADD COLUMN last_name  VARCHAR(60) NULL AFTER first_name;
