# Market Data Module

## Overview

The Market Data module is responsible for receiving live market data from Upstox Market Data Feed V3 and publishing normalized market events for the rest of TradeMind.

This module is the single entry point for all real-time market data.

It does not calculate indicators, build candles, generate signals, or execute trades.

---

# Purpose

Provide a reliable, event-driven pipeline for receiving live market data from Upstox.

The module should:

- Establish and maintain a WebSocket connection.
- Manage subscriptions.
- Decode protobuf messages.
- Normalize market data.
- Publish events to the internal Event Bus.

---

# Responsibilities

- Connect to Upstox Market Data Feed V3.
- Maintain WebSocket connection.
- Automatically reconnect after connection loss.
- Subscribe and unsubscribe instruments.
- Decode protobuf messages.
- Normalize market data.
- Publish market events.

---

# Non-Responsibilities

This module must NOT:

- Store market data.
- Build candles.
- Calculate indicators.
- Generate trading signals.
- Execute trades.
- Persist data into MySQL.

These responsibilities belong to other modules.

---

# Architecture

Upstox
    │
    ▼
Market Data Feed V3
    │
    ▼
MarketDataWebSocketClient
    │
    ▼
ConnectionManager
    │
    ▼
SubscriptionManager
    │
    ▼
ProtobufDecoder
    │
    ▼
TickProcessor
    │
    ▼
Event Bus (core/events)

---

# Components

## MarketDataWebSocketClient

Responsibilities

- Authenticate
- Connect
- Disconnect
- Send binary messages
- Receive binary messages

---

## ConnectionManager

Responsibilities

- Connection lifecycle
- Connection state
- Automatic reconnect
- Exponential backoff

States

- DISCONNECTED
- CONNECTING
- CONNECTED
- RECONNECTING

---

## SubscriptionManager

Responsibilities

- Subscribe
- Unsubscribe
- Prevent duplicate subscriptions
- Restore subscriptions after reconnect

Supported operations

- subscribe()
- unsubscribe()
- subscribeMany()
- unsubscribeMany()
- getSubscriptions()

---

## ProtobufDecoder

Responsibilities

- Load official Upstox protobuf schema
- Decode binary messages
- Convert protobuf objects into TradeMind DTOs

Public API

decode(buffer)

---

## TickProcessor

Responsibilities

- Validate decoded messages
- Ignore unsupported feed types
- Normalize market data
- Publish domain events

Published events

- market.tick
- market.greeks
- market.depth

---

# Event Flow

Upstox
    │
    ▼
Binary WebSocket Message
    │
    ▼
Protobuf Decoder
    │
    ▼
TradeMind DTO
    │
    ▼
Tick Processor
    │
    ▼
Event Bus
    │
    ├── Historical Candle Module
    ├── Indicator Engine
    ├── Strategy Engine
    └── Dashboard (future)

---

# Initial Instrument Subscriptions

Current version subscribes to:

- NIFTY Index
- BANKNIFTY Index
- SENSEX Index

Future versions will dynamically subscribe to option contracts selected by the Strategy Engine.

---

# External Dependencies

- Upstox Market Data Feed V3
- protobufjs
- Node.js WebSocket
- EventEmitter

---

# Public Interfaces

MarketDataWebSocketClient

- connect()
- disconnect()
- send()

ConnectionManager

- connect()
- disconnect()
- getState()

SubscriptionManager

- subscribe()
- unsubscribe()
- subscribeMany()
- unsubscribeMany()
- getSubscriptions()

ProtobufDecoder

- decode()

TickProcessor

- process()

---

# Future Enhancements

- Heartbeat monitoring
- Subscription batching
- Connection metrics
- Latency monitoring
- Tick buffering
- Multi-feed support
- Market status monitoring
- Dynamic option subscriptions
- Health API
- Performance metrics

---

# Current Status

Version

v0.3.0 (In Progress)

Completed

- WebSocket Client
- Connection Manager
- Subscription Manager
- Protobuf Decoder
- Tick Processor
- Event Bus Integration
- Integration Test

Pending

- End-to-end validation during market hours
- Market Data Status API
- Release v0.3.0