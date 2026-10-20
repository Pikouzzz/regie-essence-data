import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import "./leaflet-setup.js";          // doit précéder markercluster (qui utilise window.L)
import "leaflet.markercluster";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { DETOURS, villesDepuisStations, chercherVilles, itineraireOSRM, itineraireEstime, corridor, meilleurChoix, coutPlein, longueurTrace, pointAuKm, portee } from "./trajet.js";

const CARBURANTS = [
  { key: "regulier", label: "Ordinaire", color: "var(--accent)" },
  { key: "super",    label: "Super",     color: "var(--mid)" },
  { key: "diesel",   label: "Diesel",    color: "#3b82f6" },
];
const RAYONS = [5, 10, 25, 50, 100];
const APP_NAME = "Écono Gaz";
const APP_VERSION = "12.6";
const CONTACT_EMAIL = "econogaz.app@gmail.com";
const SOURCE_NOM = "Régie essence Québec, Régie de l'énergie"; // mention exigée par la Régie (courriel du 2026-10-06)
// config.json (modifiable sur GitHub sans reconstruire l'app) : lien de don, compteur de visites
const CONFIG_URL = "config.json";
const DON_DOMAINES = ["ko-fi.com","buy.stripe.com","www.buymeacoffee.com","buymeacoffee.com","www.paypal.com","paypal.me"];
function lienDonValide(u) { try { const x=new URL(u); return x.protocol==="https:" && DON_DOMAINES.includes(x.hostname); } catch { return false; } }
function compterVisite(code) {
  if (!/^[a-z0-9-]{2,40}$/.test(code||"")) return;
  // « Ne pas me suivre » (DNT) et Global Privacy Control (GPC) sont respectés
  if (navigator.doNotTrack==="1" || window.doNotTrack==="1" || navigator.globalPrivacyControl===true) return;
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  // s = largeur,hauteur,échelle (format attendu par GoatCounter)
  img.src = "https://"+code+".goatcounter.com/count?p="+encodeURIComponent("/app")+"&t="+encodeURIComponent(APP_NAME)
    +"&s="+encodeURIComponent(screen.width+","+screen.height+","+(window.devicePixelRatio||1))+"&rnd="+Math.random().toString(36).slice(2);
}
const POLICE      = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const POLICE_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const VUES = [
  { key:"liste",   label:"Stations", icon:"☰" },
  { key:"trajet",  label:"Trajet",   icon:"↝" },
  { key:"favoris", label:"Favoris",  icon:"♥" },
  { key:"carte",   label:"Carte",    icon:"⊙" },
];
const TRIS = {
  distance:  "Plus proche d'abord",
  prix_asc:  "Moins cher d'abord",
  prix_desc: "Plus cher d'abord",
  nom:       "Nom de la station (A à Z)",
  region:    "Par région",
};
const REPORT_EMAIL = "req_enquete@regie-energie.qc.ca"; // adresse indiquée dans la FAQ consommateurs de la Régie
const TIER_COLOR = { low:"var(--low)", mid:"var(--mid)", high:"var(--high)" };
const TIER_LABEL = { low:"Bas prix", mid:"Prix moyen", high:"Prix élevé" };
const NONE_COLOR = "var(--t3)";
const ON_COLOR   = "var(--on)"; // texte sur fond coloré (sombre en thème sombre, blanc en thème clair)

// Fichier mis à jour toutes les 15 min par le robot GitHub (dépôt regie-essence-data)
const DATA_URL  = "https://pikouzzz.github.io/regie-essence-data/stations.json";
const CACHE_KEY = "regie-essence:stations:v1";
const REFRESH_MS = 5*60*1000; // re-vérifie toutes les 5 min quand l'app est ouverte

// Transforme le JSON compact (tableaux) en objets station
// Recherche insensible aux accents et à la casse
function sansAccent(t) { return (t||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }
// « SAINT-JEAN-SUR-RICHELIEU » → « Saint-Jean-sur-Richelieu »
const PETITS_MOTS = new Set(["de","du","des","la","le","les","sur","en","aux","et","à"]);
function jolieVille(v) {
  if (!v || v!==v.toUpperCase() || !/[A-ZÀ-Ý]/.test(v)) return v;
  let i = 0;
  return v.toLowerCase().replace(/[a-zà-ÿ]+(?:'[a-zà-ÿ]+)?/g, m=>{
    const premier = i++===0;
    if (!premier && PETITS_MOTS.has(m)) return m;
    if (/^[dl]'/.test(m)) return m[0]+"'"+m[2].toUpperCase()+m.slice(3);
    return m[0].toUpperCase()+m.slice(1);
  });
}
function jolieAdresse(a) {
  const i = (a||"").lastIndexOf(",");
  return i<0 ? a : a.slice(0,i+1)+" "+jolieVille(a.slice(i+1).trim());
}

const txt = (v, max=120) => typeof v==="string" ? v.slice(0,max) : "";
const nombre = (v, min, max) => (typeof v==="number" && Number.isFinite(v) && v>=min && v<=max) ? v : null;

// Les prix sont gardés tels que publiés par la Régie. Un prix hors 50–400 ¢ est mis de côté
// (exclu des comparaisons et des couleurs) mais reste visible dans le panneau, marqué « inhabituel ».
function prixAffiches(r, f) {
  const out = { inhabituels:{} };
  for (const k of ["regulier","super","diesel"]) {
    const v = nombre(r[f[k]], 0.1, 9999);
    if (v!=null && (v<50 || v>400)) { out[k]=null; out.inhabituels[k]=v; } else out[k]=v;
  }
  return out;
}

function parseData(json) {
  if (!json || json.version!==1 || !Array.isArray(json.stations)) throw new Error("Format de données inattendu");
  const f = Object.fromEntries(json.fields.map((k,i)=>[k,i]));
  const stations = json.stations.map(r=>{
    if (!Array.isArray(r)) return null;
    const banniere = txt(r[f.banniere]);
    const nom = txt(r[f.nom]);
    const b = banniere && banniere!=="Aucun" ? banniere : (nom||"Indépendant");
    const adresse = jolieAdresse(txt(r[f.adresse], 200));
    const cp = txt(r[f.cp], 10);
    const rive = f.rive!=null && ["N","S","M"].includes(r[f.rive]) ? r[f.rive] : null;
    return {
      id:txt(r[f.id], 20), nom, banniere:b, adresse, region:txt(r[f.region], 60), cp,
      lat:nombre(r[f.lat], 44, 64), lng:nombre(r[f.lng], -81, -55),
      ...prixAffiches(r, f),
      rive,
      costco: /costco/i.test(b+" "+nom),
      cle: sansAccent(b+" "+nom+" "+adresse+" "+cp.replace(/\s/g,"")),
    };
  });
  const propres = stations.filter(st=>st && st.id);
  if (propres.length < 500) throw new Error("Trop peu de stations valides");
  return { stations: propres, ts: typeof json.ts==="string" ? json.ts.slice(0,25) : null };
}
function lireCache() {
  try { const c = localStorage.getItem(CACHE_KEY); return c ? JSON.parse(c) : null; } catch { return null; }
}
function ecrireCache(json) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(json)); } catch { /* stockage indisponible : pas grave */ }
}

// Ponts routiers sur le Saint-Laurent (coordonnées approximatives, ±1-2 km).
// Les traversiers ne sont pas pris en compte (horaires, attente).
const PONTS = [
  { nom:"pont Pierre-Laporte",        lat:46.744, lng:-71.288 },
  { nom:"pont Laviolette",            lat:46.306, lng:-72.562 },
  { nom:"tunnel Louis-H.-La Fontaine", lat:45.577, lng:-73.497 },
  { nom:"pont Jacques-Cartier",       lat:45.522, lng:-73.540 },
  { nom:"pont Victoria",              lat:45.492, lng:-73.537 },
  { nom:"pont Samuel-De Champlain",   lat:45.470, lng:-73.525 },
  { nom:"pont Honoré-Mercier",        lat:45.418, lng:-73.655 },
  { nom:"pont de l'A-30",             lat:45.300, lng:-74.040 },
  { nom:"pont de Valleyfield",        lat:45.280, lng:-74.153 },
];
const FACTEUR_ROUTE = 1.25; // la route est en moyenne ~25 % plus longue que la ligne droite
const MIN_COMPARAISON = 8;  // en dessous, pas assez de stations pour colorer « bas / élevé »

// Rive de l'utilisateur = rive majoritaire parmi les 5 stations les plus proches
function riveUtilisateur(stations, lat, lng) {
  const proches = stations.filter(s=>s.rive&&s.lat&&s.lng)
    .map(s=>({r:s.rive, d:haversine(lat,lng,s.lat,s.lng)})).sort((a,b)=>a.d-b.d).slice(0,5);
  if (!proches.length) return null;
  const n = {}; proches.forEach(p=>{ n[p.r]=(n[p.r]||0)+1/(1+p.d); });
  return Object.entries(n).sort((a,b)=>b[1]-a[1])[0][0];
}
// Distance estimée en voiture + pont utilisé si on doit traverser le fleuve
function distanceRoute(u, uRive, s) {
  if (!s.lat||!s.lng) return { dist:null, pont:null };
  const direct = haversine(u.lat,u.lng,s.lat,s.lng);
  if (!uRive || !s.rive || uRive===s.rive) return { dist:direct*FACTEUR_ROUTE, pont:null };
  if (uRive==="M" || s.rive==="M") return { dist:null, pont:null }; // Îles-de-la-Madeleine : pas de route
  let best = null;
  for (const p of PONTS) {
    const d = haversine(u.lat,u.lng,p.lat,p.lng) + haversine(p.lat,p.lng,s.lat,s.lng);
    if (!best || d<best.d) best = { d, p };
  }
  return { dist:best.d*FACTEUR_ROUTE, pont:best.p.nom };
}

function haversine(lat1,lng1,lat2,lng2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
const NBSP = "\u202f"; // espace fine insécable (typographie française)
function dec(n, d=1) { return n.toFixed(d).replace(".", ","); }
function fmt(p) { return p==null ? null : dec(p)+NBSP+"¢"; }
function fmtDist(km) { return km<1 ? Math.round(km*1000)+NBSP+"m" : dec(km)+NBSP+"km"; }

// ── Préférences mémorisées sur l'appareil ──
const PREFS_KEY = "regie-essence:prefs:v1";
function lirePrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY))||{}; } catch { return {}; } }
function ecrirePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignoré */ } }
const PREFS = lirePrefs();
const REGLAGES_DEFAUT = {
  carbDefaut: "regulier", vueDefaut: "liste", rayonDefaut: 10, autoGps: false,
  navApp: null,          // null = selon l'appareil (Plans sur iPhone, Google Maps ailleurs)
  plein: 50,             // litres
  conso: 8.5,            // L/100 km
  theme: "auto",         // auto | clair | sombre
  stats: true,           // compteur de visites anonyme
  detourMax: 3,          // Trajet : écart maximal à la route (km)
  costcoMembre: false,   // non membre : stations Costco cachées (liste, carte, Trajet, moyennes)
};
function reglagesInitiaux() {
  const r = { ...REGLAGES_DEFAUT, ...(PREFS.reglages||{}) };
  // Reprise des anciennes préférences (v6)
  if (!PREFS.reglages) {
    if (PREFS.carb) r.carbDefaut = PREFS.carb;
    if (PREFS.rayon) r.rayonDefaut = PREFS.rayon;
    if (PREFS.navApp) r.navApp = PREFS.navApp;
    if (PREFS.autoGps) r.autoGps = true;
  }
  return r;
}

// ── Plateforme et applis de navigation ──
const UA = typeof navigator!=="undefined" ? navigator.userAgent : "";
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && typeof document!=="undefined" && "ontouchend" in document);
const IS_ANDROID = /Android/.test(UA);
const NAV_APPS = [
  { key:"apple",  label:"Plans" },
  { key:"google", label:"Google Maps" },
  { key:"waze",   label:"Waze" },
];
function navUrl(s, app) {
  const ll = s.lat&&s.lng ? s.lat+","+s.lng : null;
  const adr = encodeURIComponent(s.adresse+", Québec");
  if (app==="waze")  return ll ? "https://waze.com/ul?ll="+ll+"&navigate=yes" : "https://waze.com/ul?q="+adr+"&navigate=yes";
  if (app==="apple") return "https://maps.apple.com/?daddr="+(ll||adr)+"&dirflg=d";
  return "https://www.google.com/maps/dir/?api=1&destination="+(ll||adr);
}
function navLabel(app) { return NAV_APPS.find(a=>a.key===app)?.label ?? "Google Maps"; }

