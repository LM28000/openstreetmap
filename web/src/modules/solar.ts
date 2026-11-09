/**
 * Position du soleil (formules simplifiées de l'US Naval Observatory,
 * précises à environ 0,01° sur plusieurs siècles : largement assez pour une carte).
 */

const DEG = Math.PI / 180;
/** 1er janvier 2000 à 12 h UTC (époque J2000.0). */
const J2000 = Date.UTC(2000, 0, 1, 12);

export interface SubsolarPoint {
  /** Latitude où le soleil est au zénith = déclinaison solaire, en degrés. */
  lat: number;
  /** Longitude où il est midi solaire, en degrés (-180 à 180). */
  lon: number;
}

/** Point de la Terre où le soleil est exactement au zénith à l'instant donné. */
export function subsolarPoint(timeMs: number): SubsolarPoint {
  const d = (timeMs - J2000) / 86_400_000; // jours depuis J2000
  const meanAnomaly = (357.529 + 0.98560028 * d) * DEG;
  const meanLongitude = 280.459 + 0.98564736 * d;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.00000036 * d) * DEG;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  // Temps sidéral de Greenwich, en heures.
  const gmstHours = 18.697374558 + 24.06570982441908 * d;

  return {
    lat: declination / DEG,
    lon: normalizeLongitude(rightAscension / DEG - gmstHours * 15),
  };
}

export interface SunPosition {
  /** Hauteur au-dessus de l'horizon, en degrés (négative la nuit). */
  elevation: number;
  /** Direction, en degrés depuis le nord dans le sens horaire (90 = est, 180 = sud). */
  azimuth: number;
}

/** Position du soleil dans le ciel, vue depuis un point de la Terre. */
export function sunPosition(lat: number, lon: number, timeMs: number): SunPosition {
  const sun = subsolarPoint(timeMs);
  const phi = lat * DEG;
  const dec = sun.lat * DEG;
  const hourAngle = (lon - sun.lon) * DEG; // positif : le soleil est passé à l'ouest (après-midi)
  const sinElevation = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle);
  // Azimut compté depuis le sud vers l'ouest, puis ramené au nord.
  const azimuthFromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
  return {
    elevation: Math.asin(sinElevation) / DEG,
    azimuth: (azimuthFromSouth / DEG + 180 + 360) % 360,
  };
}

/** Hauteur du soleil au-dessus de l'horizon, en degrés (négative la nuit). */
export function sunElevation(lat: number, lon: number, timeMs: number): number {
  return sunPosition(lat, lon, timeMs).elevation;
}

function normalizeLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
