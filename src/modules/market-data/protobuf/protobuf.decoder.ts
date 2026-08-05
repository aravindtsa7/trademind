import protobuf from 'protobufjs';
import logger from '../../../core/logger/logger';

const upstoxMarketDataFeedV3Proto = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;

message LTPC { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; }
message MarketLevel { repeated Quote bidAskQuote = 1; }
message MarketOHLC { repeated OHLC ohlc = 1; }
message Quote { int64 bidQ = 1; double bidP = 2; int64 askQ = 3; double askP = 4; }
message OptionGreeks { double delta = 1; double theta = 2; double gamma = 3; double vega = 4; double rho = 5; }
message OHLC { string interval = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 vol = 6; int64 ts = 7; }
enum Type { initial_feed = 0; live_feed = 1; market_info = 2; }
message MarketFullFeed {
  LTPC ltpc = 1;
  MarketLevel marketLevel = 2;
  OptionGreeks optionGreeks = 3;
  MarketOHLC marketOHLC = 4;
  double atp = 5;
  int64 vtt = 6;
  double oi = 7;
  double iv = 8;
  double tbq = 9;
  double tsq = 10;
}
message IndexFullFeed { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; }
message FullFeed {
  oneof FullFeedUnion { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; }
}
message FirstLevelWithGreeks {
  LTPC ltpc = 1;
  Quote firstDepth = 2;
  OptionGreeks optionGreeks = 3;
  int64 vtt = 4;
  double oi = 5;
  double iv = 6;
}
message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    FirstLevelWithGreeks firstLevelWithGreeks = 3;
  }
  RequestMode requestMode = 4;
}
enum RequestMode { ltpc = 0; full_d5 = 1; option_greeks = 2; full_d30 = 3; }
enum MarketStatus {
  PRE_OPEN_START = 0;
  PRE_OPEN_END = 1;
  NORMAL_OPEN = 2;
  NORMAL_CLOSE = 3;
  CLOSING_START = 4;
  CLOSING_END = 5;
}
message MarketInfo { map<string, MarketStatus> segmentStatus = 1; }
message FeedResponse {
  Type type = 1;
  map<string, Feed> feeds = 2;
  int64 currentTs = 3;
  MarketInfo marketInfo = 4;
}
`;

export type MarketDataFeedType = 'initial_feed' | 'live_feed' | 'market_info';
export type MarketDataRequestMode = 'ltpc' | 'full_d5' | 'option_greeks' | 'full_d30';
export type MarketDataMarketStatus =
  | 'PRE_OPEN_START'
  | 'PRE_OPEN_END'
  | 'NORMAL_OPEN'
  | 'NORMAL_CLOSE'
  | 'CLOSING_START'
  | 'CLOSING_END';

export interface LtpcDto {
  ltp?: number;
  ltt?: string;
  ltq?: string;
  cp?: number;
}

export interface QuoteDto {
  bidQ?: string;
  bidP?: number;
  askQ?: string;
  askP?: number;
}

export interface OhlcDto {
  interval?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  vol?: string;
  ts?: string;
}

export interface OptionGreeksDto {
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
}

export interface MarketDataFeedDto {
  ltpc?: LtpcDto;
  fullFeed?: {
    marketFF?: {
      ltpc?: LtpcDto;
      marketLevel?: { bidAskQuote?: QuoteDto[] };
      optionGreeks?: OptionGreeksDto;
      marketOHLC?: { ohlc?: OhlcDto[] };
      atp?: number;
      vtt?: string;
      oi?: number;
      iv?: number;
      tbq?: number;
      tsq?: number;
    };
    indexFF?: {
      ltpc?: LtpcDto;
      marketOHLC?: { ohlc?: OhlcDto[] };
    };
  };
  firstLevelWithGreeks?: {
    ltpc?: LtpcDto;
    firstDepth?: QuoteDto;
    optionGreeks?: OptionGreeksDto;
    vtt?: string;
    oi?: number;
    iv?: number;
  };
  requestMode?: MarketDataRequestMode;
}

export interface MarketDataFeedResponseDto {
  type?: MarketDataFeedType;
  feeds: Record<string, MarketDataFeedDto>;
  currentTs?: string;
  marketInfo?: {
    segmentStatus: Record<string, MarketDataMarketStatus>;
  };
}

interface DecodedFeedResponse extends MarketDataFeedResponseDto {}

export default class ProtobufDecoder {
  private feedResponseType: protobuf.Type;

  constructor() {
    const root = protobuf.parse(upstoxMarketDataFeedV3Proto).root;
    this.feedResponseType = root.lookupType(
      'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse'
    );
  }

  decode(buffer: Buffer): MarketDataFeedResponseDto {
    try {
      const decoded = this.feedResponseType.decode(buffer);
      const decodedResponse = this.feedResponseType.toObject(decoded, {
        longs: String,
        enums: String,
        arrays: true,
        objects: true,
      }) as DecodedFeedResponse;

      return this.mapFeedResponse(decodedResponse);
    } catch (error) {
      logger.error('Failed to decode Upstox market data protobuf message', { error });
      throw error;
    }
  }

  private mapFeedResponse(response: DecodedFeedResponse): MarketDataFeedResponseDto {
    return {
      type: response.type,
      feeds: Object.fromEntries(
        Object.entries(response.feeds ?? {}).map(([instrumentKey, feed]) => [
          instrumentKey,
          this.mapFeed(feed),
        ])
      ),
      currentTs: response.currentTs,
      marketInfo: response.marketInfo
        ? { segmentStatus: { ...response.marketInfo.segmentStatus } }
        : undefined,
    };
  }

  private mapFeed(feed: MarketDataFeedDto): MarketDataFeedDto {
    return {
      ltpc: feed.ltpc ? { ...feed.ltpc } : undefined,
      fullFeed: feed.fullFeed
        ? {
            marketFF: feed.fullFeed.marketFF
              ? {
                  ...feed.fullFeed.marketFF,
                  ltpc: feed.fullFeed.marketFF.ltpc
                    ? { ...feed.fullFeed.marketFF.ltpc }
                    : undefined,
                  marketLevel: feed.fullFeed.marketFF.marketLevel
                    ? {
                        bidAskQuote: feed.fullFeed.marketFF.marketLevel.bidAskQuote?.map((quote) => ({
                          ...quote,
                        })),
                      }
                    : undefined,
                  optionGreeks: feed.fullFeed.marketFF.optionGreeks
                    ? { ...feed.fullFeed.marketFF.optionGreeks }
                    : undefined,
                  marketOHLC: feed.fullFeed.marketFF.marketOHLC
                    ? {
                        ohlc: feed.fullFeed.marketFF.marketOHLC.ohlc?.map((ohlc) => ({ ...ohlc })),
                      }
                    : undefined,
                }
              : undefined,
            indexFF: feed.fullFeed.indexFF
              ? {
                  ...feed.fullFeed.indexFF,
                  ltpc: feed.fullFeed.indexFF.ltpc ? { ...feed.fullFeed.indexFF.ltpc } : undefined,
                  marketOHLC: feed.fullFeed.indexFF.marketOHLC
                    ? {
                        ohlc: feed.fullFeed.indexFF.marketOHLC.ohlc?.map((ohlc) => ({ ...ohlc })),
                      }
                    : undefined,
                }
              : undefined,
          }
        : undefined,
      firstLevelWithGreeks: feed.firstLevelWithGreeks
        ? {
            ...feed.firstLevelWithGreeks,
            ltpc: feed.firstLevelWithGreeks.ltpc ? { ...feed.firstLevelWithGreeks.ltpc } : undefined,
            firstDepth: feed.firstLevelWithGreeks.firstDepth
              ? { ...feed.firstLevelWithGreeks.firstDepth }
              : undefined,
            optionGreeks: feed.firstLevelWithGreeks.optionGreeks
              ? { ...feed.firstLevelWithGreeks.optionGreeks }
              : undefined,
          }
        : undefined,
      requestMode: feed.requestMode,
    };
  }
}
