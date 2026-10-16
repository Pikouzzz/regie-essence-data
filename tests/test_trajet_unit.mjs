import * as T from '../src/trajet.js';
import fs from 'fs';
let ok=0, ko=0; const v=(c,m)=>{ if(c){ok++;console.log('  ✔',m);} else {ko++;console.log('  ✘',m);} };
// Polyline : exemple officiel Google « _p~iF~ps|U_ulLnnqC_mqNvxq`@ » → (38.5,-120.2),(40.7,-120.95),(43.252,-126.453)
const p = T.decoderPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
v(JSON.stringify(p)==='[[38.5,-120.2],[40.7,-120.95],[43.252,-126.453]]', 'décodage polyline (exemple de référence Google)');
let err=false; try { T.decoderPolyline('_p~iF~ps|U_'); } catch { err=true; } v(err,'polyline tronquée → erreur');
v(JSON.stringify(T.arrondir({lat:46.12345,lng:-72.98765}))==='{"lat":46.12,"lng":-72.99}','arrondi ≈ 1 km');

// Villes à partir des stations (adresse déjà « jolie » dans l'app : on simule)
const J = JSON.parse(fs.readFileSync(new URL('./stations-test.json', import.meta.url),'utf8'));
const f = Object.fromEntries(J.fields.map((k,i)=>[k,i]));
const st = J.stations.map(r=>({id:r[f.id],adresse:r[f.adresse],region:r[f.region],lat:r[f.lat],lng:r[f.lng],rive:r[f.rive],regulier:r[f.regulier],super:r[f.super],diesel:r[f.diesel]}));
const villes = T.villesDepuisStations(st);
console.log('   villes trouvées :', villes.length);
const q = n => T.chercherVilles(villes, n).map(x=>x.nom);
v(q('levis')[0]?.toLowerCase()==='lévis', '« levis » → Lévis : '+q('levis')[0]);
v(q('trois riv')[0]?.toLowerCase()==='trois-rivières', '« trois riv » → Trois-Rivières');
v(q('st-jean').length===0 || true, '« st-jean » ne plante pas');
v(q('jean')[0]?.toLowerCase().includes('jean'), '« jean » → '+q('jean')[0]);
v(q('').length===0 && q('zzzz').length===0, 'vide / inconnu → aucune suggestion');
v(q('montreal')[0]?.toLowerCase()==='montréal', 'sans accent → Montréal');
const mtl = villes.find(x=>x.cle==='montreal');
v(mtl && Math.abs(mtl.lat-45.508)<0.05 && Math.abs(mtl.lng+73.587)<0.05, 'centre de Montréal plausible');

// Corridor : tracé simulé Drummondville → Lévis le long de l'A-20 (ligne brisée)
const pts = [[45.883,-72.484],[46.02,-72.06],[46.25,-71.95],[46.53,-71.63],[46.70,-71.39]];
const t0=Date.now(); const c3 = T.corridor(st, pts, 3); const dt=Date.now()-t0;
console.log('   corridor 3 km :', c3.length, 'stations en', dt, 'ms');
v(c3.some(s=>s.id==='pascher'), 'la station pas chère au bord de l\'A-20 est trouvée');
v(c3.every(s=>s.ecart<=3), 'toutes à ≤ 3 km');
v(!c3.some(s=>s.id.startsWith('t') && /SHERBROOKE|Sherbrooke/.test(s.adresse)), 'aucune station de Sherbrooke');
const c1 = T.corridor(st, pts, 1), c5 = T.corridor(st, pts, 5);
v(c1.length<=c3.length && c3.length<=c5.length, `1 km (${c1.length}) ≤ 3 km (${c3.length}) ≤ 5 km (${c5.length})`);
const ps = c3.find(s=>s.id==='pascher');
v(ps && ps.kmTrajet>30 && ps.kmTrajet<45, 'position sur le trajet ≈ km '+(ps?.kmTrajet.toFixed(1)));
v(ps && Math.abs(ps.detour-2*ps.ecart*1.25)<1e-9, 'détour = 2 × écart × 1,25');
// Meilleur choix : coût du plein détour compris
const best = T.meilleurChoix(c3,'regulier',50,8.5);
v(best?.id==='pascher', 'meilleur choix = station pas chère ('+best?.id+')');
// Une station à 169,9 ¢ mais à 4 km de la route : détour 10 km ≈ 1,44 $ ; économie vs 183 ¢ ≈ 6,55 $ → reste meilleure
const loin = {id:'loin',lat:46.02,lng:-72.06+4.2/77.3,regulier:160.0,rive:'S'};
const cL = T.corridor([...st, loin], pts, 5); const bL = T.meilleurChoix(cL,'regulier',50,8.5);
v(bL?.id==='loin', 'station à ~4 km mais 10 ¢ moins chère : choisie (détour rentable)');
// Petit plein : le détour ne vaut plus la peine si l'écart de prix est faible
const loin2 = {id:'loin2',lat:46.02,lng:-72.06+4.2/77.3,regulier:169.0,rive:'S'};
const b2 = T.meilleurChoix(T.corridor([...st, loin2], pts, 5),'regulier',10,8.5);
v(b2?.id==='pascher', 'plein de 10 L : la station à 4 km et 0,9 ¢ moins chère n\'est pas choisie');

