-- ============================================================
-- HOT-FIX: pm_transfer_items unique key — widen to include per_box_qty
-- ============================================================
--
-- WHY:
--   The application code (api_voucher_scan_box) buckets line items by
--   (product_id, per_box_qty) — a single product can legitimately have
--   multiple per-box-qty buckets on one voucher (e.g. 1085-per-box from
--   one GRN + 36-per-box from another). The SELECT-then-INSERT logic
--   finds no matching row when scanning the 36-per-box label and proceeds
--   to INSERT a new line.
--
--   But the existing unique key is too narrow: (transfer_id, side, product_id).
--   It rejects the second INSERT with MySQL error 1062 because a row with
--   the same (tid, side, pid) already exists from the 1085-per-box scan.
--   The exception is returned as HTTP 500 to the client and the second
--   line never gets added.
--
-- WHAT THIS FIXES:
--   Widening the unique key to (transfer_id, side, product_id, per_box_qty)
--   matches what the application code intends. Different per-box-qty values
--   for the same product on the same voucher are now allowed and stored as
--   separate line items.
--
-- HOW TO RUN:
--   Connect to YOUR database explicitly (this script does NOT have a
--   USE statement — it operates on whichever database you connected to):
--
--     mysql -u <user> -p hcp_portal < pm_transfer_items_widen_unique_key.sql
--
--   OR in MySQL Workbench, click the database in the schema panel to make
--   it the default, then open and run this file.
--
-- IDEMPOTENT?
--   Yes. Checks information_schema first. If per_box_qty is already in
--   the unique key, the script does nothing.
--
-- NO APPLICATION CODE CHANGES NEEDED. NO FLASK RESTART NEEDED.
-- ============================================================

-- Sanity check: confirm we're connected to a database that has the table.
-- If this returns no rows, you've connected to the wrong database — abort
-- and reconnect with the correct one (e.g. hcp_portal, erpdb, or whatever
-- your Flask app uses).
SELECT
  CONCAT('Connected to database: ', DATABASE(),
         ' — pm_transfer_items table found.') AS sanity_check
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'pm_transfer_items';

-- Show current state of the unique key BEFORE changes
SELECT
  CONCAT('Before: uq_pm_xfer_item columns = ',
         COALESCE(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '),
                  '(index does not exist)')) AS before_state
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'pm_transfer_items'
  AND INDEX_NAME   = 'uq_pm_xfer_item';

-- The actual migration. Wrapped in a stored procedure because MySQL
-- doesn't allow IF/THEN logic at the top level of a script.
DROP PROCEDURE IF EXISTS _hcp_widen_uq_pm_xfer_item;
DELIMITER $$
CREATE PROCEDURE _hcp_widen_uq_pm_xfer_item()
BEGIN
  DECLARE pbq_in_key INT DEFAULT 0;
  DECLARE table_exists INT DEFAULT 0;

  -- Make sure the table exists in the current database before touching it
  SELECT COUNT(*) INTO table_exists
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'pm_transfer_items';

  IF table_exists = 0 THEN
    SELECT CONCAT('ERROR: Table pm_transfer_items does not exist in database ',
                  DATABASE(), '. Did you connect to the right database?') AS result;
  ELSE
    -- Idempotency: only proceed if per_box_qty isn't already in the key
    SELECT COUNT(*) INTO pbq_in_key
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'pm_transfer_items'
      AND INDEX_NAME   = 'uq_pm_xfer_item'
      AND COLUMN_NAME  = 'per_box_qty';

    IF pbq_in_key = 0 THEN
      ALTER TABLE pm_transfer_items DROP INDEX uq_pm_xfer_item;
      ALTER TABLE pm_transfer_items
        ADD UNIQUE KEY uq_pm_xfer_item (transfer_id, side, product_id, per_box_qty);
      SELECT 'WIDENED: uq_pm_xfer_item now includes per_box_qty' AS result;
    ELSE
      SELECT 'NO-OP: uq_pm_xfer_item already includes per_box_qty' AS result;
    END IF;
  END IF;
END $$
DELIMITER ;

CALL _hcp_widen_uq_pm_xfer_item();
DROP PROCEDURE _hcp_widen_uq_pm_xfer_item;

-- Verify the final state
SELECT
  CONCAT('After:  uq_pm_xfer_item columns = ',
         COALESCE(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '),
                  '(index does not exist)')) AS after_state
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'pm_transfer_items'
  AND INDEX_NAME   = 'uq_pm_xfer_item';