// Couleur selon la position réelle dans la distribution :
// 20 % des stations les moins chères → vert, 20 % les plus chères → rouge.
// Basé sur les percentiles, donc insensible à une station aberrante.
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos=(sorted.length-1)*q, lo=Math.floor(pos), hi=Math.ceil(pos);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(pos-lo);
}
function rangeOf(vals) {
  const s = vals.filter(v=>v!=null).sort((a,b)=>a-b);
  return {
    min: s.length?s[0]:null, max: s.length?s[s.length-1]:null,
    p20: quantile(s,0.2), p80: quantile(s,0.8),
    avg: s.length?s.reduce((a,b)=>a+b,0)/s.length:null, n: s.length,
  };
}
function priceTier(p, r) {
  if (p==null||!r||r.min==null||r.min===r.max||r.n<MIN_COMPARAISON) return null;
  if (p<=r.p20) return "low";
  if (p>=r.p80) return "high";
  return "mid";
}
function priceColor(p, r) { return TIER_COLOR[priceTier(p,r)] ?? NONE_COLOR; }
function priceLabel(p, r) { return TIER_LABEL[priceTier(p,r)] ?? null; }
function fmtArgent(v) { return Math.abs(v).toLocaleString("fr-CA",{style:"currency",currency:"CAD"}); }
function fmtMaj(ts) {
  const d = new Date(ts);
  const ageMin = Math.round((Date.now()-d.getTime())/60000);
  const local = d.toLocaleString("fr-CA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"America/Toronto"});
  const rel = ageMin<1 ? "à l'instant" : ageMin<60 ? "il y a "+ageMin+" min" : ageMin<1440 ? "il y a "+Math.round(ageMin/60)+" h" : "le "+local;
  return { local, rel, stale: ageMin>90 };
}

const PG = 50;

// ── Aide localisation ─────────────────────────────────────────
function GpsAide({ err, onRetry, onClose }) {
  const etapes = err.type==="denied"
    ? (IS_IOS ? [
        "Réglages › Confidentialité et sécurité › Service de localisation : activé",
        "Dans la même liste : Sites web Safari › « Lorsque l'app est active » et Position exacte activée",
        "Si tu avais refusé : dans Safari, touche aA › Réglages du site web › Position › Autoriser",
      ] : IS_ANDROID ? [
        "Paramètres › Localisation : activée",
        "Chrome › ⋮ › Paramètres › Paramètres des sites › Position : ce site doit être autorisé",
      ] : [
        "Clique sur le cadenas à gauche de l'adresse du site et autorise la position",
      ])
    : err.type==="timeout"
      ? ["La position a mis trop de temps à arriver. Active le Wi-Fi ou sors à l'extérieur, puis réessaie."]
      : ["Ton appareil n'a pas pu fournir de position. Vérifie que la localisation est activée, puis réessaie."];
  return (
    <div role="alert" style={{marginTop:10,padding:"10px 12px",background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,fontSize:12,color:"var(--err-t2)",lineHeight:1.5}}>
      <div style={{display:"flex",justifyContent:"space-between",gap:8,fontWeight:700,color:"var(--err-t)",marginBottom:6}}>
        <span>{err.type==="denied" ? "La localisation est bloquée" : err.type==="unsupported" ? "Localisation non disponible" : "Position introuvable"}</span>
        <button onClick={onClose} aria-label="Fermer l'aide" style={{background:"none",border:"none",color:"var(--err-t)",cursor:"pointer",fontSize:14,padding:0}}>✕</button>
      </div>
      {err.type!=="unsupported" && (
        <ol style={{margin:"0 0 8px",paddingLeft:18}}>{etapes.map(t=><li key={t} style={{marginBottom:3}}>{t}</li>)}</ol>
      )}
      {err.type!=="unsupported" && (
        <button onClick={onRetry} className="tab" style={{padding:"6px 12px",borderRadius:8,background:"rgba(var(--ov),0.1)",color:"var(--t1)",fontSize:12,fontWeight:600}}>Réessayer</button>
      )}
    </div>
  );
}

// ── Carte de station (liste et favoris) ───────────────────────
function StationCard({ s, carb, range, best, bestLabel="Le moins cher", showDist, showRegion, fav, onToggleFav, onSelect, onCarte, navApp, trajetInfo, extra, autresCarb=true }) {
  const cInfo = CARBURANTS.find(c=>c.key===carb);
  const p = s[carb];
  const pColor = priceColor(p, range);
  return (
    <div className="card" role="button" tabIndex={0} aria-label={(s.banniere||"Station")+", "+s.adresse+", "+(fmt(p)??"prix non disponible")}
      onKeyDown={e=>{ if(e.target===e.currentTarget&&(e.key==="Enter"||e.key===" ")){ e.preventDefault(); onSelect(s); } }} onClick={()=>onSelect(s)}
      style={{background:best?"rgba(var(--ov),0.06)":"rgba(var(--ov),0.03)",border:best?"1px solid rgba(var(--ov),0.15)":"1px solid rgba(var(--ov),0.07)",borderRadius:16,padding:"13px 14px",marginBottom:9,display:"flex",alignItems:"center",gap:12,cursor:"pointer",transition:"transform 0.15s"}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontWeight:600,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.banniere||"—"}</span>
        </div>
        {best && <div style={{display:"inline-block",background:"var(--accent)",color:ON_COLOR,fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:6,margin:"2px 0 4px"}}>✓ {bestLabel}</div>}
        <div style={{fontSize:11,color:"var(--t3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.adresse}</div>
        {s.costco && <div style={{fontSize:11,color:"var(--warn-t)",marginTop:2}}>* Réservé aux membres Costco</div>}
        <div style={{display:"flex",gap:10,marginTop:4,alignItems:"center",flexWrap:"wrap"}}>
          {showDist&&s.dist!=null && <span style={{fontSize:11,color:"var(--accent)",fontWeight:600}}>{"📍"} ≈{NBSP}{fmtDist(s.dist)}{s.pont?" (pont)":""}</span>}
          {trajetInfo && <span style={{fontSize:11,color:"var(--accent)",fontWeight:600}}>{trajetInfo}</span>}
          {autresCarb && CARBURANTS.filter(c=>c.key!==carb).map(c=>(
            <span key={c.key} style={{fontSize:11,color:"var(--t3)"}}>{c.label} {s[c.key]!=null?fmt(s[c.key]):"non offert"}</span>
          ))}
          {showRegion && <span style={{fontSize:11,color:"var(--t3)"}}>{s.region}</span>}
        </div>
        {extra}
        <div style={{display:"flex",gap:6,marginTop:8}}>
          <button onClick={e=>{ e.stopPropagation(); onCarte(s); }}
            style={{background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.12)",borderRadius:8,padding:"8px 12px",cursor:"pointer",color:"var(--t2)",fontSize:12,fontFamily:"inherit",fontWeight:500,whiteSpace:"nowrap"}}>
            🌐 Carte
          </button>
          <a href={navUrl(s,navApp)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}
            style={{background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.12)",borderRadius:8,padding:"8px 12px",cursor:"pointer",color:"var(--t2)",fontSize:12,fontWeight:500,textDecoration:"none",whiteSpace:"nowrap"}}>
            🧭 Itinéraire
          </a>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6,flexShrink:0}}>
        <button onClick={e=>{ e.stopPropagation(); onToggleFav(s.id); }} aria-pressed={fav} aria-label={fav?"Retirer des favoris":"Ajouter aux favoris"}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:22,lineHeight:1,width:44,height:44,margin:"-10px -10px -6px 0",color:fav?"var(--high)":"var(--t3)"}}>{fav?"♥":"♡"}</button>
        <div style={{fontFamily:POLICE_MONO,fontSize:22,fontWeight:500,lineHeight:1,color:pColor}}>{fmt(p)??"—"}</div>
        <div style={{fontSize:11,color:"var(--t3)"}}>{cInfo.label}, le litre</div>
      </div>
    </div>
  );
}

// ── Réglages ─────────────────────────────────────────────────
function Choix({ options, value, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      {options.map(([v,l])=>(
        <button key={String(v)} role="radio" aria-checked={value===v} className="tab" onClick={()=>onChange(v)}
          style={{flex:"1 1 0",minWidth:64,padding:"9px 6px",borderRadius:10,fontSize:13,fontWeight:600,
            background:value===v?"var(--accent)":"rgba(var(--ov),0.06)",color:value===v?ON_COLOR:"var(--t2)",
            border:value===v?"1px solid var(--accent)":"1px solid rgba(var(--ov),0.1)",whiteSpace:"nowrap"}}>{value===v&&options.length<=4?"✓ ":""}{l}</button>
      ))}
    </div>
  );
}
// Petit bouton ⓘ : affiche ou cache une explication détaillée
function useInfo() { const [ouvert, setOuvert] = useState(false); return [ouvert, ()=>setOuvert(o=>!o)]; }
function BoutonInfo({ ouvert, basculer, sujet }) {
  return (
    <button type="button" onClick={basculer} aria-expanded={ouvert} aria-label={(ouvert?"Masquer":"Afficher")+" l'explication"+(sujet?" : "+sujet:"")}
      style={{flexShrink:0,width:30,height:30,margin:"-6px -4px -6px 0",border:"none",background:"none",cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",padding:0}}>
      <span aria-hidden="true" style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(ouvert?"var(--accent)":"var(--t3)"),color:ouvert?"var(--accent)":"var(--t3)",fontSize:11,fontWeight:700,fontStyle:"italic",fontFamily:"Georgia,serif",display:"inline-flex",alignItems:"center",justifyContent:"center",background:ouvert?"rgba(34,197,94,0.12)":"none"}}>i</span>
    </button>
  );
}
function TexteInfo({ ouvert, children }) {
  return ouvert ? <div style={{fontSize:12,color:"var(--t2)",marginTop:6,lineHeight:1.45,padding:"8px 10px",borderRadius:8,background:"rgba(var(--ov),0.05)"}}>{children}</div> : null;
}
// Ligne de réglage : titre, note courte toujours visible (facultative), explication détaillée derrière ⓘ
function Ligne({ titre, note, aide, children }) {
  const [ouvert, basculer] = useInfo();
  return (
    <div style={{padding:"14px 0",borderBottom:"1px solid rgba(var(--ov),0.06)"}}>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <div style={{fontSize:14,fontWeight:600,color:"var(--t1)"}}>{titre}</div>
        {aide && <BoutonInfo ouvert={ouvert} basculer={basculer} sujet={titre} />}
      </div>
      {note && <div style={{fontSize:12,color:"var(--t3)",marginTop:2,lineHeight:1.4}}>{note}</div>}
      <TexteInfo ouvert={ouvert}>{aide}</TexteInfo>
      <div style={{marginTop:10}}>{children}</div>
    </div>
  );
}
function Nombre({ value, onChange, min, max, step, unite, label }) {
  const [txt, setTxt] = useState(String(value).replace(".",","));
  useEffect(()=>{ setTxt(String(value).replace(".",",")); },[value]);
  const valider = ()=>{
    const n = parseFloat(txt.replace(",","."));
    if (isNaN(n)) { setTxt(String(value).replace(".",",")); return; }
    onChange(Math.min(max, Math.max(min, Math.round(n/step)*step)));
  };
  const bouton = { width:40, height:40, borderRadius:10, border:"1px solid rgba(var(--ov),0.1)", background:"rgba(var(--ov),0.06)", color:"var(--t1)", fontSize:18, cursor:"pointer" };
  return (
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <button style={bouton} aria-label={"Diminuer "+label} onClick={()=>onChange(Math.max(min, +(value-step).toFixed(1)))}>−</button>
      <input inputMode="decimal" aria-label={label} value={txt} onChange={e=>setTxt(e.target.value)} onBlur={valider} onKeyDown={e=>{ if(e.key==="Enter") e.currentTarget.blur(); }}
        style={{width:80,textAlign:"center",padding:"9px 6px",borderRadius:10,border:"1px solid rgba(var(--ov),0.1)",background:"rgba(var(--ov),0.06)",color:"var(--t1)",fontSize:16,fontFamily:POLICE_MONO,outline:"none"}} />
      <button style={bouton} aria-label={"Augmenter "+label} onClick={()=>onChange(Math.min(max, +(value+step).toFixed(1)))}>+</button>
      <span style={{fontSize:13,color:"var(--t3)"}}>{unite}</span>
    </div>
  );
}
function Section({ titre, children }) {
  return (
    <section style={{marginBottom:18}}>
      <h2 style={{fontSize:12,fontWeight:700,color:"var(--t3)",textTransform:"uppercase",letterSpacing:1,margin:"8px 0 0"}}>{titre}</h2>
      {children}
    </section>
  );
}
function Reglages({ reglages:r, maj, nbFavs, onEffacerFavs, onReinitialiser, dataTs, nbStations, donUrl, statsDispo }) {
  const navDefaut = IS_IOS ? "apple" : "google";
  const exemple = r.conso*10/100*190/100; // station à 5 km : 10 km aller-retour à 190 ¢/L
  return (
    <div style={{padding:"16px 20px 24px"}}>
      <h1 style={{fontSize:22,fontWeight:700,margin:"0 0 4px"}}>Réglages</h1>
      <div style={{fontSize:12,color:"var(--t3)",marginBottom:8}}>Enregistrés automatiquement sur cet appareil. Touche <b>ⓘ</b> pour plus d'explications.</div>

      <Section titre="À l'ouverture de l'app">
        <Ligne titre="Carburant habituel" aide="Le carburant affiché quand tu ouvres l'app. Trajet l'utilise aussi par défaut.">
          <Choix label="Carburant habituel" value={r.carbDefaut} onChange={v=>maj("carbDefaut",v)} options={CARBURANTS.map(c=>[c.key,c.label])} />
        </Ligne>
        <Ligne titre="Onglet à l'ouverture" aide="L'onglet affiché quand tu ouvres l'app : Stations, Trajet, Favoris ou Carte.">
          <Choix label="Onglet à l'ouverture" value={r.vueDefaut} onChange={v=>maj("vueDefaut",v)} options={VUES.map(v=>[v.key,v.label])} />
        </Ligne>
        <Ligne titre="Me localiser automatiquement" aide="À l'ouverture, l'app te localise et affiche les stations autour de toi. Ça ne fonctionne que si tu as déjà autorisé la localisation une première fois avec « Me localiser ».">
          <Choix label="Me localiser automatiquement" value={r.autoGps} onChange={v=>maj("autoGps",v)} options={[[true,"Oui"],[false,"Non"]]} />
        </Ligne>
        <Ligne titre="Rayon autour de toi" aide="Quand tu touches « Me localiser », l'app affiche les stations à moins de cette distance (en voiture). Tu peux aussi le changer sous l'en-tête.">
          <Choix label="Rayon autour de toi" value={r.rayonDefaut} onChange={v=>maj("rayonDefaut",v)} options={RAYONS.map(k=>[k,k+" km"])} />
        </Ligne>
      </Section>

      <Section titre="Affichage">
        <Ligne titre="Thème" aide="« Automatique » suit le réglage clair ou sombre de ton téléphone. Le thème clair se lit mieux en plein soleil.">
          <Choix label="Thème" value={r.theme} onChange={v=>maj("theme",v)} options={[["auto","Automatique"],["clair","Clair"],["sombre","Sombre"]]} />
        </Ligne>
      </Section>

      <Section titre="Costco">
        <Ligne titre="Je suis membre Costco" note="Non : les stations Costco sont cachées." aide="Les stations Costco sont réservées aux membres (carte exigée à la pompe). Oui : elles sont affichées. Non : elles sont cachées partout (liste, carte, Trajet) et ne comptent pas dans les moyennes.">
          <Choix label="Je suis membre Costco" value={r.costcoMembre} onChange={v=>maj("costcoMembre",v)} options={[[true,"Oui"],[false,"Non"]]} />
        </Ligne>
      </Section>

      <Section titre="Trajet">
        <Ligne titre="App de navigation" aide="L'app ouverte quand tu touches « Itinéraire » sur une station.">
          <Choix label="App de navigation" value={r.navApp||navDefaut} onChange={v=>maj("navApp",v)} options={NAV_APPS.map(a=>[a.key,a.label])} />
        </Ligne>
      </Section>

      <Section titre="Mon véhicule">
        <Ligne titre="Taille d'un plein" aide="Le nombre de litres que tu mets d'habitude quand tu fais le plein. Sert à calculer combien tu économises. Une estimation suffit.">
          <Nombre label="la taille du plein" value={r.plein} onChange={v=>maj("plein",v)} min={10} max={200} step={5} unite="litres" />
        </Ligne>
        <Ligne titre="Consommation" aide={"Ce que ton auto consomme (indiqué au tableau de bord ou dans le manuel). Sert à estimer ce que coûte en essence l'aller-retour jusqu'à une station. Exemple : une station à 5 km (10 km aller-retour) ≈ "+fmtArgent(exemple)+" d'essence."}>
          <Nombre label="la consommation" value={r.conso} onChange={v=>maj("conso",v)} min={2} max={30} step={0.5} unite="L / 100 km" />
        </Ligne>
      </Section>

      <Section titre="Mes données">
        <div style={{display:"flex",flexDirection:"column",gap:8,paddingTop:12}}>
          <button className="tab" disabled={!nbFavs} onClick={onEffacerFavs} style={{padding:"11px",borderRadius:12,background:"rgba(var(--ov),0.05)",border:"1px solid rgba(var(--ov),0.1)",color:nbFavs?"var(--err-t)":"var(--t3)",fontSize:13,fontWeight:600}}>
            Effacer mes favoris{nbFavs?" ("+nbFavs+")":""}
          </button>
          <button className="tab" onClick={onReinitialiser} style={{padding:"11px",borderRadius:12,background:"rgba(var(--ov),0.05)",border:"1px solid rgba(var(--ov),0.1)",color:"var(--t2)",fontSize:13,fontWeight:600}}>
            Remettre les réglages par défaut
          </button>
        </div>
      </Section>

      <Section titre="À propos">
        <div style={{fontSize:12,color:"var(--t3)",lineHeight:1.6,paddingTop:10}}>
          {APP_NAME} · version {APP_VERSION}<br/>
          {nbStations.toLocaleString("fr-CA")} stations{dataTs ? " · prix du "+fmtMaj(dataTs).local : ""}<br/>
          Source des prix : {SOURCE_NOM} (regieessencequebec.ca), mis à jour environ toutes les 15 minutes. Les prix sont affichés tels que publiés.{" "}
          Les distances sont des estimations en voiture : elles tiennent compte des ponts sur le fleuve, mais pas des traversiers ni du trajet exact.{" "}
          {APP_NAME} est une application indépendante, non affiliée à la Régie.
        </div>
      </Section>

      {donUrl && (
        <Section titre="Soutenir Écono Gaz">
          <div style={{fontSize:13,color:"var(--t2)",lineHeight:1.5,padding:"10px 0"}}>
            L'app est gratuite, sans pub, sans compte et sans témoin. Si elle t'aide à économiser, tu peux offrir un café pour couvrir les frais.
          </div>
          <a href={donUrl} target="_blank" rel="noreferrer" style={{display:"block",textAlign:"center",padding:"12px",borderRadius:12,background:"var(--accent)",color:ON_COLOR,fontSize:14,fontWeight:700,textDecoration:"none"}}>☕ Offrir un café</a>
        </Section>
      )}

      {statsDispo && (
        <Section titre="Statistiques">
          <Ligne titre="Compter ma visite (anonyme)" aide="Nous aide à savoir combien de personnes utilisent l'app. Aucun témoin (cookie), aucune donnée personnelle conservée. Désactivé aussi si ton navigateur demande « Ne pas me suivre ».">
            <Choix label="Compter ma visite" value={r.stats} onChange={v=>maj("stats",v)} options={[[true,"Oui"],[false,"Non"]]} />
          </Ligne>
        </Section>
      )}

      <Section titre="Confidentialité">
        <div style={{fontSize:12,color:"var(--t3)",lineHeight:1.6,paddingTop:10}}>
          Aucun compte, aucun témoin (cookie), aucun suivi publicitaire.
          Ta position est utilisée seulement sur ton appareil, quand tu touches « Me localiser », et n'est jamais envoyée à {APP_NAME}.
          Pour « Trajet », le départ (arrondi à environ 1 km) et l'arrivée sont envoyés au service d'itinéraire OSRM (FOSSGIS), seulement quand tu touches « Trouver les stations ».
          Tes favoris, réglages et derniers trajets restent dans ton navigateur.{" "}
          <a href="confidentialite.html" style={{color:"var(--t2)"}}>Politique de confidentialité complète</a>
        </div>
      </Section>

      <Section titre="Nous joindre">
        <div style={{fontSize:12,color:"var(--t3)",lineHeight:1.6,paddingTop:10}}>
          Une idée, un bug, une question ?{" "}
          <a href={"mailto:"+CONTACT_EMAIL+"?subject="+encodeURIComponent(APP_NAME+" – commentaire (v"+APP_VERSION+")")} style={{color:"var(--t2)"}}>{CONTACT_EMAIL}</a>
          <br/>Pour un prix erroné à une station, utilise plutôt « Signaler un prix » : le signalement va directement à la Régie.
        </div>
      </Section>
    </div>
  );
}

// ── Bottom Sheet ──────────────────────────────────────────────
// Lien Google Maps : départ → station → arrivée (les autres apps ne gèrent pas les arrêts par lien)
function urlTrajetAvecArret(dep, arr, s) {
  const lieu = p => p.type==="position" ? null : encodeURIComponent(p.nom+", QC");
  const o = lieu(dep);
  return "https://www.google.com/maps/dir/?api=1&travelmode=driving"+(o?"&origin="+o:"")+"&destination="+lieu(arr)+"&waypoints="+s.lat+","+s.lng;
}

function StationSheet({ station, carb, gps, priceRange, onClose, onVoirCarte, fav, onToggleFav, navApp, onNavApp, plein, conso, trajetNav, onLocaliser }) {
  const [locEtat, setLocEtat] = useState(null); // null | "encours" | "erreur"
  const cInfo   = CARBURANTS.find(c=>c.key===carb);
  const startY  = useRef(null);
  const sheetRef = useRef(null);
  const [dragY, setDragY] = useState(0);
  const [autresApps, setAutresApps] = useState(false);
  // Fermer avec Échap
  useEffect(()=>{
    const onKey = e => { if (e.key==="Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  },[onClose]);
  const onBackdrop   = e => { if (e.target===e.currentTarget) onClose(); };
  // Le panneau suit le doigt, seulement si son contenu est défilé tout en haut
  const onTouchStart = e => { startY.current = (sheetRef.current?.scrollTop??0)<=0 ? e.touches[0].clientY : null; };
  const onTouchMove  = e => { if (startY.current==null) return; const d=e.touches[0].clientY-startY.current; setDragY(d>0?d:0); };
  const onTouchEnd   = () => { if (dragY>100) onClose(); setDragY(0); startY.current=null; };
  if (!station) return null;

  const activeP  = station[carb];
  const zone     = priceRange?.[carb];
  const aColor   = priceColor(activeP, zone);
  const aLabel   = priceLabel(activeP, zone);
  // Économie sur un plein vs moyenne de la zone (prix en ¢/L)
  const eco      = activeP!=null&&zone?.avg!=null ? (zone.avg-activeP)*plein/100 : null;
  // Coût en essence de l'aller-retour jusqu'à la station (selon la consommation du véhicule)
  const coutTrajet = activeP!=null&&gps&&station.dist!=null ? station.dist*2*conso/100*activeP/100 : null; // dist = estimation route
  const prix     = CARBURANTS.map(c=>({...c, val:station[c.key]}));
  const mailUrl  = "mailto:"+REPORT_EMAIL+"?subject="+encodeURIComponent("Signalement prix - "+(station.banniere||"")+" - "+station.adresse)
    +"&body="+encodeURIComponent("Station : "+(station.banniere||"")+"\nAdresse : "+station.adresse+"\nPrix affiché dans l'app : "+CARBURANTS.map(c=>c.label+" "+(fmt(station[c.key])??"n/d")).join(", ")+"\nPrix constaté à la pompe : ");

  return (
    <div onClick={onBackdrop} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:2000,display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}}>
      <div ref={sheetRef} role="dialog" aria-modal="true" aria-label={"Détails "+(station.banniere||"station")}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{transform:dragY?"translateY("+dragY+"px)":undefined,transition:dragY?"none":"transform 0.2s",width:"100%",maxWidth:480,margin:"0 auto",background:"var(--surface)",borderRadius:"20px 20px 0 0",padding:"0 0 40px",maxHeight:"85vh",overflowY:"auto",animation:"sheetUp 0.28s cubic-bezier(0.34,1.2,0.64,1)",borderTop:"2px solid "+aColor}}>
        <div style={{display:"flex",justifyContent:"center",padding:"12px 0 4px"}}>
          <div style={{width:40,height:4,borderRadius:2,background:"rgba(var(--ov),0.15)"}} />
        </div>
        <div style={{padding:"12px 20px 16px",borderBottom:"1px solid rgba(var(--ov),0.07)"}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:20,fontWeight:700,letterSpacing:-0.3,color:"var(--t1)"}}>{station.banniere||"—"}</div>
              <div style={{fontSize:12,color:"var(--t3)",marginTop:2}}>{station.adresse}</div>
              {station.costco && <div style={{fontSize:12,color:"var(--warn-t)",marginTop:2}}>* Réservé aux membres Costco (carte de membre exigée à la pompe)</div>}
              <div style={{fontSize:11,color:"var(--t3)",marginTop:1}}>{station.region}</div>
            </div>
            <div style={{display:"flex",gap:8,flexShrink:0}}>
            <button onClick={()=>onToggleFav(station.id)} aria-pressed={fav} aria-label={fav?"Retirer des favoris":"Ajouter aux favoris"} style={{background:"rgba(var(--ov),0.08)",border:"none",borderRadius:"50%",width:32,height:32,cursor:"pointer",color:fav?"var(--high)":"var(--t3)",fontSize:17,display:"flex",alignItems:"center",justifyContent:"center"}}>{fav?"♥":"♡"}</button>
            <button onClick={onClose} aria-label="Fermer" style={{background:"rgba(var(--ov),0.08)",border:"none",borderRadius:"50%",width:32,height:32,cursor:"pointer",color:"var(--t3)",fontSize:14,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
          </div>
          {activeP!=null && (
            <div style={{marginTop:14,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontFamily:POLICE_MONO,fontSize:32,fontWeight:700,color:aColor,lineHeight:1}}>{fmt(activeP)}</span>
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                <span style={{fontSize:11,color:"var(--t3)"}}>{cInfo.label}, le litre</span>
                {aLabel && <span style={{fontSize:11,color:aColor,fontWeight:600}}>{aLabel}</span>}
              </div>
            </div>
          )}
          {eco!=null && (
            <div style={{marginTop:10,fontSize:12,fontWeight:600,color:eco>0.05?TIER_COLOR.low:"var(--t3)"}}>
              {eco>0.05 ? "Tu économises ≈ "+fmtArgent(eco)+" sur ton plein de "+plein+" L par rapport à la moyenne des stations affichées."
               : eco<-0.05 ? "Tu paies ≈ "+fmtArgent(eco)+" de plus sur ton plein de "+plein+" L que la moyenne des stations affichées."
               : "Prix dans la moyenne des stations affichées."}
            </div>
          )}
          {gps&&station.dist!=null && (
            <div style={{marginTop:8,fontSize:12,color:"var(--t3)"}}>
              📍 ≈ {fmtDist(station.dist)} en voiture{station.pont ? ", par le "+station.pont : ""}
              {coutTrajet!=null && <> · aller-retour ≈ {fmtArgent(coutTrajet)} d'essence</>}
            </div>
          )}
          {!gps && station.kmTrajet==null && onLocaliser && station.lat && (
            <button onClick={()=>{ setLocEtat("encours"); onLocaliser().then(()=>setLocEtat(null), ()=>setLocEtat("erreur")); }}
              style={{marginTop:8,background:"none",border:"none",padding:0,color:"var(--t2)",fontSize:12,textDecoration:"underline",cursor:"pointer",fontFamily:"inherit"}}>
              {locEtat==="encours" ? "Localisation…" : locEtat==="erreur" ? "📍 Position introuvable — réessayer" : "📍 Afficher la distance jusqu'ici"}
            </button>
          )}
          {station.kmTrajet!=null && (
            <div style={{marginTop:8,fontSize:12,color:"var(--t3)"}}>
              🛣 Au km {Math.round(station.kmTrajet)} de ton trajet · {station.detour<0.1 ? "sur la route" : "détour ≈ "+fmtDist(station.detour)}
              {activeP!=null && station.detour>=0.1 && <> (≈ {fmtArgent(station.detour*conso/100*activeP/100)} d'essence)</>}
            </div>
          )}
        </div>
        <div style={{padding:"16px 20px",borderBottom:"1px solid rgba(var(--ov),0.07)"}}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--t3)",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Prix de cette station</div>
          <div style={{display:"flex",gap:8}}>
            {prix.map(c=>{
              const range = priceRange?.[c.key];
              const pc    = priceColor(c.val, range);
              const pl    = priceLabel(c.val, range);
              const active = c.key===carb;
              return (
                <div key={c.key} style={{flex:1,borderRadius:12,padding:"12px 8px",textAlign:"center",background:active?"rgba(var(--ov),0.08)":"rgba(var(--ov),0.03)",border:active?"1px solid rgba(var(--ov),0.18)":"1px solid rgba(var(--ov),0.05)"}}>
                  <div style={{fontSize:11,color:active?"var(--t1)":"var(--t3)",fontWeight:active?600:400,marginBottom:6}}>{c.label}</div>
                  {c.val!=null ? (
                    <>
                      <div style={{fontFamily:POLICE_MONO,fontSize:active?20:16,fontWeight:600,color:pc,lineHeight:1}}>{fmt(c.val)}</div>
                      {pl && <div style={{fontSize:11,color:pc,marginTop:4,opacity:0.85}}>{pl}</div>}
                    </>
                  ) : station.inhabituels?.[c.key]!=null ? (
                    <div style={{fontSize:12,color:"var(--warn-t)"}}>{fmt(station.inhabituels[c.key])}<br/>⚠ prix inhabituel</div>
                  ) : <div style={{fontSize:12,color:"var(--t3)"}}>Non offert</div>}
                </div>
              );
            })}
          </div>
        </div>
        <div style={{padding:"16px 20px",display:"flex",gap:10}}>
          <button onClick={()=>{ onClose(); onVoirCarte(station); }} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"12px",borderRadius:14,background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.1)",color:"var(--t3)",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            {"🌐"} Voir sur la carte
          </button>
          <a href={navUrl(station,navApp)} target="_blank" rel="noreferrer" style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,padding:"8px 12px",borderRadius:14,textDecoration:"none",background:aColor,border:"none",color:ON_COLOR,fontSize:13,fontWeight:700}}>
            <span>{"🧭"} Itinéraire</span>
            <span style={{fontSize:11,fontWeight:600,opacity:0.8}}>avec {navLabel(navApp)}</span>
          </a>
        </div>
        <div style={{padding:"0 20px 12px"}}>
          <button onClick={()=>setAutresApps(v=>!v)} aria-expanded={autresApps} style={{background:"none",border:"none",color:"var(--t3)",fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:"2px 0",textDecoration:"underline"}}>
            Ouvrir avec une autre app
          </button>
          {autresApps && (
            <div style={{display:"flex",gap:8,marginTop:8}}>
              {NAV_APPS.map(a=>(
                <a key={a.key} href={navUrl(station,a.key)} target="_blank" rel="noreferrer" onClick={()=>{ onNavApp(a.key); setAutresApps(false); }}
                  style={{flex:1,textAlign:"center",padding:"9px 4px",borderRadius:10,textDecoration:"none",fontSize:12,fontWeight:600,
                    background:a.key===navApp?"rgba(var(--ov),0.12)":"rgba(var(--ov),0.05)",border:"1px solid "+(a.key===navApp?"rgba(var(--ov),0.25)":"rgba(var(--ov),0.08)"),color:"var(--t1)"}}>
                  {a.label}{a.key===navApp?" ✓":""}
                </a>
              ))}
            </div>
          )}
          {autresApps && <div style={{fontSize:11,color:"var(--t3)",marginTop:6}}>L'app choisie sera utilisée par défaut ensuite.</div>}
        </div>
        {trajetNav && station.kmTrajet!=null && station.lat && station.lng && (
          <div style={{padding:"0 20px 12px"}}>
            <a href={urlTrajetAvecArret(trajetNav.dep, trajetNav.arr, station)} target="_blank" rel="noreferrer"
              style={{display:"block",textAlign:"center",padding:"10px",borderRadius:12,background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.1)",color:"var(--t1)",fontSize:12,fontWeight:600,textDecoration:"none"}}>
              🛣 Tout le trajet avec un arrêt ici (Google Maps)
            </a>
          </div>
        )}
        <div style={{padding:"0 20px",display:"flex",gap:8}}>
          {typeof navigator!=="undefined" && navigator.share && (
            <button onClick={()=>navigator.share({title:station.banniere, text:(station.banniere||"Station")+" · "+(fmt(activeP)??"")+" "+cInfo.label.toLowerCase()+" · "+station.adresse, url:location.href.split("#")[0]}).catch(()=>{})}
              style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"10px",borderRadius:12,background:"rgba(var(--ov),0.03)",border:"1px solid rgba(var(--ov),0.06)",color:"var(--t3)",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
              {"↗"} Partager
            </button>
          )}
          <a href={mailUrl} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"10px",borderRadius:12,background:"rgba(var(--ov),0.03)",border:"1px solid rgba(var(--ov),0.06)",color:"var(--t3)",fontSize:11,textDecoration:"none"}}>
            {"⚠️"} Signaler un prix
          </a>
        </div>
        <div style={{padding:"12px 20px 0",fontSize:11,color:"var(--t3)",textAlign:"center"}}>Source : {SOURCE_NOM}</div>
      </div>
    </div>
  );
}

// ── Carte Leaflet ──────────────────────────────────────────────
function CarteView({ stations, carb, gps, minP, maxP, priceRange, onSelectStation, focusStation, onFocusDone, route, cadrer, compact }) {
  const mapRef      = useRef(null);
  const leafletRef  = useRef(null);
  const markersRef  = useRef(null);
  const routeRef    = useRef(null);
  const focusRef    = useRef(focusStation); // garder la dernière valeur pour l'init

  // Mettre à jour focusRef à chaque changement
  useEffect(() => { focusRef.current = focusStation; }, [focusStation]);

  // Centrer sur la station — fonctionne que la carte soit déjà init ou pas
  useEffect(() => {
    if (!focusStation?.lat || !focusStation?.lng) return;
    const map = leafletRef.current;
    if (!map) return; // sera géré après l'init
    map.setView([focusStation.lat, focusStation.lng], 16, {animate:true});
    onFocusDone();
  }, [focusStation]);

  // Initialiser la carte Leaflet une seule fois
  useEffect(() => {
    if (leafletRef.current) return;
    const L = window.L;
    if (!L) return;

    // Centre initial : station focalisée > GPS > Québec
    const focus = focusRef.current;
    const initCenter = focus?.lat ? [focus.lat, focus.lng] : gps ? [gps.lat, gps.lng] : [53.0, -70.0];
    const initZoom   = focus?.lat ? 16 : gps ? 12 : 5;

    const map = L.map(mapRef.current, {
      center: initCenter,
      zoom: initZoom,
      zoomControl: true,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap · Prix : Régie essence Québec",
      maxZoom: 19,
    }).addTo(map);

    leafletRef.current = map;

    // Si un focus était en attente, le consommer maintenant
    if (focus?.lat && focus?.lng) {
      onFocusDone();
    }

    // Région choisie : cadrer sur ses stations plutôt que sur tout le Québec
    if (!focus?.lat && !gps && cadrer) {
      const pts = stations.filter(s=>s.lat&&s.lng).map(s=>[s.lat,s.lng]);
      if (pts.length) map.fitBounds(pts, { padding:[24,24], maxZoom:13 });
    }

    return () => { map.remove(); leafletRef.current = null; };
  }, []);

  // Marqueur « Tu es ici » : suit la position, même si on se localise avec la carte déjà ouverte
  const gpsRef = useRef(null);
  useEffect(() => {
    const L = window.L, map = leafletRef.current;
    if (!L || !map) return;
    if (gpsRef.current) { map.removeLayer(gpsRef.current); gpsRef.current = null; }
    if (!gps) return;
    gpsRef.current = L.circleMarker([gps.lat, gps.lng], {
      radius: 8, fillColor: "#16a34a", color: "#fff", weight: 2, opacity: 1, fillOpacity: 1,
    }).addTo(map).bindPopup("Tu es ici");
    if (!focusRef.current) map.setView([gps.lat, gps.lng], Math.max(map.getZoom(), 12));
  }, [gps?.lat, gps?.lng]);

  // Trajet : tracé de la route + départ (A) et arrivée (B), cadrage sur tout le trajet
  useEffect(() => {
    const L = window.L, map = leafletRef.current;
    if (!L || !map) return;
    if (routeRef.current) { map.removeLayer(routeRef.current); routeRef.current = null; }
    if (!route?.pts || route.pts.length<2) return;
    const pastille = (ll, txt) => L.marker(ll, { interactive:false, zIndexOffset:2000, icon: L.divIcon({ className:"", iconSize:[26,26], iconAnchor:[13,13],
      html:"<div style=\"background:#3b82f6;color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)\">"+txt+"</div>" }) });
    const ligne = L.polyline(route.pts, { color:"#3b82f6", weight:5, opacity:0.75, dashArray: route.source==="estimation" ? "8 8" : null });
    const couches = [ligne, pastille(route.pts[0],"A"), pastille(route.pts[route.pts.length-1],"B")];
    if (route.limite) couches.push(L.marker(route.limite, { interactive:false, zIndexOffset:2000, icon: L.divIcon({ className:"", iconSize:[30,30], iconAnchor:[15,15],
      html:"<div title=\"Limite d'autonomie\" style=\"background:#f59e0b;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:15px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)\">⛽</div>" }) }));
    routeRef.current = L.layerGroup(couches).addTo(map);
    if (!focusRef.current) map.fitBounds(ligne.getBounds(), { padding:[24,24] });
    map.attributionControl.addAttribution("Itinéraire : OSRM / FOSSGIS");
  }, [route]);

  // Mettre à jour les marqueurs quand stations/carb changent
  useEffect(() => {
    const L = window.L;
    const map = leafletRef.current;
    if (!L || !map) return;

    // Supprimer anciens clusters
    if (markersRef.current) {
      map.removeLayer(markersRef.current);
    }

    const cluster = L.markerClusterGroup({
      maxClusterRadius: 40,
      iconCreateFunction: (c) => {
        const count = c.getChildCount();
        // Couleur du cluster = couleur du prix médian du groupe
        const markers = c.getAllChildMarkers();
        const prices = markers.map(m => m.options.price).filter(p => p != null).sort((a,b)=>a-b);
        const median = prices.length ? prices[Math.floor(prices.length/2)] : null;
        const range  = priceRange?.[carb];
        const col    = priceColor(median, range);
        return L.divIcon({
          html: "<div style=\"background:"+col+";color:var(--on);border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;border:2px solid rgba(255,255,255,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.4)\">"+count+"</div>",
          className: "", iconSize: [36,36], iconAnchor: [18,18],
        });
      },
    });

    const range = priceRange?.[carb];
    stations.forEach(s => {
      if (!s.lat || !s.lng) return;
      const p   = s[carb];
      const col = priceColor(p, range);
      const icon = L.divIcon({
        html: "<div style=\"background:"+col+";color:var(--on);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;border:2px solid rgba(255,255,255,0.6);box-shadow:0 2px 6px rgba(0,0,0,0.4);white-space:nowrap;\">"+(p ? dec(p) : "?")+"</div>",
        className: "", iconSize: [28,28], iconAnchor: [14,14],
      });
      const marker = L.marker([s.lat, s.lng], { icon, price: p });
      marker.on("click", () => onSelectStation(s));
      cluster.addLayer(marker);
    });

    map.addLayer(cluster);
    markersRef.current = cluster;
  }, [stations, carb, priceRange]);

  // Hauteur = espace réellement disponible entre le haut de la carte et la barre de navigation
  const boxRef = useRef(null);
  const [h, setH] = useState(400);
  useLayoutEffect(()=>{
    const calc = ()=>{
      const top = boxRef.current?.getBoundingClientRect().top ?? 0;
      const nav = document.getElementById("barre-nav")?.getBoundingClientRect().height ?? 80;
      // Carte placée sous d'autres contenus (Trajet) : hauteur fixe, sinon tout l'espace jusqu'à la barre du bas
      setH(compact ? Math.max(320, Math.round(window.innerHeight*0.6)) : Math.max(260, window.innerHeight - top - nav - 8));
    };
    calc();
    window.addEventListener("resize", calc);
    return ()=>window.removeEventListener("resize", calc);
  },[]);
  useEffect(()=>{ leafletRef.current?.invalidateSize(); },[h]);

  return (
    <div ref={boxRef} style={{position:"relative",height:h,zIndex:0,isolation:"isolate"}}>
      <div ref={mapRef} style={{width:"100%",height:"100%"}} />
      {/* Légende */}
      <div aria-label="Légende des prix" style={{position:"absolute",top:10,right:10,zIndex:1000,background:"var(--panel-bg)",borderRadius:10,padding:"4px 8px",border:"1px solid rgba(var(--ov),0.08)",display:"flex",gap:8,pointerEvents:"none"}}>
        {[["var(--accent)","Bas"],["var(--mid)","Moyen"],["var(--high)","Élevé"]].map(([col,label])=>(
          <div key={label} style={{display:"flex",alignItems:"center",gap:4}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:col,flexShrink:0}} />
            <span style={{fontSize:11,color:"var(--t3)"}}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Trajet : champ « ville » avec suggestions (recherche sur l'appareil seulement) ──
function VilleChamp({ id, label, valeur, villes, onChoix, onPosition, positionEnCours }) {
  const [txt, setTxt] = useState(valeur?.nom ?? "");
  const [ouvert, setOuvert] = useState(false);
  const [actif, setActif] = useState(0);
  const ecrit = useRef(false); // l'utilisateur est en train de taper : ne pas effacer son texte
  useEffect(()=>{ if (valeur) { setTxt(valeur.nom); ecrit.current=false; } else if (!ecrit.current) setTxt(""); },[valeur]);
  const sugg = useMemo(()=>ouvert ? chercherVilles(villes, txt) : [],[villes, txt, ouvert]);
  const choisir = v => { ecrit.current=false; onChoix({ type:"ville", nom:v.nom, cle:v.cle, lat:v.lat, lng:v.lng }); setOuvert(false); };
  const champ = { width:"100%", background:"rgba(var(--ov),0.06)", border:"1px solid rgba(var(--ov),0.1)", borderRadius:12, padding:"10px 12px", color:"var(--t1)", fontSize:16, fontFamily:"inherit", outline:"none" };
  return (
    <div style={{position:"relative"}}>
      <label htmlFor={id} style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>{label}</label>
      <div style={{display:"flex",gap:6,marginTop:4}}>
        <input id={id} value={txt} autoComplete="off" role="combobox" aria-expanded={sugg.length>0} aria-controls={id+"-liste"} aria-autocomplete="list"
          placeholder="Ville ou municipalité…" style={champ}
          onChange={e=>{ ecrit.current=true; setTxt(e.target.value); setOuvert(true); setActif(0); if (valeur) onChoix(null); }}
          onFocus={e=>{ if (valeur?.type==="position") e.target.select(); setOuvert(true); }}
          onBlur={()=>setTimeout(()=>setOuvert(false),150)}
          onKeyDown={e=>{
            if (e.key==="ArrowDown") { e.preventDefault(); setActif(a=>Math.min(a+1, sugg.length-1)); }
            else if (e.key==="ArrowUp") { e.preventDefault(); setActif(a=>Math.max(a-1, 0)); }
            else if (e.key==="Enter" && sugg[actif]) { e.preventDefault(); choisir(sugg[actif]); e.currentTarget.blur(); }
            else if (e.key==="Escape") setOuvert(false);
          }} />
        {onPosition && (
          <button className="tab" onClick={onPosition} aria-label={"Utiliser ma position comme "+label.toLowerCase()} title="Ma position"
            style={{flexShrink:0,width:44,borderRadius:12,background:valeur?.type==="position"?"var(--accent)":"rgba(var(--ov),0.08)",color:valeur?.type==="position"?ON_COLOR:"var(--t2)",fontSize:16,border:"1px solid rgba(var(--ov),0.1)"}}>
            {positionEnCours ? <span className="pulse">⟳</span> : "📍"}
          </button>
        )}
      </div>
      {sugg.length>0 && (
        <ul id={id+"-liste"} role="listbox" style={{position:"absolute",left:0,right:0,top:"100%",zIndex:1500,listStyle:"none",margin:"4px 0 0",padding:4,background:"var(--surface)",border:"1px solid rgba(var(--ov),0.15)",borderRadius:12,boxShadow:"0 8px 24px rgba(0,0,0,0.35)"}}>
          {sugg.map((v,i)=>(
            <li key={v.cle} role="option" aria-selected={i===actif} onMouseDown={e=>{ e.preventDefault(); choisir(v); }}
              style={{padding:"9px 10px",borderRadius:8,cursor:"pointer",background:i===actif?"rgba(var(--ov),0.14)":"transparent",borderLeft:"3px solid "+(i===actif?"var(--accent)":"transparent")}}>
              <div style={{fontSize:14,color:"var(--t1)"}}>{v.nom}</div>
              <div style={{fontSize:11,color:"var(--t3)"}}>{v.region} · {v.n} station{v.n>1?"s":""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtDuree(min) { const h=Math.floor(min/60), m=Math.round(min%60); return h ? h+NBSP+"h"+(m?" "+String(m).padStart(2,"0"):"") : m+NBSP+"min"; }
const PAS_TRAJET = 30;

function TrajetVue({ villes, trajet, setTrajet, resultat, calcul, onCalculer, cands, range, carb, cInfo, reglages, majReglage,
  favs, toggleFav, onSelect, navApp, carteFocus, setCarteFocus, onPosition, compte }) {
  const [ordre, setOrdre] = useState("prix");     // prix | trajet
  const [mode, setMode]   = useState("liste");    // liste | carte
  const [nb, setNb]       = useState(PAS_TRAJET);
  const [posEnCours, setPosEnCours] = useState(false);
  const [posErr, setPosErr] = useState(null);
  const [infoAut, basculerAut] = useInfo();
  const [infoEcart, basculerEcart] = useInfo();
  const [infoOsrm, basculerOsrm] = useInfo();
  useEffect(()=>{ setNb(PAS_TRAJET); },[resultat, carb, ordre, reglages.detourMax]);
  useEffect(()=>{ if (carteFocus) setMode("carte"); },[carteFocus]); // « Voir sur la carte » depuis le panneau
  const carteRef = useRef(null);
  useEffect(()=>{ if (mode==="carte") carteRef.current?.scrollIntoView({ behavior:"smooth", block:"start" }); },[mode]);
  const { dep, arr } = trajet;
  const pret = dep && arr && !(dep.lat===arr.lat && dep.lng===arr.lng);
  const avecPrix = useMemo(()=>cands.filter(s=>s[carb]!=null),[cands,carb]);
  const tries = useMemo(()=>[...avecPrix].sort(ordre==="trajet" ? (a,b)=>a.kmTrajet-b.kmTrajet : (a,b)=>(a[carb]-b[carb])||(a.detour-b.detour)),[avecPrix,ordre,carb]);
  const aut = trajet.autonomie>0 ? trajet.autonomie : null;
  const atteignable = useCallback(s=>portee(s, aut).ok,[aut]);
  const comptees = useMemo(()=>avecPrix.filter(s=>compte(s) && atteignable(s)),[avecPrix,compte,atteignable]);
  const nbAtteignables = useMemo(()=>avecPrix.filter(atteignable).length,[avecPrix,atteignable]);
  // Point du trajet où l'autonomie est épuisée (affiché sur la carte)
  const routeCarte = useMemo(()=>{
    if (!resultat) return null;
    if (!aut || aut>=resultat.km) return resultat;
    const f = resultat.km / (longueurTrace(resultat.pts) || 1);
    return { ...resultat, limite: pointAuKm(resultat.pts, aut/f) };
  },[resultat, aut]);
  const best = useMemo(()=>meilleurChoix(comptees, carb, reglages.plein, reglages.conso),[comptees,carb,reglages.plein,reglages.conso]);
  const moinsCher = comptees.length ? [...comptees].sort((a,b)=>a[carb]-b[carb])[0] : null;
  // Économie du meilleur choix par rapport au prix moyen du trajet, détour compris
  const eco = best && range?.avg!=null ? range.avg/100*reglages.plein - coutPlein(best, carb, reglages.plein, reglages.conso) : null;
  const depPosition = resultat?.dep?.type==="position";
  const info = s => {
    const p = portee(s, aut);
    return "🛣 "+(depPosition ? "dans ≈"+NBSP+Math.round(s.kmTrajet)+NBSP+"km" : "km "+Math.round(s.kmTrajet))
      +" · "+(s.detour<0.1 ? "sur la route" : "détour ≈"+NBSP+fmtDist(s.detour))
      +(!p.ok ? " · hors d'atteinte" : p.limite ? " · à la limite" : "");
  };
  const prendrePosition = async ()=>{
    setPosEnCours(true); setPosErr(null);
    try { const p = await onPosition(); setTrajet(t=>({...t, dep:{ type:"position", nom:"Ma position", ...p }})); }
    catch (e) { setPosErr(e); }
    finally { setPosEnCours(false); }
  };
  const btnMini = actif => ({ flex:1, padding:"7px 0", borderRadius:8, fontSize:12, fontWeight:600, background:actif?"var(--accent)":"rgba(var(--ov),0.06)", color:actif?ON_COLOR:"var(--t2)", border:actif?"none":"1px solid rgba(var(--ov),0.08)" });

  return (
    <div style={{padding:"14px 20px"}}>
      <div style={{fontSize:12,fontWeight:600,color:"var(--t3)",marginBottom:10,textTransform:"uppercase",letterSpacing:1}}>Prix sur mon trajet · {cInfo.label}</div>
      <div style={{display:"flex",flexDirection:"column",gap:10,padding:"12px",borderRadius:16,background:"rgba(var(--ov),0.03)",border:"1px solid rgba(var(--ov),0.07)"}}>
        <VilleChamp id="trajet-dep" label="Départ" valeur={dep} villes={villes} onChoix={v=>setTrajet(t=>({...t, dep:v}))} onPosition={prendrePosition} positionEnCours={posEnCours} />
        {posErr && <GpsAide err={posErr} onRetry={prendrePosition} onClose={()=>setPosErr(null)} />}
        <div style={{display:"flex",justifyContent:"center",margin:"-4px 0 -6px"}}>
          <button className="tab" onClick={()=>setTrajet(t=>({...t, dep:t.arr, arr:t.dep}))} aria-label="Inverser départ et arrivée"
            style={{padding:"2px 12px",borderRadius:8,background:"rgba(var(--ov),0.06)",color:"var(--t2)",fontSize:15}}>⇅</button>
        </div>
        <VilleChamp id="trajet-arr" label="Arrivée" valeur={arr} villes={villes} onChoix={v=>setTrajet(t=>({...t, arr:v}))} />
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <label htmlFor="trajet-autonomie" style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Autonomie restante (facultatif)</label>
            <BoutonInfo ouvert={infoAut} basculer={basculerAut} sujet="autonomie" />
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
            <input id="trajet-autonomie" inputMode="numeric" placeholder="ex. 120" value={trajet.autonomie ?? ""}
              onChange={e=>{ const n = parseInt(e.target.value.replace(/\D/g,""),10); setTrajet(t=>({...t, autonomie: n>0 ? Math.min(n,2000) : null})); }}
              style={{width:110,background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.1)",borderRadius:12,padding:"10px 12px",color:"var(--t1)",fontSize:16,fontFamily:POLICE_MONO,outline:"none"}} />
            <span style={{fontSize:13,color:"var(--t3)"}}>km avant la panne sèche</span>
          </div>
          <TexteInfo ouvert={infoAut}>Le nombre de kilomètres que tu peux encore rouler, affiché au tableau de bord. Si tu l'indiques, seules les stations que tu peux atteindre sont proposées, et la carte montre où tu tomberais à sec (⛽). Laisse vide si ton réservoir est plein.</TexteInfo>
        </div>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
            <div style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Stations à moins de… de la route</div>
            <BoutonInfo ouvert={infoEcart} basculer={basculerEcart} sujet="distance de la route" />
          </div>
          <TexteInfo ouvert={infoEcart}>Seules les stations situées à moins de 1, 3 ou 5 km de ton itinéraire sont proposées. Pour chacune, le « détour » est l'aller-retour estimé entre la route et la station. Plus l'écart est grand, plus il y a de choix, mais plus les détours sont longs.</TexteInfo>
          <div role="radiogroup" aria-label="Stations à moins de… de la route" style={{display:"flex",gap:6,marginTop:4}}>
            {DETOURS.map(d=>(
              <button key={d} role="radio" aria-checked={reglages.detourMax===d} className="tab" onClick={()=>majReglage("detourMax",d)} style={btnMini(reglages.detourMax===d)}>{reglages.detourMax===d?"✓ ":""}{d}{NBSP}km</button>
            ))}
          </div>
        </div>
        <button className="tab" disabled={!pret||calcul.enCours} onClick={onCalculer}
          style={{padding:"12px",borderRadius:12,background:pret?"var(--accent)":"rgba(var(--ov),0.08)",color:pret?ON_COLOR:"var(--t3)",fontSize:14,fontWeight:700,cursor:pret?"pointer":"default"}}>
          {calcul.enCours ? <><span className="pulse">⟳</span> Calcul de l'itinéraire…</> : "Trouver les stations"}
        </button>
        {dep && arr && !pret && <div style={{fontSize:12,color:"var(--warn-t)"}}>Choisis deux endroits différents.</div>}
        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--t3)"}}>
          <span>Itinéraire calculé par OSRM (OpenStreetMap)</span>
          <BoutonInfo ouvert={infoOsrm} basculer={basculerOsrm} sujet="confidentialité de l'itinéraire" />
        </div>
        <TexteInfo ouvert={infoOsrm}>Pour tracer la route, ton départ (arrondi à environ 1 km si c'est ta position) et ton arrivée sont envoyés au service d'itinéraire OSRM, seulement quand tu touches « Trouver les stations ». Rien n'est envoyé pendant que tu tapes : les villes sont proposées à partir de la liste des stations.</TexteInfo>
      </div>

      {resultat && (
        <div style={{marginTop:14}}>
          <div style={{fontSize:14,fontWeight:700}}>{resultat.depNom} → {resultat.arrNom}</div>
          {(dep?.nom!==resultat.depNom || arr?.nom!==resultat.arrNom || (dep?.type==="position" && (dep.lat!==resultat.dep.lat || dep.lng!==resultat.dep.lng))) && (
            <div role="status" style={{marginTop:6,fontSize:12,color:"var(--warn-t)"}}>Tu as changé le départ ou l'arrivée : touche « Trouver les stations » pour mettre à jour.</div>
          )}
          <div style={{fontSize:12,color:"var(--t3)",marginTop:2}}>
            ≈ {Math.round(resultat.km)}{NBSP}km · {fmtDuree(resultat.min)} · {avecPrix.length} station{avecPrix.length>1?"s":""} à moins de {reglages.detourMax}{NBSP}km de la route
          </div>
          {aut && (()=>{
            const ok = aut>=resultat.km, aucune = nbAtteignables===0;
            const couleur = ok ? ["rgba(34,197,94,0.08)","rgba(34,197,94,0.3)","var(--low)"] : aucune ? ["rgba(248,113,113,0.1)","rgba(248,113,113,0.35)","var(--err-t)"] : ["rgba(245,158,11,0.1)","rgba(245,158,11,0.35)","var(--warn-t)"];
            return (
              <div role="status" style={{marginTop:8,padding:"8px 12px",borderRadius:10,background:couleur[0],border:"1px solid "+couleur[1],fontSize:12,color:couleur[2],lineHeight:1.5}}>
                {ok ? <>Avec ≈ {aut}{NBSP}km d'autonomie, tu peux faire tout le trajet ({Math.round(resultat.km)}{NBSP}km) sans t'arrêter.</>
                 : aucune ? <>⚠️ Avec ≈ {aut}{NBSP}km d'autonomie, aucune station du trajet n'est à ta portée{reglages.detourMax<DETOURS[DETOURS.length-1]?" à moins de "+reglages.detourMax+" km de la route":""}. Fais le plein avant de partir{reglages.detourMax<DETOURS[DETOURS.length-1]?" ou choisis une plus grande distance de la route":""}.</>
                 : <>⚠️ Avec ≈ {aut}{NBSP}km d'autonomie, fais le plein avant le km {Math.max(0,Math.floor(aut))} : {nbAtteignables} station{nbAtteignables>1?"s":""} à ta portée.</>}
                {!ok && <> Garde une marge : l'autonomie affichée par l'auto est une estimation.</>}
              </div>
            );
          })()}
          {resultat.source==="estimation" && (
            <div role="status" style={{marginTop:8,padding:"8px 12px",borderRadius:10,background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.35)",fontSize:12,color:"var(--warn-t)"}}>
              Le service d'itinéraire ne répond pas : trajet estimé en ligne droite. Les stations proposées sont approximatives.
            </div>
          )}

          {best && (
            <div style={{marginTop:12}}>
              <StationCard s={best} carb={carb} range={range} best bestLabel="Meilleur choix sur ton trajet" trajetInfo={info(best)} autresCarb={false}
                fav={favs.has(best.id)} onToggleFav={toggleFav} onSelect={onSelect} navApp={navApp}
                onCarte={st=>{ setCarteFocus(st); setMode("carte"); }}
                extra={eco!=null && Math.abs(eco)>=0.05 && (
                  <div style={{fontSize:12,fontWeight:600,marginTop:6,color:eco>0?TIER_COLOR.low:"var(--t3)"}}>
                    {eco>0 ? "Tu économises ≈ "+fmtArgent(eco)+" sur ton plein de "+reglages.plein+" L, même en comptant le détour."
                           : "Prix proche de la moyenne du trajet."}
                  </div>
                )} />
              {moinsCher && moinsCher.id!==best.id && (
                <div style={{fontSize:11,color:"var(--t3)",margin:"-2px 4px 8px",lineHeight:1.5}}>
                  La moins chère {aut ? "à ta portée " : ""}au litre ({moinsCher.banniere}, {fmt(moinsCher[carb])}) demande un plus grand détour : ça ne vaut pas la peine pour un plein de {reglages.plein}{NBSP}L.
                </div>
              )}
            </div>
          )}

          {avecPrix.length>0 && (
            <div style={{display:"flex",gap:6,margin:"8px 0 12px"}}>
              <button className="tab" aria-pressed={mode==="liste"&&ordre==="prix"} onClick={()=>{ setMode("liste"); setOrdre("prix"); }} style={btnMini(mode==="liste"&&ordre==="prix")}>Moins cher</button>
              <button className="tab" aria-pressed={mode==="liste"&&ordre==="trajet"} onClick={()=>{ setMode("liste"); setOrdre("trajet"); }} style={btnMini(mode==="liste"&&ordre==="trajet")}>Dans l'ordre</button>
              <button className="tab" aria-pressed={mode==="carte"} onClick={()=>setMode("carte")} style={btnMini(mode==="carte")}>Carte</button>
            </div>
          )}
          {avecPrix.length===0 && (
            <div style={{textAlign:"center",padding:"30px 10px",color:"var(--t3)",fontSize:14}}>
              Aucune station avec {cInfo.label.toLowerCase()} à moins de {reglages.detourMax}{NBSP}km de la route.
              {reglages.detourMax<DETOURS[DETOURS.length-1] && <> Choisis une plus grande distance de la route.</>}
            </div>
          )}
          {avecPrix.length>0 && (range?.n??0)<MIN_COMPARAISON && (
            <div style={{fontSize:12,color:"var(--t3)",marginBottom:10,padding:"8px 12px",borderRadius:10,background:"rgba(var(--ov),0.04)"}}>
              Trop peu de stations pour comparer les prix : choisis une plus grande distance de la route.
            </div>
          )}

          {mode==="carte" && avecPrix.length>0 ? (
            <div ref={carteRef} style={{scrollMarginTop:12}}><CarteView stations={avecPrix} carb={carb} gps={null} priceRange={{[carb]:range}} route={routeCarte} compact
              focusStation={carteFocus} onFocusDone={()=>setCarteFocus(null)} onSelectStation={onSelect} /></div>
          ) : (
            <>
              {tries.slice(0,nb).map(s=>(
                <div key={s.id} style={{opacity: atteignable(s) ? 1 : 0.45}}>
                  <StationCard s={s} carb={carb} range={range} trajetInfo={info(s)} autresCarb={false}
                    fav={favs.has(s.id)} onToggleFav={toggleFav} onSelect={onSelect} navApp={navApp}
                    onCarte={st=>{ setCarteFocus(st); setMode("carte"); }} />
                </div>
              ))}
              {tries.length>nb && (
                <button className="tab" onClick={()=>setNb(n=>n+PAS_TRAJET)} style={{width:"100%",padding:"10px",borderRadius:12,background:"rgba(var(--ov),0.06)",color:"var(--t2)",fontSize:13,fontWeight:600}}>
                  Afficher plus ({tries.length-nb} autres)
                </button>
              )}
            </>
          )}
          <div style={{padding:"14px 0 30px",fontSize:11,color:"var(--t3)",textAlign:"center",lineHeight:1.6}}>
            Détour = aller-retour estimé entre la route et la station. Itinéraire : OSRM / FOSSGIS · © contributeurs{" "}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" style={{color:"var(--t2)"}}>OpenStreetMap</a>{" "}
            (<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer" style={{color:"var(--t2)"}}>signaler une erreur de carte</a>).
          </div>
        </div>
      )}
    </div>
  );
}

// ── Premier démarrage : quelques réglages pour personnaliser l'app ──
function Accueil({ reglages:r, maj, onFin }) {
  const navDefaut = IS_IOS ? "apple" : "google";
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="accueil-titre" style={{position:"fixed",inset:0,zIndex:3000,background:"var(--bg-grad)",overflowY:"auto"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"calc(env(safe-area-inset-top) + 20px) 20px calc(env(safe-area-inset-bottom) + 24px)",color:"var(--t1)",fontFamily:POLICE}}>
        <div style={{fontSize:36}}>⛽</div>
        <h1 id="accueil-titre" style={{fontSize:24,fontWeight:700,margin:"6px 0 4px"}}>Bienvenue sur {APP_NAME}</h1>
        <div style={{fontSize:14,color:"var(--t2)",lineHeight:1.5}}>Quatre questions rapides pour adapter l'app à ton auto. Tu pourras tout changer plus tard dans Réglages.</div>

        <Ligne titre="1. Ton carburant habituel" aide="Affiché par défaut dans la liste, la carte et Trajet. Tu peux toujours en changer en haut de l'écran.">
          <Choix label="Carburant habituel" value={r.carbDefaut} onChange={v=>maj("carbDefaut",v)} options={CARBURANTS.map(c=>[c.key,c.label])} />
        </Ligne>
        <Ligne titre="2. Ton véhicule" note="Une estimation suffit." aide="La taille du plein sert à calculer combien tu économises sur un plein. La consommation sert à estimer ce que coûte un détour pour aller à une station. Pas besoin d'être exact.">
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Nombre label="la taille du plein" value={r.plein} onChange={v=>maj("plein",v)} min={10} max={200} step={5} unite="litres par plein" />
            <Nombre label="la consommation" value={r.conso} onChange={v=>maj("conso",v)} min={2} max={30} step={0.5} unite="L / 100 km" />
          </div>
        </Ligne>
        <Ligne titre="3. Es-tu membre Costco ?" note="Non : les stations Costco seront cachées." aide="Les stations Costco sont réservées aux membres. Oui : elles s'affichent. Non : elles sont cachées partout dans l'app. Modifiable dans Réglages.">
          <Choix label="Membre Costco" value={r.costcoMembre} onChange={v=>maj("costcoMembre",v)} options={[[true,"Oui"],[false,"Non"]]} />
        </Ligne>
        <Ligne titre="4. Ton app de navigation" aide="L'app ouverte quand tu touches « Itinéraire » sur une station.">
          <Choix label="App de navigation" value={r.navApp||navDefaut} onChange={v=>maj("navApp",v)} options={NAV_APPS.map(a=>[a.key,a.label])} />
        </Ligne>

        <button className="tab" onClick={onFin} style={{width:"100%",marginTop:20,padding:"14px",borderRadius:14,background:"var(--accent)",color:ON_COLOR,fontSize:16,fontWeight:700}}>C'est parti</button>
        <button onClick={onFin} style={{display:"block",margin:"12px auto 0",background:"none",border:"none",color:"var(--t3)",fontSize:13,textDecoration:"underline",cursor:"pointer",fontFamily:"inherit"}}>Passer (garder les réglages par défaut)</button>
      </div>
    </div>
  );
}

export default function App() {
  const [stations, setStations]     = useState([]);
  const [ready, setReady]           = useState(false);
  const [dataTs, setDataTs]         = useState(null);
  const [loadErr, setLoadErr]       = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const leafletReady = true; // Leaflet est intégré au fichier de l'app
  const [reglages, setReglages]     = useState(reglagesInitiaux);
  const majReglage = useCallback((k,v)=>setReglages(r=>({...r,[k]:v})),[]);
  // Station visible sauf si c'est un Costco et qu'on n'est pas membre (réglage « Je suis membre Costco »)
  const compte = useCallback(s=>reglages.costcoMembre || !s.costco,[reglages.costcoMembre]);
  const [carb, setCarb]             = useState(()=>CARBURANTS.some(c=>c.key===reglages.carbDefaut) ? reglages.carbDefaut : "regulier");
  // Trajet a son propre carburant : celui des réglages par défaut (indépendant de l'onglet choisi dans Stations)
  const [carbTrajet, setCarbTrajet] = useState(()=>CARBURANTS.some(c=>c.key===reglages.carbDefaut) ? reglages.carbDefaut : "regulier");
  useEffect(()=>{ if (CARBURANTS.some(c=>c.key===reglages.carbDefaut)) setCarbTrajet(reglages.carbDefaut); },[reglages.carbDefaut]);
  const [region, setRegion]         = useState(PREFS.region || "Toutes");
  const [favs, setFavs]             = useState(()=>new Set(Array.isArray(PREFS.favs)?PREFS.favs:[]));
  const [favsSig, setFavsSig] = useState(()=>PREFS.favsSig && typeof PREFS.favsSig==="object" ? PREFS.favsSig : {});
  const [bienvenue, setBienvenue]   = useState(!PREFS.vu);
  const [accueil, setAccueil]       = useState(!PREFS.accueilFait);   // questions du premier démarrage
  const regionRef = useRef(null);
  const navApp = reglages.navApp || (IS_IOS ? "apple" : "google");
  const setNavApp = useCallback(v=>majReglage("navApp",v),[majReglage]);
  const autoGps = reglages.autoGps;
  const [q, setQ]                   = useState("");
  const [tri, setTri]               = useState("prix_asc");
  const [vue, setVue]               = useState(()=>VUES.some(v=>v.key===reglages.vueDefaut) ? reglages.vueDefaut : "liste");
  const [page, setPage]             = useState(1);
  const [selected, setSelected]     = useState(null);
  const [carteFocus, setCarteFocus] = useState(null); // station à centrer sur la carte
  const [epinglee, setEpinglee]     = useState(null); // station ajoutée à la carte si elle est hors de la zone
  const voirSurCarte = useCallback(st=>{ setCarteFocus(st); setEpinglee(st); setVue("carte"); },[]);
  useEffect(()=>{ if (vue!=="carte") setEpinglee(null); },[vue]);
  // Chaque changement d'onglet repart du haut de l'écran
  const premiereVue = useRef(true);
  useEffect(()=>{ if (premiereVue.current) { premiereVue.current=false; return; } window.scrollTo(0,0); },[vue]);
  const [gps, setGps]               = useState(null);
  const [gpsErr, setGpsErr]         = useState(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [rayon, setRayon]           = useState(()=>RAYONS.includes(reglages.rayonDefaut) ? reglages.rayonDefaut : 10);
  const [modeGps, setModeGps]       = useState(false);
  const topRef = useRef(null);
  // Trajet : départ/arrivée ({type:"ville"|"position", nom, lat, lng}), itinéraire calculé
  const [trajet, setTrajet]         = useState({ dep:null, arr:null });
  const [resultat, setResultat]     = useState(null);
  const [calcul, setCalcul]         = useState({ enCours:false });

  // Charger les données : cache local d'abord (affichage instantané), puis réseau
  // Thème
  useEffect(()=>{
    const el = document.documentElement;
    if (reglages.theme==="clair") el.dataset.theme="light"; else if (reglages.theme==="sombre") el.dataset.theme="dark"; else delete el.dataset.theme;
    // Couleur de la barre d'état : suivre le thème choisi dans l'app, pas seulement celui du téléphone
    document.querySelectorAll('meta[name="theme-color"]').forEach(m=>{
      if (!m.dataset.media) m.dataset.media = m.getAttribute("media") || "";
      if (reglages.theme==="auto") m.setAttribute("media", m.dataset.media);
      else { m.removeAttribute("media"); m.setAttribute("content", reglages.theme==="clair" ? "#f8fafc" : "#0f172a"); }
    });
    if (reglages.theme==="auto") document.querySelectorAll('meta[name="theme-color"]').forEach(m=>m.setAttribute("content", /dark/.test(m.dataset.media) ? "#0f172a" : "#f8fafc"));
  },[reglages.theme]);

  // config.json : lien de don + compteur de visites (modifiables sans reconstruire l'app)
  const [config, setConfig] = useState({});
  useEffect(()=>{
    fetch(CONFIG_URL, { cache:"no-cache" }).then(r=>r.ok?r.json():{}).then(c=>{
      const propre = {
        don: lienDonValide(c?.don_url) ? c.don_url : null,
        goat: typeof c?.goatcounter==="string" && /^[a-z0-9-]{2,40}$/.test(c.goatcounter) ? c.goatcounter : null,
      };
      setConfig(propre);
    }).catch(()=>{});
  },[]);
  const visiteComptee = useRef(false);
  useEffect(()=>{
    if (config.goat && reglages.stats && !visiteComptee.current) { visiteComptee.current = true; compterVisite(config.goat); }
  },[config.goat, reglages.stats]);

  const dernierTs = useRef(null);
  const charger = useCallback(async ()=>{
    setRefreshing(true);
    try {
      const r = await fetch(DATA_URL, { cache:"no-cache" });
      if (!r.ok) throw new Error("HTTP "+r.status);
      const json = await r.json();
      // Mêmes données qu'à l'écran (même horodatage) : rien à recalculer ni à redessiner
      if (json?.ts && json.ts===dernierTs.current) { setLoadErr(null); return; }
      const { stations:st, ts } = parseData(json);
      dernierTs.current = json.ts;
      setStations(st); setDataTs(ts); setLoadErr(null); setReady(true);
      ecrireCache(json);
    } catch (e) {
      setLoadErr("Impossible de récupérer les derniers prix. Vérifie ta connexion.");
    } finally {
      setRefreshing(false);
    }
  },[]);

  useEffect(()=>{
    const cache = lireCache();
    if (cache) {
      try { const { stations:st, ts } = parseData(cache); setStations(st); setDataTs(ts); setReady(true); dernierTs.current = cache.ts; } catch { /* cache corrompu : ignoré */ }
    }
    charger();
    const t = setInterval(()=>{ if (document.visibilityState==="visible") charger(); }, REFRESH_MS);
    const onVis = ()=>{ if (document.visibilityState==="visible") charger(); };
    document.addEventListener("visibilitychange", onVis);
    return ()=>{ clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  },[charger]);
  useEffect(()=>{ setPage(1); },[carb,region,q,tri,modeGps,rayon,gps]);

  // Mémoriser les réglages sur l'appareil
  // Derniers trajets : seulement les noms de villes (jamais la position GPS)
  const trajetMemo = useMemo(()=>({ dep: trajet.dep?.type==="ville" ? trajet.dep.cle : trajet.dep?.type==="position" ? "@position" : null,
    arr: trajet.arr?.type==="ville" ? trajet.arr.cle : null }),[trajet]);
  useEffect(()=>{
    ecrirePrefs({ reglages, region, favs:[...favs], favsSig, vu: !bienvenue, accueilFait: !accueil, trajet: trajetMemo });
  },[reglages, region, favs, favsSig, bienvenue, accueil, trajetMemo]);
  useEffect(()=>{ if (modeGps || region!=="Toutes") setBienvenue(false); },[modeGps, region]);

  // Favoris robustes : l'identifiant d'une station change si la Régie corrige son adresse ou ses coordonnées.
  // On garde aussi « bannière|adresse » pour retrouver la station, et on ne perd pas un favori absent d'un export.
  useEffect(()=>{
    if (!stations.length) return;
    const parId = new Map(stations.map(s=>[s.id,s]));
    const sigDe = s => sansAccent(s.banniere+"|"+s.adresse);
    let parSig = null, migre = false;
    const nf = new Set(), ns = {};
    for (const id of favs) {
      const s = parId.get(id);
      if (s) { nf.add(id); ns[id] = sigDe(s); continue; }
      const sig = favsSig[id];
      if (sig) {
        parSig ??= new Map(stations.map(x=>[sigDe(x),x]));
        const t = parSig.get(sig);
        if (t) { nf.add(t.id); ns[t.id] = sig; migre = true; continue; }
        ns[id] = sig;
      }
      nf.add(id);
    }
    if (migre) setFavs(nf);
    if (JSON.stringify(ns)!==JSON.stringify(favsSig)) setFavsSig(ns);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stations, favs]);

  const toggleFav = useCallback(id=>{
    setFavs(prev=>{ const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  },[]);

  const requestGps = useCallback(()=>{
    if (!navigator.geolocation) { setGpsErr({type:"unsupported"}); return; }
    setGpsLoading(true); setGpsErr(null);
    navigator.geolocation.getCurrentPosition(
      pos=>{ setGps({lat:pos.coords.latitude,lng:pos.coords.longitude,t:Date.now()}); setModeGps(true); setTri("distance"); setGpsLoading(false); },
      err=>{ setGpsErr({type: err.code===1?"denied": err.code===3?"timeout":"unavailable"}); setGpsLoading(false); },
      {enableHighAccuracy:true,timeout:12000,maximumAge:60000}
    );
  },[]);

  // Réglage « Me localiser à l'ouverture » : seulement si la permission est déjà accordée (pas de demande surprise)
  useEffect(()=>{
    if (!autoGps || !navigator.permissions?.query) return;
    navigator.permissions.query({name:"geolocation"}).then(r=>{ if (r.state==="granted") requestGps(); }).catch(()=>{});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const disableGps = ()=>{ setModeGps(false); setTri("prix_asc"); };

  // ── Trajet ──
  const villes = useMemo(()=>villesDepuisStations(stations),[stations]);
  // Remettre le dernier trajet (villes seulement) une fois les villes connues
  const trajetRestaure = useRef(false);
  useEffect(()=>{
    if (trajetRestaure.current || !villes.length) return;
    trajetRestaure.current = true;
    const t = PREFS.trajet || {};
    const ville = cle => { const v = typeof cle==="string" && villes.find(x=>x.cle===cle); return v ? { type:"ville", nom:v.nom, cle:v.cle, lat:v.lat, lng:v.lng } : null; };
    setTrajet({ dep: ville(t.dep), arr: ville(t.arr) });
  },[villes]);
  const positionTrajet = useCallback(()=>new Promise((ok, ko)=>{
    if (gps && Date.now()-(gps.t||0) < 120000) return ok(gps);   // position de moins de 2 min : réutilisée
    if (!navigator.geolocation) return ko({type:"unsupported"});
    navigator.geolocation.getCurrentPosition(
      p=>{ const g = { lat:p.coords.latitude, lng:p.coords.longitude, t:Date.now() }; setGps(g); ok(g); },
      e=>ko({ type: e.code===1?"denied": e.code===3?"timeout":"unavailable" }),
      { enableHighAccuracy:false, timeout:12000, maximumAge:120000 });
  }),[gps]);
  const calculerTrajet = useCallback(async ()=>{
    const { dep, arr } = trajet;
    if (!dep || !arr) return;
    setCalcul({ enCours:true });
    let r;
    try { r = await itineraireOSRM(dep, arr); }
    catch {
      // Repli : ligne droite, par le pont le plus court si le départ et l'arrivée ne sont pas sur la même rive
      const rd = riveUtilisateur(stations, dep.lat, dep.lng);
      const pont = rd ? distanceRoute(dep, rd, { lat:arr.lat, lng:arr.lng, rive: riveUtilisateur(stations, arr.lat, arr.lng) }).pont : null;
      r = itineraireEstime(dep, arr, PONTS.find(p=>p.nom===pont));
    }
    setResultat({ ...r, depNom: dep.nom, arrNom: arr.nom, dep, arr });
    setCalcul({ enCours:false });
  },[trajet, stations]);
  const candsTrajet = useMemo(()=>{
    if (!resultat) return [];
    const f = resultat.km / (longueurTrace(resultat.pts) || resultat.km || 1);   // ≈ 1 avec OSRM, ≈ 1,25 en ligne droite
    return corridor(stations.filter(compte), resultat.pts, reglages.detourMax).map(s=>({ ...s, kmTrajet: s.kmTrajet*f }));
  },[stations, resultat, reglages.detourMax, compte]);
  const rangeTrajet = useMemo(()=>{
    const r={}; CARBURANTS.forEach(c=>{ r[c.key]=rangeOf(candsTrajet.filter(compte).map(s=>s[c.key])); }); return r;
  },[candsTrajet,compte]);

  const REGIONS = useMemo(()=>["Toutes",...new Set(stations.map(s=>s.region).filter(Boolean).sort())],[stations]);

  const maRive = useMemo(()=>gps ? riveUtilisateur(stations, gps.lat, gps.lng) : null,[stations,gps]);
  const stationsWithDist = useMemo(()=>{
    if (!gps) return stations;   // distance affichée dès que la position est connue, même hors « Autour de moi »
    return stations.map(s=>{ const r=distanceRoute(gps, maRive, s); return {...s, dist:r.dist, pont:r.pont}; });
  },[stations,gps,maRive]);

  // Zone = rayon GPS ou région (sans Costco si non-membre). Sert de base aux couleurs, à la liste et à la carte
  // (indépendante de la recherche et du tri, pour que les couleurs ne bougent pas en tapant).
  const zone = useMemo(()=>{
    const vis = stationsWithDist.filter(compte);
    if (modeGps&&gps) return vis.filter(st=>st.dist!=null&&st.dist<=rayon);
    if (region!=="Toutes") return vis.filter(st=>st.region===region);
    return vis;
  },[stationsWithDist,modeGps,gps,rayon,region,compte]);

  const filtered = useMemo(()=>{
    let s=zone.filter(st=>st[carb]!=null);
    if (q.trim()) { const mots=sansAccent(q).split(/\s+/).filter(Boolean); s=s.filter(st=>mots.every(m=>st.cle.includes(m))); }
    if (tri==="prix_asc")  return [...s].sort((a,b)=>a[carb]-b[carb]);
    if (tri==="prix_desc") return [...s].sort((a,b)=>b[carb]-a[carb]);
    if (tri==="nom")       return [...s].sort((a,b)=>a.banniere.localeCompare(b.banniere));
    if (tri==="region")    return [...s].sort((a,b)=>a.region.localeCompare(b.region));
    if (tri==="distance")  return [...s].sort((a,b)=>(a.dist??999)-(b.dist??999));
    return s;
  },[zone,carb,q,tri]);

  const prices  = filtered.filter(compte).map(s=>s[carb]).filter(v=>v!=null);
  const minP    = prices.length?Math.min(...prices):null;
  const maxP    = prices.length?Math.max(...prices):null;
  const avgP    = prices.length?prices.reduce((a,b)=>a+b,0)/prices.length:null;

  const priceRange = useMemo(()=>{
    const result = {};
    CARBURANTS.forEach(c=>{ result[c.key] = rangeOf(zone.filter(compte).map(s=>s[c.key])); });
    return result;
  },[zone,compte]);

  // Zone de comparaison affichée sur l'étiquette : le rayon autour de toi est le plus représentatif
  const etiquetteZone = modeGps&&gps ? "Le moins cher à "+rayon+NBSP+"km de toi"
    : region==="Toutes" ? "Le moins cher au Québec" : "Le moins cher · "+region;
  const maj     = dataTs ? fmtMaj(dataTs) : null;
  const cInfo   = CARBURANTS.find(c=>c.key===carb);
  const totPg   = Math.ceil(filtered.length/PG);
  const paged   = filtered.slice((page-1)*PG,page*PG);
  const sansCe  = zone.filter(s=>s[carb]==null).length;
  const scroll  = ()=>topRef.current?.scrollIntoView({behavior:"smooth"});

  // Stations pour la carte = la zone courante (rayon GPS ou région)
  // Favoris : couleurs calculées sur tout le Québec (ils peuvent être hors de la zone)
  const rangeQuebec = useMemo(()=>{
    const r={}; CARBURANTS.forEach(c=>{ r[c.key]=rangeOf(stations.filter(compte).map(s=>s[c.key])); }); return r;
  },[stations,compte]);
  const favStations = useMemo(()=>stationsWithDist.filter(s=>favs.has(s.id))
    .sort((a,b)=>(a[carb]??9999)-(b[carb]??9999)),[stationsWithDist,favs,carb]);

  const favsAbsents = useMemo(()=>{ if (!stations.length) return []; const ids=new Set(stations.map(s=>s.id)); return [...favs].filter(id=>!ids.has(id)); },[stations,favs]);

  // Carte = zone courante, plus la station à centrer si elle est hors de la zone (ex. un favori dans une autre région)
  const stationsCarte = useMemo(()=>{
    const z = zone.filter(s=>s[carb]!=null);
    if (epinglee && !z.some(s=>s.id===epinglee.id)) { const f = stationsWithDist.find(s=>s.id===epinglee.id); if (f && f[carb]!=null) return [...z, f]; }
    return z;
  },[zone,carb,epinglee,stationsWithDist]);

  if (!ready) return (
    <div style={{minHeight:"100vh",background:"var(--bg-grad)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,color:"var(--t3)"}}>
      <span style={{fontSize:40}}>{"⛽"}</span>
      {loadErr ? (
        <>
          <div style={{textAlign:"center",padding:"0 32px",color:"var(--t2)"}}>{loadErr}</div>
          <button className="tab" onClick={charger} style={{padding:"10px 18px",borderRadius:12,background:"var(--accent)",color:ON_COLOR,fontWeight:700,fontSize:14}}>Réessayer</button>
        </>
      ) : <div>Chargement des stations…</div>}
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:"var(--bg-grad)",fontFamily:POLICE,color:"var(--t1)",maxWidth:480,margin:"0 auto"}}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 2px; }
        .tab { transition: all 0.2s; cursor: pointer; border: none; font-family: inherit; }
        select, input { -webkit-appearance: none; }
        @keyframes fadeUp { from{transform:translateY(12px);opacity:0} to{transform:translateY(0);opacity:1} }
        @keyframes sheetUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        .pulse { animation: spin 1s linear infinite; display:inline-block; }
        .card:active { transform: scale(0.98); }
        .card:focus-visible, .tab:focus-visible, a:focus-visible, button:focus-visible { outline: 2px solid var(--t1); outline-offset: 2px; }
        .leaflet-container { background: var(--bg) !important; }
        .leaflet-control-attribution { font-size: 9px !important; line-height: 1.3 !important; max-width: 70%; }
      `}</style>

      {/* Header */}
      <div style={{padding:"calc(env(safe-area-inset-top) + 14px) 20px 12px",borderBottom:"1px solid rgba(var(--ov),0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22}}>{"⛽"}</span>
          <div style={{flex:1}}>
            <h1 style={{fontSize:20,fontWeight:700,letterSpacing:-0.5,margin:0}}>{APP_NAME}</h1>
            <div style={{fontSize:12,color:"var(--t2)"}}>Prix de l'essence au Québec</div>
            <button onClick={charger} disabled={refreshing} aria-label="Actualiser les prix" style={{background:"none",border:"none",padding:0,fontFamily:"inherit",fontSize:11,color:"var(--t3)",cursor:"pointer",display:"flex",alignItems:"center",gap:4,textAlign:"left"}}>
              <span>Source : Régie essence Québec{maj&&!maj.stale ? " · "+maj.rel : ""}</span>
              <span className={refreshing?"pulse":""} aria-hidden="true">{"⟳"}</span>
            </button>
          </div>
          <button className="tab" onClick={modeGps?disableGps:requestGps} aria-label={modeGps?"Arrêter la recherche autour de moi":"Chercher les stations autour de moi"} style={{padding:"8px 12px",borderRadius:12,fontSize:12,fontWeight:600,background:modeGps?"var(--accent)":"rgba(var(--ov),0.08)",color:modeGps?ON_COLOR:"var(--t3)",border:modeGps?"none":"1px solid rgba(var(--ov),0.1)",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
            {gpsLoading?<span className="pulse">{"⟳"}</span>:<span>{modeGps?"📍":"🔍"}</span>}
            {modeGps?"Autour de moi ✕":"Me localiser"}
          </button>
        </div>
        {loadErr && (
          <div role="status" style={{marginTop:10,padding:"8px 12px",background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,fontSize:12,color:"var(--err-t)"}}>
            {loadErr} Affichage des derniers prix enregistrés.
          </div>
        )}
        {maj?.stale && (
          <div role="status" style={{marginTop:10,padding:"8px 12px",background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.35)",borderRadius:10,fontSize:12,color:"var(--warn-t)"}}>
            Prix du {maj.local} : ils ont peut-être changé depuis.
          </div>
        )}
        {gpsErr && <GpsAide err={gpsErr} onRetry={requestGps} onClose={()=>setGpsErr(null)} />}
        {modeGps&&gps && (vue==="liste"||vue==="carte") && (
          <div style={{marginTop:10}}>
          <div id="rayon-titre" style={{fontSize:12,color:"var(--t3)",marginBottom:5}}>Stations à moins de… de toi (distance en voiture)</div>
          <div role="group" aria-labelledby="rayon-titre" style={{display:"flex",alignItems:"center",gap:6}}>
            {RAYONS.map(r=>(
              <button key={r} className="tab" aria-pressed={rayon===r} onClick={()=>setRayon(r)} style={{flex:1,padding:"5px 0",borderRadius:8,fontSize:12,fontWeight:600,background:rayon===r?"var(--accent)":"rgba(var(--ov),0.06)",color:rayon===r?ON_COLOR:"var(--t2)",border:rayon===r?"none":"1px solid rgba(var(--ov),0.08)"}}>{r}{NBSP}km</button>
            ))}
          </div>
          </div>
        )}
      </div>


      {/* Tabs carburant */}
      {vue!=="reglages" && <div style={{padding:"14px 20px 0",display:"flex",gap:8}}>
        {CARBURANTS.map(c=>{
          const carbVue = vue==="trajet" ? carbTrajet : carb;
          const isActive = carbVue===c.key;
          const cMin  = (vue==="trajet" ? (resultat ? rangeTrajet : null) : priceRange)?.[c.key]?.min;
          return (
            <button key={c.key} className="tab" aria-pressed={isActive} onClick={()=>(vue==="trajet"?setCarbTrajet:setCarb)(c.key)} style={{flex:1,padding:"8px 0 7px",borderRadius:12,fontSize:13,fontWeight:700,background:isActive?"var(--accent)":"rgba(var(--ov),0.04)",color:isActive?ON_COLOR:"var(--t3)",border:isActive?"1px solid var(--accent)":"1px solid rgba(var(--ov),0.08)",display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
              <span>{isActive?"✓ ":""}{c.label}</span>
              {cMin && <span style={{fontSize:11,fontWeight:isActive?600:400,color:isActive?ON_COLOR:"var(--t3)",opacity:isActive?0.9:1,fontFamily:POLICE_MONO}}>dès {dec(cMin)}{NBSP}¢</span>}
            </button>
          );
        })}
      </div>}

      {/* Contenu principal — padding bas pour la nav bar */}
      <div style={{paddingBottom:80}}>

      {/* VUE CARTE */}
      {vue==="carte" && (
        <div style={{padding:"14px 20px 0"}}>
          {!leafletReady ? (
            <div style={{height:"50vh",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--t3)",fontSize:14}}>
              <span className="pulse" style={{marginRight:8}}>{"⟳"}</span> Chargement de la carte…
            </div>
          ) : (
            <CarteView
              stations={stationsCarte}
              carb={carb}
              gps={gps}
              minP={minP} maxP={maxP}
              priceRange={priceRange}
              focusStation={carteFocus}
              onFocusDone={()=>setCarteFocus(null)}
              onSelectStation={s=>setSelected(s)}
              cadrer={!modeGps && region!=="Toutes"}
            />
          )}
        </div>
      )}

      {/* VUE TRAJET */}
      {vue==="trajet" && (
        <TrajetVue villes={villes} trajet={trajet} setTrajet={setTrajet} resultat={resultat} calcul={calcul} onCalculer={calculerTrajet}
          cands={candsTrajet} range={rangeTrajet[carbTrajet]} carb={carbTrajet} cInfo={CARBURANTS.find(c=>c.key===carbTrajet)} reglages={reglages} majReglage={majReglage}
          favs={favs} toggleFav={toggleFav} onSelect={setSelected} navApp={navApp}
          carteFocus={carteFocus} setCarteFocus={setCarteFocus} onPosition={positionTrajet} compte={compte} />
      )}

      {/* VUE RÉGLAGES */}
      {vue==="reglages" && (
        <Reglages reglages={reglages} maj={majReglage} nbFavs={favs.size}
          onEffacerFavs={()=>{ if (window.confirm("Effacer tes "+favs.size+" station(s) favorite(s) ?")) setFavs(new Set()); }}
          onReinitialiser={()=>{ if (window.confirm("Remettre tous les réglages par défaut ? (tes favoris sont conservés)")) setReglages(r=>({...REGLAGES_DEFAUT, stats:r.stats})); }}
          dataTs={dataTs} nbStations={stations.length} donUrl={config.don} statsDispo={!!config.goat} />
      )}

      {/* VUE FAVORIS */}
      {vue==="favoris" && (
        <div style={{padding:"16px 20px"}}>
          <div style={{fontSize:12,fontWeight:600,color:"var(--t3)",marginBottom:14,textTransform:"uppercase",letterSpacing:1}}>
            Mes stations · {cInfo.label}
          </div>
          {favsAbsents.length>0 && (
            <div role="status" style={{marginBottom:12,padding:"10px 12px",borderRadius:12,background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.35)",fontSize:12,color:"var(--warn-t)",lineHeight:1.5}}>
              {favsAbsents.length===1 ? "1 station favorite n'apparaît plus" : favsAbsents.length+" stations favorites n'apparaissent plus"} dans les données de la Régie (fermée, ou temporairement absente).{" "}
              <button onClick={()=>setFavs(prev=>{ const n=new Set(prev); favsAbsents.forEach(id=>n.delete(id)); return n; })}
                style={{background:"none",border:"none",padding:0,color:"var(--warn-t)",textDecoration:"underline",cursor:"pointer",fontFamily:"inherit",fontSize:12}}>Retirer</button>
            </div>
          )}
          {favStations.length===0 ? (
            <div style={{textAlign:"center",padding:"40px 20px",color:"var(--t3)",fontSize:14,lineHeight:1.6}}>
              <div style={{fontSize:32,marginBottom:8}}>♡</div>
              Aucune station favorite pour l'instant.<br/>Touche ♡ sur une station pour la retrouver ici.
            </div>
          ) : favStations.map((s,i)=>(
            <StationCard key={s.id} s={s} carb={carb} range={rangeQuebec[carb]} best={favStations.length>1&&s.id===favStations.find(f=>f[carb]!=null&&compte(f))?.id} bestLabel="Le moins cher de tes favoris"
              showDist={!!gps} showRegion fav onToggleFav={toggleFav}
              onSelect={setSelected} onCarte={voirSurCarte} navApp={navApp} />
          ))}
        </div>
      )}

      {/* VUE LISTE */}
      {vue==="liste" && (
        <div style={{padding:"14px 20px"}} ref={topRef}>
          {bienvenue && !modeGps && (
            <div style={{marginBottom:14,padding:"14px 16px",borderRadius:16,background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.3)"}}>
              <div style={{fontSize:15,fontWeight:700,marginBottom:4}}>Bienvenue sur {APP_NAME} 👋</div>
              <div style={{fontSize:13,color:"var(--t2)",lineHeight:1.5,marginBottom:12}}>Pour voir les prix près de chez toi, localise-toi ou choisis ta région.</div>
              <div style={{display:"flex",gap:8}}>
                <button className="tab" onClick={requestGps} style={{flex:1,padding:"10px",borderRadius:12,background:"var(--accent)",color:ON_COLOR,fontSize:13,fontWeight:700}}>📍 Me localiser</button>
                <button className="tab" onClick={()=>{ regionRef.current?.focus(); regionRef.current?.scrollIntoView({block:"center",behavior:"smooth"}); }} style={{flex:1,padding:"10px",borderRadius:12,background:"rgba(var(--ov),0.08)",color:"var(--t1)",fontSize:13,fontWeight:600,border:"1px solid rgba(var(--ov),0.12)"}}>Choisir ma région</button>
              </div>
              <button onClick={()=>setBienvenue(false)} style={{marginTop:8,background:"none",border:"none",color:"var(--t3)",fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:0,textDecoration:"underline"}}>Plus tard</button>
            </div>
          )}
          {filtered.length>0 && (
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              {[{label:"Le plus bas",val:fmt(minP),color:"var(--accent)"},{label:"Moyenne",val:avgP!=null?fmt(avgP):null,color:"var(--mid)"},{label:"Le plus haut",val:fmt(maxP),color:"var(--high)"}].map(item=>(
                <div key={item.label} style={{flex:1,background:"rgba(var(--ov),0.04)",borderRadius:12,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(var(--ov),0.06)"}}>
                  <div style={{fontSize:11,color:"var(--t3)",marginBottom:2}}>{item.label}</div>
                  <div style={{fontFamily:POLICE_MONO,fontSize:16,fontWeight:500,color:item.color}}>{item.val??"—"}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{position:"relative",marginBottom:10}}>
            <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--t3)"}}>{"🔍"}</span>
            {q && <button onClick={()=>setQ("")} aria-label="Effacer la recherche" style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",width:28,height:28,borderRadius:"50%",border:"none",background:"rgba(var(--ov),0.12)",color:"var(--t2)",fontSize:14,cursor:"pointer",zIndex:1}}>✕</button>}
            <input value={q} aria-label="Rechercher une station" onChange={e=>setQ(e.target.value)} placeholder="Chercher : Shell, rue, ville, code postal…" style={{width:"100%",background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.1)",borderRadius:12,padding:"10px 12px 10px 36px",color:"var(--t1)",fontSize:14,fontFamily:"inherit",outline:"none"}} />
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            {!modeGps && (
              <label style={{flex:1,display:"flex",flexDirection:"column",gap:4,minWidth:0}}>
                <span style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Région</span>
                <select ref={regionRef} value={region} onChange={e=>setRegion(e.target.value)} style={{width:"100%",background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.1)",borderRadius:10,padding:"9px 10px",color:"var(--t1)",fontSize:13,fontFamily:"inherit",outline:"none"}}>
                  {REGIONS.map(r=><option key={r} value={r} style={{background:"var(--surface)"}}>{r==="Toutes"?"Tout le Québec":r}</option>)}
                </select>
              </label>
            )}
            <label style={{flex:1,display:"flex",flexDirection:"column",gap:4,minWidth:0}}>
              <span style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Trier par</span>
              <select value={tri} onChange={e=>setTri(e.target.value)} style={{width:"100%",background:"rgba(var(--ov),0.06)",border:"1px solid rgba(var(--ov),0.1)",borderRadius:10,padding:"9px 10px",color:"var(--t1)",fontSize:13,fontFamily:"inherit",outline:"none"}}>
                {Object.entries(TRIS).filter(([k])=>(gps || k!=="distance") && (!modeGps || k!=="region")).map(([k,l])=>(
                  <option key={k} value={k} style={{background:"var(--surface)"}}>{l}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{fontSize:11,color:"var(--t3)",marginBottom:10,display:"flex",justifyContent:"space-between"}}>
            <span>{filtered.length.toLocaleString("fr-CA")} station{filtered.length>1?"s":""}{modeGps?" dans "+rayon+" km":""}</span>
            {sansCe>0 && <span>{sansCe} sans {cInfo.label.toLowerCase()}</span>}
          </div>
          {filtered.length>0 && (priceRange[carb]?.n??0)<MIN_COMPARAISON && (
            <div style={{fontSize:12,color:"var(--t3)",marginBottom:10,padding:"8px 12px",borderRadius:10,background:"rgba(var(--ov),0.04)"}}>
              Trop peu de stations pour comparer les prix : {modeGps?"augmente la distance de recherche.":"choisis une zone plus grande."}
            </div>
          )}
          {filtered.length===0 && <div style={{textAlign:"center",padding:"40px 20px",color:"var(--t3)",fontSize:14}}>{modeGps?"Aucune station dans un rayon de "+rayon+" km":"Aucune station trouvée"}</div>}
          {paged.map(s=>(
            <StationCard key={s.id} s={s} carb={carb} range={priceRange?.[carb]} best={s[carb]!=null&&compte(s)&&s[carb]===priceRange?.[carb]?.min} bestLabel={etiquetteZone}
              showDist={!!gps} showRegion={!modeGps} fav={favs.has(s.id)} onToggleFav={toggleFav}
              onSelect={setSelected} onCarte={voirSurCarte} navApp={navApp} />
          ))}
          {totPg>1 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"16px 0"}}>
              <button className="tab" onClick={()=>{setPage(p=>Math.max(1,p-1));scroll();}} disabled={page===1} style={{padding:"8px 16px",borderRadius:10,background:page===1?"rgba(var(--ov),0.03)":"rgba(var(--ov),0.1)",color:page===1?"var(--t3)":"var(--t3)",fontSize:13}}>{"←"} Précédente</button>
              <span style={{fontSize:12,color:"var(--t3)"}}>Page {page} sur {totPg}</span>
              <button className="tab" onClick={()=>{setPage(p=>Math.min(totPg,p+1));scroll();}} disabled={page===totPg} style={{padding:"8px 16px",borderRadius:10,background:page===totPg?"rgba(var(--ov),0.03)":"rgba(var(--ov),0.1)",color:page===totPg?"var(--t3)":"var(--t3)",fontSize:13}}>Suivante {"→"}</button>
            </div>
          )}
          <div style={{padding:"4px 0 36px",fontSize:11,color:"var(--t3)",textAlign:"center",lineHeight:1.6}}>
            {config.don && <><a href={config.don} target="_blank" rel="noreferrer" style={{color:"var(--t2)"}}>☕ Soutenir {APP_NAME}</a><br/></>}
            Source des prix : {SOURCE_NOM} (regieessencequebec.ca).<br/>{APP_NAME} est une application indépendante, non affiliée à la Régie.
          </div>
        </div>
      )}

      {accueil && <Accueil reglages={reglages} maj={majReglage} onFin={()=>{ setAccueil(false); if (CARBURANTS.some(c=>c.key===reglages.carbDefaut)) setCarb(reglages.carbDefaut); }} />}

      {selected && <StationSheet station={vue==="trajet" ? selected : (stationsWithDist.find(x=>x.id===selected.id) ?? selected)} carb={vue==="trajet"?carbTrajet:carb} gps={vue==="trajet"?null:gps} onLocaliser={positionTrajet}
        priceRange={vue==="trajet"?rangeTrajet:favs.has(selected.id)&&vue==="favoris"?rangeQuebec:priceRange} onClose={()=>setSelected(null)}
        onVoirCarte={s=>{ if (vue==="trajet") setCarteFocus(s); else voirSurCarte(s); }}
        fav={favs.has(selected.id)} onToggleFav={toggleFav} navApp={navApp} onNavApp={setNavApp} plein={reglages.plein} conso={reglages.conso}
        trajetNav={vue==="trajet"&&resultat ? { dep:resultat.dep, arr:resultat.arr } : null} />}

      </div>{/* fin wrapper paddingBottom */}

      {/* Barre de navigation fixe en bas */}
      <div id="barre-nav" style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,zIndex:1200,background:"var(--nav-bg)",borderTop:"1px solid rgba(var(--ov),0.08)",backdropFilter:"blur(12px)",padding:"8px 6px calc(12px + env(safe-area-inset-bottom))",display:"flex",gap:4}}>
        {[
          ...VUES.map(x=>({v:x.key, icon:x.icon, label:x.label, badge:x.key==="favoris"&&favStations.length ? favStations.length : null})),
          {v:"reglages", icon:"⚙", label:"Réglages"},
        ].map(({v,icon,label,badge})=>(
          <button key={v} className="tab" aria-current={vue===v?"page":undefined} aria-label={badge ? label+" ("+badge+")" : undefined} onClick={()=>setVue(v)} style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"8px 2px",borderRadius:12,background:vue===v?"rgba(var(--ov),0.1)":"transparent",color:vue===v?"var(--accent)":"var(--t3)"}}>
            <span style={{position:"relative",fontSize:20,lineHeight:1}}>
              <span style={{filter:vue===v?"none":"opacity(0.5)"}}>{icon}</span>
              {badge && <span aria-hidden="true" style={{position:"absolute",top:-6,right:-12,minWidth:16,height:16,padding:"0 4px",borderRadius:8,background:"var(--high)",color:"#fff",fontSize:10,fontWeight:700,lineHeight:"16px",textAlign:"center"}}>{badge}</span>}
            </span>
            <span style={{fontSize:11,fontWeight:vue===v?700:400,letterSpacing:0.2,whiteSpace:"nowrap"}}>{label}</span>
            <div style={{width:20,height:3,borderRadius:2,background:vue===v?"var(--accent)":"transparent",marginTop:1}} />
          </button>
        ))}
      </div>
    </div>
  );
}
