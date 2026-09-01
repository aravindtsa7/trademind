-- CreateTable
CREATE TABLE `HistoricalCandleRepairEvidence` (
    `id` VARCHAR(191) NOT NULL,
    `primaryRetrievalId` VARCHAR(191) NOT NULL,
    `primarySessionId` VARCHAR(191) NOT NULL,
    `repairProviderId` VARCHAR(191) NOT NULL,
    `repairRetrievalId` VARCHAR(191) NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `tradingDate` VARCHAR(191) NOT NULL,
    `expectedMinuteCount` INTEGER NOT NULL,
    `primaryAcceptedRowCount` INTEGER NOT NULL,
    `missingMinuteCount` INTEGER NOT NULL,
    `repairAcceptedMinuteCount` INTEGER NOT NULL,
    `corroboratedOverlapCount` INTEGER NOT NULL,
    `conflictingOverlapCount` INTEGER NOT NULL,
    `outcome` VARCHAR(191) NOT NULL,
    `resultingSessionId` VARCHAR(191) NULL,
    `missingMinutesChecksum` VARCHAR(191) NOT NULL,
    `repairSemanticChecksum` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HistoricalCandleRepairEvidence_instrumentKey_timeframe_tradi_idx`(`instrumentKey`, `timeframe`, `tradingDate`),
    INDEX `HistoricalCandleRepairEvidence_primarySessionId_idx`(`primarySessionId`),
    INDEX `HistoricalCandleRepairEvidence_resultingSessionId_idx`(`resultingSessionId`),
    INDEX `HistoricalCandleRepairEvidence_outcome_idx`(`outcome`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HistoricalCandleRepairEvidence` ADD CONSTRAINT `HistoricalCandleRepairEvidence_primarySessionId_fkey` FOREIGN KEY (`primarySessionId`) REFERENCES `HistoricalDataRetrievalSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HistoricalCandleRepairEvidence` ADD CONSTRAINT `HistoricalCandleRepairEvidence_resultingSessionId_fkey` FOREIGN KEY (`resultingSessionId`) REFERENCES `HistoricalDataRetrievalSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
