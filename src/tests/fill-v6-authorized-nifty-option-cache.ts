import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';

dotenv.config(); logger.silent = true;
const requests = [
  { direction:'CE', instrumentKey:'NSE_FO|40747|07-04-2026', tradingDate:'2026-04-07' }, { direction:'CE', instrumentKey:'NSE_FO|54794|13-04-2026', tradingDate:'2026-04-13' }, { direction:'CE', instrumentKey:'NSE_FO|63424|21-04-2026', tradingDate:'2026-04-17' }, { direction:'CE', instrumentKey:'NSE_FO|72269|28-04-2026', tradingDate:'2026-04-24' }, { direction:'CE', instrumentKey:'NSE_FO|42272|09-06-2026', tradingDate:'2026-06-08' }, { direction:'CE', instrumentKey:'NSE_FO|50607|16-06-2026', tradingDate:'2026-06-15' }, { direction:'CE', instrumentKey:'NSE_FO|65774|04-08-2026', tradingDate:'2026-07-30' },
  { direction:'PE', instrumentKey:'NSE_FO|63437|21-04-2026', tradingDate:'2026-04-16' }, { direction:'PE', instrumentKey:'NSE_FO|63457|21-04-2026', tradingDate:'2026-04-20' }, { direction:'PE', instrumentKey:'NSE_FO|72272|28-04-2026', tradingDate:'2026-04-28' }, { direction:'PE', instrumentKey:'NSE_FO|57027|02-06-2026', tradingDate:'2026-06-02' }, { direction:'PE', instrumentKey:'NSE_FO|51384|14-07-2026', tradingDate:'2026-07-10' }, { direction:'PE', instrumentKey:'NSE_FO|57347|21-07-2026', tradingDate:'2026-07-17' }, { direction:'PE', instrumentKey:'NSE_FO|65700|04-08-2026', tradingDate:'2026-07-29' },
] as const;
const artifact = resolve(process.cwd(),'artifacts','v6-sideways-mean-reversion','authorized-fill-report.json');

async function run():Promise<void>{
  if(process.env.V6_NIFTY_CACHE_FILL_AUTHORIZED!=='true')throw new Error('Set V6_NIFTY_CACHE_FILL_AUTHORIZED=true to execute this exact 14-session guarded fill.');
  const token=process.env.UPSTOX_ACCESS_TOKEN?.trim();if(!token)throw new Error('Set UPSTOX_ACCESS_TOKEN in .env.');
  const repository=new HistoricalOptionCandleRepository();const preloader=new HistoricalOptionResearchPreloaderService(new HistoricalCandleRepository(),repository,new HistoricalOptionCandleCacheService(repository,new UpstoxExpiredOptionCandleClient(token)));
  const before=await preloader.inspectLocalOptionSessions(requests);const notEmpty=before.sessions.filter((entry)=>entry.locallyAvailableCandleCount!==0);if(notEmpty.length)throw new Error(`Refusing V6 fill: an authorized request is no longer empty: ${JSON.stringify(notEmpty)}.`);
  const cache=new HistoricalOptionCandleCacheService(repository,new UpstoxExpiredOptionCandleClient(token));const completed:unknown[]=[];
  for(const request of requests){
    try{await cache.getCandles(request.instrumentKey,request.tradingDate);const result=cache.getSessionResults().at(-1);if(result?.status!=='downloaded'||result.downloadedCandleCount!==375||result.storedCandleCount!==375)throw new Error(`Unexpected V6 fill status for ${request.instrumentKey} ${request.tradingDate}: ${JSON.stringify(result)}.`);completed.push({...request,result});}
    catch(error){const result=cache.getSessionResults().at(-1);const report={authorizedRequests:requests,completed,failed:{...request,result,error:error instanceof Error?error.message:String(error)},phase2Allowed:false};mkdirSync(resolve(process.cwd(),'artifacts','v6-sideways-mean-reversion'),{recursive:true});writeFileSync(artifact,`${JSON.stringify(report,null,2)}\n`);console.error('V6 AUTHORIZED FILL STOPPED',report);throw error;}
  }
  const after=await preloader.inspectLocalOptionSessions(requests);const report={authorizedRequests:requests,remoteFetchesAttempted:requests.length,completed,finalInspection:after,phase2Allowed:after.completeLocalSessions===requests.length&&after.missingLocalSessions===0&&after.incompleteLocalSessions===0};mkdirSync(resolve(process.cwd(),'artifacts','v6-sideways-mean-reversion'),{recursive:true});writeFileSync(artifact,`${JSON.stringify(report,null,2)}\n`);console.log('V6 AUTHORIZED FILL COMPLETE',report);if(!report.phase2Allowed)throw new Error('V6 authorized fill did not produce 14 complete local sessions.');
}
run().catch((error)=>{console.error('V6 authorized NIFTY cache fill failed.',error);process.exitCode=1;});
