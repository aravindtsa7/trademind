-- CreateTable
CREATE TABLE `HistoricalOptionCandle` (
    `id` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `tradingSymbol` VARCHAR(191) NULL,
    `optionType` VARCHAR(191) NULL,
    `strikePrice` DECIMAL(65, 30) NULL,
    `expiry` DATETIME(3) NULL,
    `timeframe` VARCHAR(191) NOT NULL,
    `candleTime` DATETIME(3) NOT NULL,
    `open` DECIMAL(65, 30) NOT NULL,
    `high` DECIMAL(65, 30) NOT NULL,
    `low` DECIMAL(65, 30) NOT NULL,
    `close` DECIMAL(65, 30) NOT NULL,
    `volume` BIGINT NOT NULL,
    `openInterest` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HistoricalOptionCandle_instrumentKey_timeframe_idx`(`instrumentKey`, `timeframe`),
    INDEX `HistoricalOptionCandle_candleTime_idx`(`candleTime`),
    UNIQUE INDEX `HistoricalOptionCandle_instrumentKey_timeframe_candleTime_key`(`instrumentKey`, `timeframe`, `candleTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
