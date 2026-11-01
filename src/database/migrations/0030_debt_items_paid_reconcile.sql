-- Reconcile per-product paid amounts with the debt-level paid pool.
--
-- Debt-level payments historically updated only debtors.paid_amount, leaving
-- every debt_items row at paid_amount = 0 even when the customer had already
-- paid part of the debt. The ledger then showed products as fully unpaid and
-- the per-product "remaining" was wrong. This one-time pass spreads each
-- debtor's paid pool over its products (oldest rows first, FIFO) so that
-- SUM(debt_items.paid_amount) matches debtors.paid_amount everywhere.
--
-- Idempotent: rows that already match are skipped, so re-running is a no-op.

WITH ordered AS (
  SELECT di.id,
         COALESCE(di.total_price, 0) AS total_price,
         COALESCE(d.paid_amount, 0) AS debt_paid,
         COALESCE(SUM(COALESCE(di.total_price, 0)) OVER (
           PARTITION BY di.debtor_id
           ORDER BY di.created_at ASC, di.id ASC
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS before_sum
  FROM debt_items di
  JOIN debtors d ON d.id = di.debtor_id
  WHERE COALESCE(d.paid_amount, 0) > 0
    -- Only debtors whose per-item sum does NOT match the debt pool are fixed;
    -- debts with explicit per-item payments already in sync are left untouched.
    AND ABS(COALESCE((SELECT SUM(di2.paid_amount) FROM debt_items di2 WHERE di2.debtor_id = di.debtor_id), 0) - COALESCE(d.paid_amount, 0)) > 0.01
)
UPDATE debt_items di
SET paid_amount = x.alloc
FROM (
  SELECT id, LEAST(total_price, GREATEST(0, debt_paid - before_sum)) AS alloc
  FROM ordered
) x
WHERE di.id = x.id
  AND COALESCE(di.paid_amount, 0) IS DISTINCT FROM x.alloc;
