// ── « Prix sur mon trajet » : calculs (sans interface) ─────────────────────────
// Villes tirées des stations (aucun service de recherche d'adresse), itinéraire OSRM
// (serveur public FOSSGIS, routing.openstreetmap.de) avec repli en ligne droite,
// et corridor : stations à moins de X km de la route.

export const OSRM_URL = "https://routing.openstreetmap.de/routed-car/route/v1/driving/";
export const DETOURS = [1, 3, 5];          // écart maximal à la route (km)
const FACTEUR_DETOUR = 1.25;               // route réelle ≈ 25 % plus longue que la ligne droite
const OSRM_DELAI_MS = 12000;               // abandon après 12 s
const OSRM_INTERVALLE_MS = 1100;           // règle FOSSGIS : 1 requête par seconde au maximum
const OSRM_MAX_KM = 3000;

export function sansAccent(t) { return (t||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase(); }
// « St-Jean » et « Saint-Jean » doivent donner la même ville
const cleVille = v => sansAccent(v).replace(/[-'’.]/g," ").replace(/\s+/g," ").trim()
  .replace(/(^| )ste( |$)/g,"$1sainte$2").replace(/(^| )st( |$)/g,"$1saint$2");

export function haversine(lat1,lng1,lat2,lng2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
const mediane = arr => { const s=[...arr].sort((a,b)=>a-b); const m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
const plusFrequent = arr => { const n=new Map(); arr.forEach(x=>n.set(x,(n.get(x)||0)+1)); return [...n.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]; };

// ── Villes : la partie après la dernière virgule de l'adresse, position = médiane des stations ──
export function villesDepuisStations(stations) {
  const groupes = new Map();
  for (const s of stations) {
    if (s.lat==null || s.lng==null) continue;
    const i = (s.adresse||"").lastIndexOf(",");
    if (i<0) continue;
    const nom = s.adresse.slice(i+1).replace(/\s*\(.*\)\s*$/,"").trim();  // « Disraeli (ville & paroisse) » → « Disraeli »
    if (nom.length<2 || nom.length>60 || /\d/.test(nom)) continue;
    const cle = cleVille(nom);
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push({ nom, s });
  }
  const villes = [];
  for (const [cle, g] of groupes) {
    let lat = mediane(g.map(x=>x.s.lat)), lng = mediane(g.map(x=>x.s.lng));
    // Écarter les coordonnées aberrantes (station à plus de 40 km du centre)
    const proches = g.filter(x=>haversine(lat,lng,x.s.lat,x.s.lng)<=40);
    if (!proches.length) continue;
    if (proches.length<g.length) { lat=mediane(proches.map(x=>x.s.lat)); lng=mediane(proches.map(x=>x.s.lng)); }
    // Nom affiché : l'orthographe avec minuscules si elle existe (« Lévis » plutôt que « LÉVIS »)
    const noms = proches.map(x=>x.nom);
    const nom = plusFrequent(noms.filter(n=>n!==n.toUpperCase())) ?? plusFrequent(noms);
    villes.push({ cle, nom, region: plusFrequent(proches.map(x=>x.s.region)) || "", lat, lng, n: proches.length });
  }
  return villes.sort((a,b)=>b.n-a.n);
}

export function chercherVilles(villes, q, max=6) {
  const c = cleVille(q);
  if (!c) return [];
  const res = [];
  for (const v of villes) {
    let score = null;
    if (v.cle===c) score = 0;
    else if (v.cle.startsWith(c)) score = 1;
    else if ((" "+v.cle).includes(" "+c)) score = 2;
    else if (c.length>=3 && v.cle.includes(c)) score = 3;
    if (score!=null) res.push({ v, score });
  }
  return res.sort((a,b)=>a.score-b.score || b.v.n-a.v.n).slice(0,max).map(r=>r.v);
}

// ── Polyline encodée (format Google, précision 5) → [[lat,lng],…] ──
export function decoderPolyline(str, precision=5) {
  const f = Math.pow(10, precision), pts = [];
  let i=0, lat=0, lng=0;
  while (i<str.length) {
    for (const k of [0,1]) {
      let res=0, shift=0, b;
      do { if (i>=str.length) throw new Error("polyline tronquée"); b=str.charCodeAt(i++)-63; res|=(b&0x1f)<<shift; shift+=5; } while (b>=0x20);
      const d = (res&1) ? ~(res>>1) : (res>>1);
      if (k===0) lat+=d; else lng+=d;
    }
    pts.push([lat/f, lng/f]);
  }
  return pts;
}

// Position envoyée au service : arrondie à 0,01° (≈ 1 km) pour ne pas transmettre l'adresse exacte
export const arrondir = p => ({ lat: Math.round(p.lat*100)/100, lng: Math.round(p.lng*100)/100 });

const cache = new Map();
let dernierAppel = 0;
const pause = ms => new Promise(r=>setTimeout(r, ms));

export async function itineraireOSRM(dep, arr, { fetchFn = fetch } = {}) {
  const a = arrondir(dep), b = arrondir(arr);
  const cle = [a.lat,a.lng,b.lat,b.lng].join(",");
  if (cache.has(cle)) return cache.get(cle);
  const attente = dernierAppel + OSRM_INTERVALLE_MS - Date.now();
  if (attente>0) await pause(attente);
  dernierAppel = Date.now();
  const ctrl = new AbortController();
  const minuterie = setTimeout(()=>ctrl.abort(), OSRM_DELAI_MS);
  try {
    const url = OSRM_URL + a.lng+","+a.lat+";"+b.lng+","+b.lat + "?overview=full&geometries=polyline&alternatives=false&steps=false";
    const r = await fetchFn(url, { signal: ctrl.signal, credentials: "omit", referrerPolicy: "strict-origin" });
    if (!r.ok) throw new Error("HTTP "+r.status);
    const j = await r.json();
    const route = j?.routes?.[0];
    if (j?.code!=="Ok" || !route || typeof route.geometry!=="string" || route.geometry.length>3e6) throw new Error("réponse inattendue");
    const km = route.distance/1000, min = route.duration/60;
    if (!(km>=0 && km<OSRM_MAX_KM) || !(min>=0)) throw new Error("distance inattendue");
    const pts = decoderPolyline(route.geometry).filter(([la,ln])=>la>40&&la<66&&ln>-85&&ln<-50);
    if (pts.length<2) throw new Error("tracé vide");
    const res = { pts, km, min, source:"osrm" };
    cache.set(cle, res);
    return res;
  } finally { clearTimeout(minuterie); }
}

// Repli si le service ne répond pas : ligne droite, par un pont si on change de rive
export function itineraireEstime(dep, arr, pont) {
  const pts = [[dep.lat,dep.lng], ...(pont ? [[pont.lat,pont.lng]] : []), [arr.lat,arr.lng]];
  let km = 0; for (let i=1;i<pts.length;i++) km += haversine(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]);
  km *= FACTEUR_DETOUR;
  return { pts, km, min: km/80*60, source:"estimation" };
}

// ── Corridor : stations à moins de `ecartMax` km du tracé ──
const KM_LAT = 110.574, KM_LNG = lat => 111.320*Math.cos(lat*Math.PI/180);
const CELL = 0.05; // grille d'environ 5 km pour ne tester que les segments voisins

export function corridor(stations, pts, ecartMax) {
  if (!pts || pts.length<2 || !stations.length) return [];
  // Tracé allégé (un point tous les 150 m) et densifié (un point au moins tous les 2 km)
  const tr = [pts[0]];
  for (let i=1;i<pts.length;i++) {
    const p = tr[tr.length-1], q = pts[i], d = haversine(p[0],p[1],q[0],q[1]);
    if (d<0.15 && i<pts.length-1) continue;
    const n = Math.ceil(d/2);
    for (let k=1;k<=n;k++) tr.push([p[0]+(q[0]-p[0])*k/n, p[1]+(q[1]-p[1])*k/n]);
  }
  const cumul = [0];
  for (let i=1;i<tr.length;i++) cumul.push(cumul[i-1]+haversine(tr[i-1][0],tr[i-1][1],tr[i][0],tr[i][1]));
  // Index des segments par case de grille (boîte du segment élargie de l'écart maximal)
  const grille = new Map();
  const dLat = ecartMax/KM_LAT;
  for (let i=0;i<tr.length-1;i++) {
    const [a1,b1]=tr[i], [a2,b2]=tr[i+1];
    const dLng = ecartMax/KM_LNG(Math.max(Math.abs(a1),Math.abs(a2)));
    const la0=Math.floor((Math.min(a1,a2)-dLat)/CELL), la1=Math.floor((Math.max(a1,a2)+dLat)/CELL);
    const ln0=Math.floor((Math.min(b1,b2)-dLng)/CELL), ln1=Math.floor((Math.max(b1,b2)+dLng)/CELL);
    for (let x=la0;x<=la1;x++) for (let y=ln0;y<=ln1;y++) {
      const k=x+":"+y; if (!grille.has(k)) grille.set(k,[]); grille.get(k).push(i);
    }
  }
  const res = [];
  for (const s of stations) {
    if (s.lat==null || s.lng==null) continue;
    const segs = grille.get(Math.floor(s.lat/CELL)+":"+Math.floor(s.lng/CELL));
    if (!segs) continue;
    const kx = KM_LNG(s.lat);
    let best = null;
    for (const i of segs) {
      const ax=(tr[i][1]-s.lng)*kx, ay=(tr[i][0]-s.lat)*KM_LAT, bx=(tr[i+1][1]-s.lng)*kx, by=(tr[i+1][0]-s.lat)*KM_LAT;
      const vx=bx-ax, vy=by-ay, L2=vx*vx+vy*vy;
      const t = L2>0 ? Math.max(0, Math.min(1, -(ax*vx+ay*vy)/L2)) : 0;
      const px=ax+t*vx, py=ay+t*vy, d=Math.sqrt(px*px+py*py);
      if (!best || d<best.d) best = { d, km: cumul[i]+t*(cumul[i+1]-cumul[i]) };
    }
    if (best && best.d<=ecartMax) res.push({ ...s, ecart: best.d, kmTrajet: best.km, detour: 2*best.d*FACTEUR_DETOUR, dist: undefined, pont: undefined });
  }
  return filtrerAutreRive(res);
}

// Une station proche à vol d'oiseau mais de l'autre côté du fleuve n'est pas « sur le trajet ».
// Rive de la route à cet endroit = rive des stations collées à la route (≤ 1 km) dans les 3 km autour.
function filtrerAutreRive(cands) {
  const collees = cands.filter(c=>c.rive && c.ecart<=1).sort((a,b)=>a.kmTrajet-b.kmTrajet);
  return cands.filter(c=>{
    if (!c.rive || c.ecart<=0.5) return true;
    const n = {}; let tot = 0;
    for (const v of collees) { if (Math.abs(v.kmTrajet-c.kmTrajet)<=3 && v!==c) { n[v.rive]=(n[v.rive]||0)+1; tot++; } }
    if (tot<2) return true;
    const [rive, nb] = Object.entries(n).sort((a,b)=>b[1]-a[1])[0];
    return !(rive!==c.rive && nb/tot>=0.7);
  });
}

// Coût d'un plein en tenant compte du détour (prix en ¢/L, conso en L/100 km) → en $
export function coutPlein(s, carb, plein, conso) {
  const p = s[carb]; if (p==null) return null;
  return p/100 * (plein + (s.detour||0)*conso/100);
}
export function meilleurChoix(cands, carb, plein, conso) {
  let best = null, bestC = Infinity;
  for (const s of cands) { const c = coutPlein(s, carb, plein, conso); if (c!=null && c<bestC) { bestC=c; best=s; } }
  return best;
}

// Longueur d'un tracé (km) et point situé à `km` du départ le long du tracé
export function longueurTrace(pts) {
  let t = 0; for (let i=1;i<(pts?.length||0);i++) t += haversine(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]);
  return t;
}
export function pointAuKm(pts, km) {
  if (!pts || pts.length<2 || !(km>=0)) return null;
  let t = 0;
  for (let i=1;i<pts.length;i++) {
    const d = haversine(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]);
    if (t+d >= km) { const r = d>0 ? (km-t)/d : 0; return [pts[i-1][0]+(pts[i][0]-pts[i-1][0])*r, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*r]; }
    t += d;
  }
  return null; // au-delà de l'arrivée
}

// Autonomie : km à parcourir pour atteindre la station = km sur le trajet + aller vers la station (moitié du détour)
export function portee(s, autonomie) {
  if (!(autonomie>0)) return { ok:true, limite:false, besoin:null };
  const besoin = s.kmTrajet + (s.detour||0)/2;
  return { ok: besoin<=autonomie, limite: besoin<=autonomie && besoin>0.85*autonomie, besoin };
}
