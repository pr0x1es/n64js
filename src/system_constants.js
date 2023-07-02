export const OS_TV_PAL = 0;
export const OS_TV_NTSC = 1;
export const OS_TV_MPAL = 2;

export const countryUnknown = 0;
export const countryBeta = 0x37; // '7'
export const countryAsia = 0x41; // 'A'
export const countryBrazil = 0x42; // 'B'
export const countryChina = 0x43; // 'C'
export const countryGermany = 0x44; // 'D'
export const countryNorthAmerica = 0x45; // 'E'
export const countryFrance = 0x46; // 'F'
export const countryGatewayG = 0x47; // 'G' - https://en.wikipedia.org/wiki/Nintendo_Gateway_System
export const countryHolland = 0x48; // 'H'
export const countryItaly = 0x49; // 'I'
export const countryJapan = 0x4A; // 'J'
export const countryKorea = 0x4B; // 'K'
export const countryGatewayL = 0x4C; // 'L' - https://en.wikipedia.org/wiki/Nintendo_Gateway_System
export const countryCanada = 0x4E; // 'N'
export const countryEurope = 0x50; // 'P'
export const countrySpain = 0x53; // 'S'
export const countryAustralia = 0x55; // 'U'
export const countryScandinavia = 0x57; // 'W'
export const countryX_PAL = 0x58; // 'X'
export const countryY_PAL = 0x59; // 'Y'

export function tvTypeFromCountry(countryId) {
  switch (countryId) {
    case countryChina: // TODO: confim.
    case countryGermany:
    case countryFrance:
    case countryHolland:
    case countryItaly:
    case countryGatewayL:
    case countryEurope:
    case countrySpain:
    case countryAustralia:
    case countryScandinavia:
    case countryX_PAL:
    case countryY_PAL:
      return OS_TV_PAL;

    case countryBrazil:
      return OS_TV_MPAL;

    case countryBeta:
    case countryAsia:
    case countryNorthAmerica:
    case countryGatewayG:
    case countryJapan:
    case countryKorea:
    case countryCanada:
      return OS_TV_NTSC;
  }
  return OS_TV_NTSC;
}


