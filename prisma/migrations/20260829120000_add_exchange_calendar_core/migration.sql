-- CreateTable
CREATE TABLE `ExchangeCalendarCoverage` (
    `id` VARCHAR(191) NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `segment` VARCHAR(191) NOT NULL,
    `calendarYear` INTEGER NOT NULL,
    `coverageFrom` DATETIME(3) NOT NULL,
    `coverageTo` DATETIME(3) NOT NULL,
    `version` INTEGER NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `sourceAuthority` VARCHAR(191) NOT NULL,
    `sourceBundleChecksum` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ExchangeCalendarCoverage_exchange_segment_calendarYear_statu_idx`(`exchange`, `segment`, `calendarYear`, `status`),
    INDEX `ExchangeCalendarCoverage_exchange_segment_calendarYear_cover_idx`(`exchange`, `segment`, `calendarYear`, `coverageFrom`, `coverageTo`),
    UNIQUE INDEX `ExchangeCalendarCoverage_exchange_segment_calendarYear_versi_key`(`exchange`, `segment`, `calendarYear`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExchangeCalendarScopeLock` (
    `id` VARCHAR(191) NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `segment` VARCHAR(191) NOT NULL,
    `calendarYear` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExchangeCalendarScopeLock_exchange_segment_calendarYear_key`(`exchange`, `segment`, `calendarYear`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExchangeCalendarSourceDocument` (
    `id` VARCHAR(191) NOT NULL,
    `coverageId` VARCHAR(191) NOT NULL,
    `documentReference` VARCHAR(191) NOT NULL,
    `documentType` VARCHAR(191) NOT NULL,
    `contentChecksumSha256` VARCHAR(191) NOT NULL,
    `referenceUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ExchangeCalendarSourceDocument_coverageId_documentReference_key`(`coverageId`, `documentReference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExchangeCalendarDay` (
    `id` VARCHAR(191) NOT NULL,
    `coverageId` VARCHAR(191) NOT NULL,
    `tradingDate` DATETIME(3) NOT NULL,
    `classification` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `sourceDocumentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ExchangeCalendarDay_tradingDate_idx`(`tradingDate`),
    INDEX `ExchangeCalendarDay_sourceDocumentId_idx`(`sourceDocumentId`),
    UNIQUE INDEX `ExchangeCalendarDay_coverageId_tradingDate_key`(`coverageId`, `tradingDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExchangeCalendarSessionWindow` (
    `id` VARCHAR(191) NOT NULL,
    `calendarDayId` VARCHAR(191) NOT NULL,
    `windowIndex` INTEGER NOT NULL,
    `openMinuteIst` INTEGER NOT NULL,
    `closeMinuteIst` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ExchangeCalendarSessionWindow_calendarDayId_windowIndex_key`(`calendarDayId`, `windowIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ExchangeCalendarSourceDocument` ADD CONSTRAINT `ExchangeCalendarSourceDocument_coverageId_fkey` FOREIGN KEY (`coverageId`) REFERENCES `ExchangeCalendarCoverage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExchangeCalendarDay` ADD CONSTRAINT `ExchangeCalendarDay_coverageId_fkey` FOREIGN KEY (`coverageId`) REFERENCES `ExchangeCalendarCoverage`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExchangeCalendarDay` ADD CONSTRAINT `ExchangeCalendarDay_sourceDocumentId_fkey` FOREIGN KEY (`sourceDocumentId`) REFERENCES `ExchangeCalendarSourceDocument`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExchangeCalendarSessionWindow` ADD CONSTRAINT `ExchangeCalendarSessionWindow_calendarDayId_fkey` FOREIGN KEY (`calendarDayId`) REFERENCES `ExchangeCalendarDay`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
