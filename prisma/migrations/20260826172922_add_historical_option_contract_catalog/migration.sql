-- CreateTable
CREATE TABLE `HistoricalOptionContractCatalog` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerContractId` VARCHAR(191) NOT NULL,
    `underlyingSymbol` VARCHAR(191) NOT NULL,
    `exchange` VARCHAR(191) NOT NULL,
    `expiry` DATETIME(3) NOT NULL,
    `strikePrice` DECIMAL(65, 30) NOT NULL,
    `optionType` VARCHAR(191) NOT NULL,
    `exchangeTradingSymbol` VARCHAR(191) NULL,
    `lotSize` INTEGER NULL,
    `tickSize` DECIMAL(65, 30) NULL,
    `metadataState` VARCHAR(191) NOT NULL,
    `discoveredAt` DATETIME(3) NOT NULL,
    `sourceCatalogAsOf` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HistoricalOptionContractCatalog_underlyingSymbol_exchange_idx`(`underlyingSymbol`, `exchange`),
    INDEX `HistoricalOptionContractCatalog_expiry_idx`(`expiry`),
    INDEX `HistoricalOptionContractCatalog_optionType_idx`(`optionType`),
    INDEX `HistoricalOptionContractCatalog_metadataState_idx`(`metadataState`),
    UNIQUE INDEX `HistoricalOptionContractCatalog_provider_providerContractId_key`(`provider`, `providerContractId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
