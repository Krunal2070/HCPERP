-- ============================================================================
-- Fix the "Duplicate entry 'PM-AL-0001' for key 'pm_transfers.transfer_no'" issue.
--
-- Context:
--   helpers.py's _next_voucher_no() was falling through to a hardcoded
--   "{vtype}-0001" return whenever the pm_voucher_sequences row keyed by
--   'PM-AL' didn't exist. That returned the same string on every attempt,
--   so the second allotment crashed on the UNIQUE constraint.
--
--   The code is now fixed in helpers.py, but the database has:
--     1. A stale PM-AL-0001 row in pm_transfers (from the first attempt),
--        possibly with no items — that's what's blocking new attempts.
--     2. A pm_voucher_sequences row keyed by voucher_type='allotment'
--        instead of the 'PM-AL' key the code expects.
--
-- Run section A first to see what's actually there, decide, then run B/C/D.
-- ============================================================================

-- ── A. INSPECT ─────────────────────────────────────────────────────────────
-- What PM-AL transfers exist?
SELECT transfer_id, transfer_no, from_godown_id, to_godown_id, voucher_type,
       status, out_by, created_at, remarks
FROM   pm_transfers
WHERE  transfer_no LIKE 'PM-AL%'
ORDER  BY transfer_id;

-- Are there any items / box scans attached to that PM-AL-0001 transfer?
-- If items is 0, it's an empty stub that's safe to delete.
SELECT t.transfer_id,
       t.transfer_no,
       (SELECT COUNT(*) FROM pm_transfer_items WHERE transfer_id=t.transfer_id) AS items,
       (SELECT COUNT(*) FROM pm_box_scans     WHERE transfer_id=t.transfer_id) AS box_scans
FROM   pm_transfers t
WHERE  t.transfer_no = 'PM-AL-0001';

-- Current state of the voucher-sequences row
SELECT * FROM pm_voucher_sequences WHERE prefix='PM-AL' OR voucher_type IN ('PM-AL','allotment');


-- ── B. DELETE the orphan stub (ONLY if section A shows items=0 box_scans=0) ─
-- If it's a real voucher with line items, do NOT run this — rename instead
-- (see section C).
START TRANSACTION;

DELETE FROM pm_transfer_audit WHERE transfer_id IN
    (SELECT transfer_id FROM pm_transfers WHERE transfer_no = 'PM-AL-0001');

DELETE FROM pm_transfers
WHERE  transfer_no = 'PM-AL-0001'
AND    NOT EXISTS (SELECT 1 FROM pm_transfer_items WHERE transfer_id = pm_transfers.transfer_id)
AND    NOT EXISTS (SELECT 1 FROM pm_box_scans      WHERE transfer_id = pm_transfers.transfer_id);

COMMIT;


-- ── C. RENAME the orphan stub to the proper format (alternative to B) ──────
-- Use this instead of B if PM-AL-0001 has real items/scans you want to keep.
-- It rewrites the bad dash-format number into the proper slash/FY format so
-- new allotments can increment cleanly from 0002 onward.
-- UPDATE pm_transfers
-- SET    transfer_no = 'PM-AL/26-27/0001'
-- WHERE  transfer_no = 'PM-AL-0001';


-- ── D. NORMALISE the pm_voucher_sequences row ───────────────────────────────
-- The code keys on voucher_type='PM-AL'. Your existing row uses 'allotment'.
-- After this update the legacy increment path can also work — but even
-- without this, the helpers.py fix makes the table-scan recovery path do
-- the right thing.
UPDATE pm_voucher_sequences
SET    voucher_type = 'PM-AL'
WHERE  voucher_type = 'allotment' AND prefix = 'PM-AL';

-- Verify
SELECT * FROM pm_voucher_sequences WHERE voucher_type='PM-AL';
