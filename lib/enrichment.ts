const CITIES: Record<string, [number, number]> = {
  "FL:MIAMI": [25.7617, -80.1918],
  "FL:MIAMI BEACH": [25.7907, -80.13],
  "FL:CORAL GABLES": [25.7215, -80.2684],
  "FL:FORT LAUDERDALE": [26.1224, -80.1373],
  "FL:TAMPA": [27.9506, -82.4572],
  "FL:ORLANDO": [28.5383, -81.3792],
  "FL:SARASOTA": [27.3364, -82.5307],
  "FL:CAPE CORAL": [26.5629, -81.9495],
  "FL:JACKSONVILLE": [30.3322, -81.6557],
  "FL:OCALA": [29.1872, -82.1401],
  "FL:KEY WEST": [24.5551, -81.78],
  "FL:WEST PALM BEACH": [26.7153, -80.0534],
  "FL:NAPLES": [26.142, -81.7948],
  "FL:HIALEAH": [25.8576, -80.2781],
  "FL:HOLLYWOOD": [26.0112, -80.1495],
  "FL:BOCA RATON": [26.3683, -80.1289],
  "FL:PEMBROKE PINES": [26.0078, -80.2963],
  "FL:HOMESTEAD": [25.4687, -80.4776],
  "GA:SAVANNAH": [32.0809, -81.0912],
  "GA:ATLANTA": [33.749, -84.388],
  "GA:AUGUSTA": [33.4735, -82.0105],
  "TX:DALLAS": [32.7767, -96.797],
  "TX:HOUSTON": [29.7604, -95.3698],
  "NC:CHARLOTTE": [35.2271, -80.8431],
  "NC:RALEIGH": [35.7796, -78.6382],
  "SC:CHARLESTON": [32.7765, -79.9311],
  "AL:BIRMINGHAM": [33.5186, -86.8104],
  "TN:NASHVILLE": [36.1627, -86.7816],
};

const STATES: Record<string, [number, number]> = {
  FL: [27.8, -81.7],
  GA: [32.7, -83.4],
  TX: [31.0, -99.0],
  NC: [35.6, -79.8],
  SC: [33.8, -81.0],
  AL: [32.7, -86.7],
  TN: [35.8, -86.3],
  NY: [42.9, -75.5],
};

export type AvmInput = { city: string; state: string; zip: string; street?: string; estimatedValue: number };

export type PropertyEstimate = { value: number; latitude: number; longitude: number };

export type PropertyProvider = {
  id: string;
  estimate(input: AvmInput): PropertyEstimate;
  estimateAsync?(input: AvmInput): Promise<PropertyEstimate>;
};

function hash(text: string) {
  let value = 0;
  for (const char of text) value = (value * 33 + char.charCodeAt(0)) % 10000;
  return value;
}

export const mockPropertyProvider: PropertyProvider = {
  id: "mock",
  estimate(input) {
    const key = `${input.state}:${input.city}`.toUpperCase();
    const base = CITIES[key] ?? STATES[input.state.toUpperCase()] ?? [27.8, -81.7];
    const nudge = hash(`${input.zip}:${input.city}`) / 10000;
    const factor = 0.94 + (hash(input.zip || input.city) % 12) / 100;
    return {
      value: Math.max(1, Math.round(input.estimatedValue * factor)),
      latitude: Number((base[0] + nudge * 0.08).toFixed(5)),
      longitude: Number((base[1] - nudge * 0.08).toFixed(5)),
    };
  },
};

const providers = new Map<string, PropertyProvider>([[mockPropertyProvider.id, mockPropertyProvider]]);

export function registerPropertyProvider(provider: PropertyProvider) {
  providers.set(provider.id, provider);
}

export function getPropertyProvider(id = process.env.AVM_PROVIDER || "mock") {
  if (id === "attom") return { ...mockPropertyProvider, id: "attom" };
  return providers.get(id) ?? mockPropertyProvider;
}

export async function estimateProperty(input: AvmInput) {
  const provider = getPropertyProvider();
  if (provider.id === "attom" && process.env.ATTOM_API_KEY) {
    try {
      const live = await attomEstimate(input, process.env.ATTOM_API_KEY);
      if (live) return { ...live, providerId: "attom" };
    } catch {
      const estimate = mockPropertyProvider.estimate(input);
      return { ...estimate, providerId: "mock" };
    }
  }
  if (provider.estimateAsync) {
    try {
      const estimate = await provider.estimateAsync(input);
      return { ...estimate, providerId: provider.id };
    } catch {
      const estimate = mockPropertyProvider.estimate(input);
      return { ...estimate, providerId: mockPropertyProvider.id };
    }
  }
  return { ...provider.estimate(input), providerId: provider.id };
}

async function attomEstimate(input: AvmInput, key: string) {
  const url = new URL("https://api.gateway.attomdata.com/propertyapi/v1.0.0/attomavm/detail");
  url.searchParams.set("address1", input.street || input.city);
  url.searchParams.set("address2", [input.city, input.state, input.zip].filter(Boolean).join(" "));
  const response = await fetch(url, { headers: { apikey: key, Accept: "application/json" } });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    property?: { avm?: { amount?: { value?: number } }; location?: { latitude?: string; longitude?: string } }[];
  };
  const property = payload.property?.[0];
  const value = property?.avm?.amount?.value;
  const latitude = Number(property?.location?.latitude);
  const longitude = Number(property?.location?.longitude);
  if (!value || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { value: Math.round(value), latitude, longitude };
}

export function projectUs(latitude: number, longitude: number) {
  const x = ((longitude + 125) / 59) * 1000;
  const y = ((49 - latitude) / 25) * 560;
  return { x: Math.max(8, Math.min(992, x)), y: Math.max(8, Math.min(552, y)) };
}
