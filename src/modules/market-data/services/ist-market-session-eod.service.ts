/**
 * Compatibility exports for existing runtime modules. New code should import
 * the explicit NSE calendar service directly.
 */
export {
  NseSessionEodCoordinator as IstSessionEodCoordinator,
  isWithinNseSession as isWithinIstMarketSession,
  isAtOrAfterNseSessionClose as isAtOrAfterIstSessionEnd,
  millisecondsUntilNseSessionClose as millisecondsUntilIstSessionEnd,
} from './nse-session-calendar.service';
