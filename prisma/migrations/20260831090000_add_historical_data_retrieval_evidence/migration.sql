-- CreateTable
CREATE TABLE `HistoricalDataRetrieval` (
    `id` VARCHAR(191) NOT NULL,
    `providerId` VARCHAR(191) NOT NULL,
    `assetType` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `requestedFromDate` VARCHAR(191) NOT NULL,
    `requestedToDate` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `providerCallAttempts` INTEGER NOT NULL DEFAULT 0,
    `sourceRowCount` INTEGER NULL,
    `sourceRowsSemanticChecksum` VARCHAR(191) NULL,
    `errorCategory` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HistoricalDataRetrieval_instrumentKey_timeframe_idx`(`instrumentKey`, `timeframe`),
    INDEX `HistoricalDataRetrieval_status_idx`(`status`),
    INDEX `HistoricalDataRetrieval_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HistoricalDataRetrievalSession` (
    `id` VARCHAR(191) NOT NULL,
    `retrievalId` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `tradingDate` VARCHAR(191) NOT NULL,
    `calendarDisposition` VARCHAR(191) NOT NULL,
    `expectedMinuteCount` INTEGER NOT NULL,
    `providerRowCountForDate` INTEGER NOT NULL,
    `acceptedRowCount` INTEGER NOT NULL,
    `excludedRowCount` INTEGER NOT NULL,
    `sourceOrderAnomalyCount` INTEGER NOT NULL,
    `healthStatus` VARCHAR(191) NOT NULL,
    `persistenceOutcome` VARCHAR(191) NOT NULL,
    `sourceRowsSemanticChecksum` VARCHAR(191) NULL,
    `canonicalContentChecksum` VARCHAR(191) NULL,
    `evidenceSemanticChecksum` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HistoricalDataRetrievalSession_instrumentKey_timeframe_tradi_idx`(`instrumentKey`, `timeframe`, `tradingDate`),
    INDEX `HistoricalDataRetrievalSession_persistenceOutcome_idx`(`persistenceOutcome`),
    UNIQUE INDEX `HistoricalDataRetrievalSession_retrievalId_tradingDate_key`(`retrievalId`, `tradingDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HistoricalCandleConflict` (
    `id` VARCHAR(191) NOT NULL,
    `retrievalSessionId` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `candleTime` DATETIME(3) NOT NULL,
    `existingOpen` DECIMAL(65, 30) NOT NULL,
    `existingHigh` DECIMAL(65, 30) NOT NULL,
    `existingLow` DECIMAL(65, 30) NOT NULL,
    `existingClose` DECIMAL(65, 30) NOT NULL,
    `existingVolume` BIGINT NOT NULL,
    `existingOpenInterest` BIGINT NULL,
    `incomingOpen` DECIMAL(65, 30) NOT NULL,
    `incomingHigh` DECIMAL(65, 30) NOT NULL,
    `incomingLow` DECIMAL(65, 30) NOT NULL,
    `incomingClose` DECIMAL(65, 30) NOT NULL,
    `incomingVolume` BIGINT NOT NULL,
    `incomingOpenInterest` BIGINT NULL,
    `existingContentChecksum` VARCHAR(191) NOT NULL,
    `incomingContentChecksum` VARCHAR(191) NOT NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HistoricalCandleConflict_instrumentKey_timeframe_candleTime_idx`(`instrumentKey`, `timeframe`, `candleTime`),
    INDEX `HistoricalCandleConflict_retrievalSessionId_idx`(`retrievalSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `HistoricalDataRetrievalSession` ADD CONSTRAINT `HistoricalDataRetrievalSession_retrievalId_fkey` FOREIGN KEY (`retrievalId`) REFERENCES `HistoricalDataRetrieval`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HistoricalCandleConflict` ADD CONSTRAINT `HistoricalCandleConflict_retrievalSessionId_fkey` FOREIGN KEY (`retrievalSessionId`) REFERENCES `HistoricalDataRetrievalSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
