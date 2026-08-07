export type CandleTimeframe = '1m' | '5m' | '15m' | '30m' | '60m';

export type IncompleteBucketHandling = 'reject' | 'discard';

export interface CandleTimeframeAggregationOptions {
  incompleteLeadingBucket?: IncompleteBucketHandling;
  incompleteTrailingBucket?: IncompleteBucketHandling;
}
