export type V11Direction = 'CE' | 'PE';
export interface V11DeltaPoint { timestamp: Date; expiry: string; atmStrike: number; ceWingStrike: number; peWingStrike: number; upsideSkew: number; downsideSkew: number; riskReversal: number; }
export interface RobustZ { value: number | null; reason?: 'INSUFFICIENT_BASELINE' | 'ZERO_MAD'; }
export function featureDelta(current: V11DeltaPoint, prior: V11DeltaPoint, feature: 'upsideSkew'|'downsideSkew'|'riskReversal'): number | null {
  if (current.expiry!==prior.expiry || current.atmStrike!==prior.atmStrike || current.ceWingStrike!==prior.ceWingStrike || current.peWingStrike!==prior.peWingStrike) return null;
  return current[feature]-prior[feature];
}
export function robustZ(current:number, prior:readonly number[], minimum=10):RobustZ { if(prior.length<minimum)return{value:null,reason:'INSUFFICIENT_BASELINE'};const sorted=[...prior].sort((a,b)=>a-b),median=sorted[Math.floor((sorted.length-1)/2)],dev=prior.map(x=>Math.abs(x-median)).sort((a,b)=>a-b),mad=dev[Math.floor((dev.length-1)/2)];if(mad<=0||!Number.isFinite(mad))return{value:null,reason:'ZERO_MAD'};return{value:(current-median)/(1.4826*mad)}; }
export interface EpisodeState { armed:boolean; lastSignalAt:number|null; }
export function applyEpisode(state:EpisodeState,z:number|null,now:number,cooldownMinutes:number,threshold:number):{state:EpisodeState;signal:boolean;reason?:string}{const armed=z!==null&&z<.5?true:state.armed;if(z===null||z<threshold)return{state:{...state,armed},signal:false,reason:z===null?'Z_UNAVAILABLE':'Z_BELOW_THRESHOLD'};if(!armed)return{state:{...state,armed},signal:false,reason:'EPISODE_NOT_REARMED'};if(state.lastSignalAt!==null&&now-state.lastSignalAt<cooldownMinutes*60000)return{state:{...state,armed},signal:false,reason:'COOLDOWN'};return{state:{armed:false,lastSignalAt:now},signal:true};}
