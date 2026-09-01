/*
  Warnings:

  - Added the optional columns `calendarDisposition`, `primaryProviderId`, `repairPolicyVersion`
    to the `HistoricalCandleRepairEvidence` table. NULLABLE, with no default -- this table was
    created by the prior migration (20260831171125_add_historical_candle_repair_evidence) and may
    already contain rows written before this migration existed. This migration must remain safe to
    apply whether that table is empty or already holds rows: it never fabricates a value for an
    existing row's new columns (no calendar window, primary provider, or repair-policy version can
    be truthfully reconstructed for a row that never recorded them), so existing rows simply read
    back NULL for all three. Application code (`HistoricalCandleRepairEvidenceService.
    recordRepairAttempt`) always supplies all three for every NEWLY WRITTEN row -- these columns are
    NULL only for legacy rows pre-dating this migration, never for a row this milestone's code path
    creates. `HistoricalDataRetrievalEvidenceService.findLatestAvailableSessionEvidence`'s composite
    lookup explicitly requires all three to be non-NULL before treating a `REPAIR_ACCEPTED` row as
    full composite provenance -- a legacy/incomplete row is therefore fail-closed, distinguishable
    from a fully-provenanced row, and never masqueraded as one (see that service's doc comment).

  - Corrects a defect in the originally-drafted version of this migration (never applied to any
    shared database -- see `git log`/PR history for this file): it referenced the lower-case
    identifier `historicalcandlerepairevidence`, but the prior migration created the table as
    `HistoricalCandleRepairEvidence` (exact case). MySQL's default Windows/macOS development
    configuration (`lower_case_table_names=1` or `=2`) silently tolerates a case mismatch, but a
    case-sensitive Linux production MySQL (`lower_case_table_names=0`, the common production
    default) would fail this statement outright with "table doesn't exist", and a chain-validation
    test in this milestone (`src/modules/research-lake/prisma-migration-chain.integration.test.ts`)
    now applies every migration's literal SQL against a fresh database specifically to catch this
    class of defect before deployment.
*/
-- AlterTable
ALTER TABLE `HistoricalCandleRepairEvidence` ADD COLUMN `calendarDisposition` VARCHAR(191) NULL,
    ADD COLUMN `primaryProviderId` VARCHAR(191) NULL,
    ADD COLUMN `repairPolicyVersion` INTEGER NULL;

-- CreateTable
CREATE TABLE `HistoricalCandleRepairSessionWindow` (
    `id` VARCHAR(191) NOT NULL,
    `repairEvidenceId` VARCHAR(191) NOT NULL,
    `windowIndex` INTEGER NOT NULL,
    `openMinuteIst` INTEGER NOT NULL,
    `closeMinuteIst` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `HistoricalCandleRepairSessionWindow_repairEvidenceId_windowI_key`(`repairEvidenceId`, `windowIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HistoricalCandleRepairContribution` (
    `id` VARCHAR(191) NOT NULL,
    `repairEvidenceId` VARCHAR(191) NOT NULL,
    `candleTime` DATETIME(3) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `repairProviderId` VARCHAR(191) NOT NULL,
    `repairRetrievalId` VARCHAR(191) NULL,
    `repairContentChecksum` VARCHAR(191) NOT NULL,
    `primaryContentChecksum` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HistoricalCandleRepairContribution_repairEvidenceId_idx`(`repairEvidenceId`),
    INDEX `HistoricalCandleRepairContribution_candleTime_idx`(`candleTime`),
    UNIQUE INDEX `HistoricalCandleRepairContribution_repairEvidenceId_candleTi_key`(`repairEvidenceId`, `candleTime`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HistoricalCandleRepairSessionWindow` ADD CONSTRAINT `HistoricalCandleRepairSessionWindow_repairEvidenceId_fkey` FOREIGN KEY (`repairEvidenceId`) REFERENCES `HistoricalCandleRepairEvidence`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HistoricalCandleRepairContribution` ADD CONSTRAINT `HistoricalCandleRepairContribution_repairEvidenceId_fkey` FOREIGN KEY (`repairEvidenceId`) REFERENCES `HistoricalCandleRepairEvidence`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