// Autre rive : tracé le long du fleuve rive sud (Bécancour → Lévis), station rive nord à ~2 km
const sud = [];
for (let k=0;k<=30;k++){ sud.push([46.34+0.012*k*0.4, -72.43+0.035*k*0.4]); }
const fake = [];
for (let k=0;k<12;k++) fake.push({id:'s'+k, lat:sud[k*2][0]-0.004, lng:sud[k*2][1], rive:'S', regulier:185});
const nord = {id:'nord', lat:sud[10][0]+0.02, lng:sud[10][1], rive:'N', regulier:150};
const cr = T.corridor([...fake, nord], sud, 3);
v(!cr.some(s=>s.id==='nord'), 'station sur l\'autre rive à ~2 km : écartée');
v(cr.filter(s=>s.id.startsWith('s')).length===12, 'stations de la bonne rive : gardées');

const encoder = pts => { let o='',pl=0,pg=0; const e=v=>{ v=v<0?~(v<<1):(v<<1); let r=''; while(v>=0x20){ r+=String.fromCharCode((0x20|(v&0x1f))+63); v>>=5;} return r+String.fromCharCode(v+63); };
  for (const [a,b] of pts){ const la=Math.round(a*1e5), lo=Math.round(b*1e5); o+=e(la-pl)+e(lo-pg); pl=la; pg=lo; } return o; };
const QC = encoder([[45.883,-72.484],[46.02,-72.06],[46.70,-71.39]]);
v(JSON.stringify(T.decoderPolyline(QC))==='[[45.883,-72.484],[46.02,-72.06],[46.7,-71.39]]','aller-retour encodage/décodage Québec');
// OSRM simulé : réponse OK, erreurs, limite 1 req/s, cache
const rep = (o, status=200) => async () => ({ ok: status===200, status, json: async()=>o });
const r1 = await T.itineraireOSRM({lat:45.88,lng:-72.48},{lat:46.70,lng:-71.39},{fetchFn: rep({code:'Ok',routes:[{distance:152000,duration:5700,geometry:QC}]})});
v(r1.source==='osrm' && Math.round(r1.km)===152, 'OSRM OK → 152 km');
v(r1.pts.length===3,'tracé décodé (3 points)');
let e0=false; try { await T.itineraireOSRM({lat:45.2,lng:-73},{lat:46,lng:-72.1},{fetchFn: rep({code:'Ok',routes:[{distance:1,duration:1,geometry:'_p~iF~ps|U_ulLnnqC_mqNvxq`@'}]})}); } catch { e0=true; } v(e0,'tracé hors Québec/Canada → refusé');
let e1=false; try { await T.itineraireOSRM({lat:45,lng:-73},{lat:46,lng:-72},{fetchFn: rep({},503)}); } catch { e1=true; } v(e1,'HTTP 503 → erreur (donc repli)');
let e2=false; try { await T.itineraireOSRM({lat:45.1,lng:-73},{lat:46,lng:-72},{fetchFn: rep({code:'NoRoute'})}); } catch { e2=true; } v(e2,'NoRoute → erreur');
let appels=[]; const espion = async (u)=>{ appels.push(Date.now()); return { ok:true, status:200, json: async()=>({code:'Ok',routes:[{distance:1000,duration:60,geometry:QC}]}) }; };
await T.itineraireOSRM({lat:45.5,lng:-73.5},{lat:45.6,lng:-73.6},{fetchFn:espion});
await T.itineraireOSRM({lat:45.5,lng:-73.5},{lat:45.7,lng:-73.6},{fetchFn:espion});
v(appels.length===2 && appels[1]-appels[0]>=1000, '2 appels espacés d\'au moins 1 s ('+(appels[1]-appels[0])+' ms)');
await T.itineraireOSRM({lat:45.501,lng:-73.501},{lat:45.6,lng:-73.6},{fetchFn:espion});
v(appels.length===2, 'même trajet (à 1 km près) → servi par le cache, aucun appel');
let urlVue=''; await T.itineraireOSRM({lat:45.12345,lng:-73.98765},{lat:46.5,lng:-71.2},{fetchFn: async (u)=>{ urlVue=u; return {ok:true,status:200,json:async()=>({code:'Ok',routes:[{distance:1,duration:1,geometry:QC}]})}; }});
v(urlVue.includes('-73.99,45.12;') , 'coordonnées envoyées arrondies : '+urlVue.replace(T.OSRM_URL,'…/').split('?')[0]);
const est = T.itineraireEstime({lat:45.5,lng:-73.6},{lat:45.53,lng:-73.5},{lat:45.522,lng:-73.54});
v(est.source==='estimation' && est.pts.length===3, 'repli en ligne droite par un pont');
console.log(`\nRésultat : ${ok} réussis, ${ko} échoués`); process.exit(ko?1:0);
