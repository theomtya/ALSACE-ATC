// api/flights.js — Proxy ADS-B multi-sources pour ALSACE ATC
// Vercel transforme automatiquement ce fichier en fonction serverless
// accessible sur /api/flights. Aucune config nécessaire.

export default async function handler(req, res) {
  // --- Zone couverte : centre Alsace, rayon en milles nautiques ---
  const LAT = 48.08, LON = 7.55, R_NM = 150;
  const R_KM = Math.round(R_NM * 1.852); // certaines API veulent des km

  // --- Sources gratuites non censurées (privé + militaire visibles) ---
  const sources = [
    { name: 'adsb.lol',        url: `https://api.adsb.lol/v2/point/${LAT}/${LON}/${R_NM}` },
    { name: 'airplanes.live',  url: `https://api.airplanes.live/v2/point/${LAT}/${LON}/${R_NM}` },
    { name: 'adsb.fi',         url: `https://opendata.adsb.fi/api/v2/lat/${LAT}/lon/${LON}/dist/${R_KM}` },
  ];

  // --- Récupération en parallèle, avec timeout 6s par source ---
  // (une API lente ou HS ne bloque jamais les autres)
  const fetchWithTimeout = async (src) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(src.url, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) return { name: src.name, ac: [] };
      const j = await r.json();
      return { name: src.name, ac: j.ac || j.aircraft || [] };
    } catch {
      clearTimeout(t);
      return { name: src.name, ac: [] };
    }
  };

  const results = await Promise.all(sources.map(fetchWithTimeout));

  // --- Fusion + dédoublonnage sur le code ICAO hex ---
  const merged = {};
  for (const { name, ac } of results) {
    for (const plane of ac) {
      const hex = (plane.hex || '').toLowerCase();
      if (!hex) continue;
      if (!merged[hex]) {
        merged[hex] = { ...plane, sources: [name] };
      } else {
        // complète les champs manquants + note la source
        Object.assign(merged[hex], plane);
        if (!merged[hex].sources.includes(name)) merged[hex].sources.push(name);
      }
    }
  }

  const planes = Object.values(merged).filter(a => a.lat != null && a.lon != null);

  // --- Cache 5s côté CDN Vercel : protège les API communautaires ---
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    count: planes.length,
    updated: new Date().toISOString(),
    perSource: results.map(r => ({ name: r.name, count: r.ac.length })),
    ac: planes,
  });
}
