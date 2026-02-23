// Weather tool using Open-Meteo API (free, no API key required)

export interface WeatherOutput {
  location: string;
  current: {
    temperature_c: number;
    temperature_f: number;
    humidity: number;
    wind_speed_kmh: number;
    condition: string;
    feels_like_c: number;
  };
  forecast: Array<{
    date: string;
    high_c: number;
    low_c: number;
    condition: string;
    precipitation_mm: number;
  }>;
}

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Slight snowfall', 73: 'Moderate snowfall', 75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};

async function geocode(location: string): Promise<{ lat: number; lon: number; name: string }> {
  const coordMatch = location.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    return {
      lat: parseFloat(coordMatch[1]),
      lon: parseFloat(coordMatch[2]),
      name: location,
    };
  }

  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
    { signal: AbortSignal.timeout(10_000) },
  );

  if (!res.ok) {
    throw new Error(`Geocoding failed (${res.status})`);
  }

  const data = await res.json() as {
    results?: Array<{
      latitude: number;
      longitude: number;
      name: string;
      country?: string;
      admin1?: string;
    }>;
  };

  if (!data.results?.length) {
    throw new Error(`Location not found: ${location}`);
  }

  const r = data.results[0];
  const name = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
  return { lat: r.latitude, lon: r.longitude, name };
}

export async function getWeather(params: {
  location: string;
}): Promise<WeatherOutput> {
  const geo = await geocode(params.location);

  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
    `&timezone=auto&forecast_days=5`,
    { signal: AbortSignal.timeout(10_000) },
  );

  if (!res.ok) {
    throw new Error(`Weather API error (${res.status})`);
  }

  const data = await res.json() as {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
    };
  };

  const current = data.current;
  const daily = data.daily;

  return {
    location: geo.name,
    current: {
      temperature_c: current.temperature_2m,
      temperature_f: Math.round(current.temperature_2m * 9/5 + 32),
      humidity: current.relative_humidity_2m,
      wind_speed_kmh: current.wind_speed_10m,
      condition: WMO_CODES[current.weather_code] ?? 'Unknown',
      feels_like_c: current.apparent_temperature,
    },
    forecast: daily.time.map((date, i) => ({
      date,
      high_c: daily.temperature_2m_max[i],
      low_c: daily.temperature_2m_min[i],
      condition: WMO_CODES[daily.weather_code[i]] ?? 'Unknown',
      precipitation_mm: daily.precipitation_sum[i],
    })),
  };
}
