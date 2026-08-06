-- CreateTable
CREATE TABLE `HistoricalCandle` (
    `id` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `candleTime` DATETIME(3) NOT NULL,
    `open` DECIMAL(65, 30) NOT NULL,
    `high` DECIMAL(65, 30) NOT NULL,
    `low` DECIMAL(65, 30) NOT NULL,
    `close` DECIMAL(65, 30) NOT NULL,
    `volume` BIGINT NOT NULL,
    `openInterest` BIGINT NULL,
    `source` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HistoricalCandle_instrumentKey_idx`(`instrumentKey`),
    INDEX `HistoricalCandle_timeframe_idx`(`timeframe`),
    INDEX `HistoricalCandle_candleTime_idx`(`candleTime`),
    INDEX `HistoricalCandle_instrumentKey_timeframe_idx`(`instrumentKey`, `timeframe`),
    INDEX `HistoricalCandle_instrumentKey_timeframe_candleTime_idx`(`instrumentKey`, `timeframe`, `candleTime`),
    UNIQUE INDEX `HistoricalCandle_instrumentKey_timeframe_candleTime_key`(`instrumentKey`, `timeframe`, `candleTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HistoricalCandleSyncLog` (
    `id` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `downloaded` INTEGER NOT NULL DEFAULT 0,
    `inserted` INTEGER NOT NULL DEFAULT 0,
    `updated` INTEGER NOT NULL DEFAULT 0,
    `durationMs` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL,
    `errorMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HistoricalCandleSyncLog_instrumentKey_idx`(`instrumentKey`),
    INDEX `HistoricalCandleSyncLog_timeframe_idx`(`timeframe`),
    INDEX `HistoricalCandleSyncLog_status_idx`(`status`),
    INDEX `HistoricalCandleSyncLog_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
