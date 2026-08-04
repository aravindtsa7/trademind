-- CreateTable
CREATE TABLE `Instrument` (
    `id` VARCHAR(191) NOT NULL,
    `instrumentKey` VARCHAR(191) NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `segment` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `tradingSymbol` VARCHAR(191) NOT NULL,
    `instrumentType` VARCHAR(191) NOT NULL,
    `expiry` DATETIME(3) NOT NULL,
    `strikePrice` DECIMAL(65, 30) NOT NULL,
    `lotSize` INTEGER NOT NULL,
    `tickSize` DECIMAL(65, 30) NOT NULL,
    `weekly` BOOLEAN NOT NULL DEFAULT false,
    `isin` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Instrument_instrumentKey_key`(`instrumentKey`),
    INDEX `Instrument_underlyingSymbol_idx`(`underlyingSymbol`),
    INDEX `Instrument_expiry_idx`(`expiry`),
    INDEX `Instrument_instrumentType_idx`(`instrumentType`),
    INDEX `Instrument_strikePrice_idx`(`strikePrice`),
    INDEX `Instrument_underlyingSymbol_expiry_idx`(`underlyingSymbol`, `expiry`),
    INDEX `Instrument_underlyingSymbol_instrumentType_idx`(`underlyingSymbol`, `instrumentType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InstrumentSyncLog` (
    `id` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `downloaded` INTEGER NOT NULL DEFAULT 0,
    `filtered` INTEGER NOT NULL DEFAULT 0,
    `inserted` INTEGER NOT NULL DEFAULT 0,
    `updated` INTEGER NOT NULL DEFAULT 0,
    `inactivated` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL,
    `errorMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
