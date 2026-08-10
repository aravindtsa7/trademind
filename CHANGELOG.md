# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by Keep a Changelog, with versions corresponding to major project milestones.

---

## [v0.2.0] - 2026-08-04

### 🎉 Major Milestone
Completed the Instrument Sync module.

### Added
- Instrument feature module
- Upstox Instrument Client
- Instrument Repository
- Instrument Sync Service
- Instrument Sync Controller
- Instrument Sync API
- Instrument Sync Summary DTO
- InstrumentSyncLog database model
- Instrument database model
- MySQL support using Prisma
- Initial Prisma migration

### API Endpoints
- `POST /api/instruments/sync`

### Features
- Downloads the official Upstox Instrument Master
- Decompresses the GZIP file
- Parses the JSON data
- Filters only:
  - NIFTY Options
  - BANKNIFTY Options
  - SENSEX Options
- Stores all CE and PE contracts across all expiries
- Marks missing contracts as inactive
- Records synchronization history

### Database
- Migrated Prisma datasource from SQLite to MySQL
- Added Instrument table
- Added InstrumentSyncLog table
- Added indexes for high-performance option lookups

### Validation
- Downloaded: **120,570** instruments
- Filtered: **5,552** supported option contracts
- Inserted: **5,552** records
- Build passed
- End-to-end synchronization tested successfully

---

## [v0.1.0] - 2026-08-04

### 🎉 Major Milestone
Completed Upstox OAuth Authentication.

### Added
- Upstox OAuth authentication flow
- Access token exchange
- User profile endpoint
- Environment configuration
- Upstox API client
- Authentication routes
- Authentication controller
- Authentication service

### API Endpoints
- `GET /api/upstox/auth/url`
- `GET /api/upstox/auth/callback`
- `GET /api/upstox/profile`

### Validation
- Successfully authenticated with Upstox
- Successfully retrieved user profile
- Access token generation verified
- Build passed

---

## Roadmap

### ✅ Completed
- Project Foundation
- Upstox Authentication
- Instrument Synchronization

### 🚧 In Progress
- Historical Candles

### 📅 Planned
- Live WebSocket Market Data
- Indicator Engine
- Strategy Engine
- Signal Engine
- Paper Trading Engine
- AI Learning & Optimization

## v0.5.0 - Indicator Engine

### Added

- Indicator Core architecture
- Session-aware timeframe aggregation
- SMA
- EMA
- RSI
- VWAP
- ATR
- MACD
- Bollinger Bands
- ADX
- SuperTrend
- Indicator Engine
- Comprehensive unit tests
- Real MySQL integration test using NIFTY historical candles

## [v0.6.1] - 2026-08-07

### Added

- Performance Analyzer
- Strategy Analyzer
- Parameter Analyzer
- Market Regime Analyzer
- Regime-aware Strategy Analyzer
- Research Runner
- Research Report Generator
- Real NIFTY research integration testing

### Research Validation

Evaluated EMA Cross and EMA Trend Confirmation using:

- 19 complete NIFTY sessions
- 1,425 five-minute candles

EMA Cross:
- 21 signals
- 61.11% 60-minute directional accuracy
- Average 60-minute directional move: +8.82 points
- Average MFE: 38.48
- Average MAE: 28.52

EMA Trend Confirmation:
- 15 signals
- 50.00% 60-minute directional accuracy
- Average 60-minute directional move: +5.24 points
- Average MFE: 35.74
- Average MAE: 33.44