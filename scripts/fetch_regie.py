"""
Récupère le dernier export Excel de la Régie de l'énergie (regieessencequebec.ca)
et le convertit en stations.json pour l'application.

Utilisation :
  python scripts/fetch_regie.py                 # mode normal (GitHub Actions)
  python scripts/fetch_regie.py --file x.xlsx   # test avec un fichier local
"""
import io, json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from openpyxl import load_workbook

BASE      = "https://regieessencequebec.ca"
XLSX_URL  = BASE + "/data/stations-{ts}.xlsx"
OUT       = Path(__file__).resolve().parent.parent / "stations.json"
MIN_STATIONS = 1000            # en dessous, on considère l'export invalide
PRIX_MIN, PRIX_MAX = 50, 400   # ¢/L — hors de cette plage = donnée aberrante
HEADERS   = {"User-Agent": "regie-essence-data (github.com/Pikouzzz/regie-essence-data)"}

# Colonnes attendues dans l'Excel (repérées par leur nom, pas leur position)
COLS = {
    "nom": "Nom", "banniere": "Bannière", "adresse": "Adresse", "region": "Région",
    "cp": "Code Postal", "lat": "Latitude", "lng": "Longitude",
    "regulier": "Prix Régulier", "super": "Prix Super", "diesel": "Prix Diesel",
}

session = requests.Session()
session.headers.update(HEADERS)


def log(*a):
    print(*a, flush=True)


def existe(url):
    """True si l'URL répond 200 (GET en streaming, sans télécharger le contenu)."""
    try:
        with session.get(url, stream=True, timeout=10) as r:
            return r.status_code == 200
    except requests.RequestException:
        return False


def trouver_dernier_export():
    """Retourne (url, horodatage 'AAAAMMJJHHMMSS') du plus récent export disponible."""
    # 1) Chercher le lien directement dans la page d'accueil
    try:
        html = session.get(BASE + "/", timeout=15).text
        liens = sorted(set(re.findall(r"stations-(\d{14})\.xlsx", html)))
        if liens:
            ts = liens[-1]
            log(f"Lien trouvé dans la page : {ts}")
            return XLSX_URL.format(ts=ts), ts
    except requests.RequestException as e:
        log(f"Page d'accueil inaccessible ({e}), on sonde les URL.")

    # 2) Sonder les tranches de 5 min récentes (UTC), secondes 00 à 09
    now = datetime.now(timezone.utc)
    slot = now.replace(second=0, microsecond=0, minute=now.minute - now.minute % 5)
    for k in range(9):                         # jusqu'à 40 min en arrière
        base = slot - timedelta(minutes=5 * k)
        for sec in range(10):
            ts = (base + timedelta(seconds=sec)).strftime("%Y%m%d%H%M%S")
            if existe(XLSX_URL.format(ts=ts)):
                log(f"Export trouvé par sondage : {ts}")
                return XLSX_URL.format(ts=ts), ts
    return None, None


def prix(v):
    """'179.9¢' -> 179.9 ; 'N/D' / vide / aberrant -> None"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        p = float(v)
    else:
        m = re.search(r"\d+(?:[.,]\d+)?", str(v))
        if not m:
            return None
        p = float(m.group().replace(",", "."))
    return round(p, 1) if PRIX_MIN <= p <= PRIX_MAX else None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def stable_id(banniere, adresse, lat, lng, seen):
    """Même hash FNV-1a que dans l'app (sur les unités UTF-16, comme charCodeAt)."""
    s = f"{banniere}|{adresse}|{'' if lat is None else f'{lat:.4f}'}|{'' if lng is None else f'{lng:.4f}'}"
    h = 2166136261
    b = s.encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 16777619) & 0xFFFFFFFF
    base = ""
    n = h
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    while True:
        n, r = divmod(n, 36)
        base = chars[r] + base
        if n == 0:
            break
    seen[base] = seen.get(base, 0) + 1
    return base if seen[base] == 1 else f"{base}-{seen[base]}"


def lire_excel(contenu):
    wb = load_workbook(io.BytesIO(contenu), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    entete = [str(c).strip() if c is not None else "" for c in next(rows)]
    manquantes = [v for v in COLS.values() if v not in entete]
    if manquantes:
        raise SystemExit(f"Colonnes introuvables dans l'Excel : {manquantes} (en-tête lu : {entete})")
    idx = {k: entete.index(v) for k, v in COLS.items()}

    stations, seen = [], {}
    for r in rows:
        if not r or all(c is None for c in r):
            continue
        g = lambda k: r[idx[k]]
        txt = lambda k: str(g(k)).strip() if g(k) is not None else ""
        lat, lng = num(g("lat")), num(g("lng"))
        banniere = txt("banniere")
        stations.append([
            stable_id(banniere, txt("adresse"), lat, lng, seen),
            txt("nom"), banniere, txt("adresse"), txt("region"), txt("cp"),
            lat, lng, prix(g("regulier")), prix(g("super")), prix(g("diesel")),
        ])
    return stations


def main():
    args = sys.argv[1:]
    if args[:1] == ["--file"]:
        chemin = Path(args[1])
        contenu = chemin.read_bytes()
        m = re.search(r"(\d{14})", chemin.name)
        ts, url = (m.group(1) if m else datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")), str(chemin)
    else:
        url, ts = trouver_dernier_export()
        if not url:
            raise SystemExit("Aucun export trouvé : le format d'URL de la Régie a peut-être changé.")
        # Rien à faire si on a déjà cet export
        if OUT.exists():
            try:
                if json.loads(OUT.read_text(encoding="utf-8")).get("source", "").endswith(ts + ".xlsx"):
                    log("Déjà à jour.")
                    return
            except json.JSONDecodeError:
                pass
        for essai in range(3):
            try:
                r = session.get(url, timeout=60)
                r.raise_for_status()
                contenu = r.content
                break
            except requests.RequestException as e:
                log(f"Téléchargement échoué ({e}), nouvel essai…")
                time.sleep(5)
        else:
            raise SystemExit("Téléchargement impossible.")

    stations = lire_excel(contenu)
    if len(stations) < MIN_STATIONS:
        raise SystemExit(f"Seulement {len(stations)} stations : export jugé invalide, on garde l'ancien fichier.")

    dt = datetime.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    data = {
        "version": 1,
        "ts": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": url,
        "count": len(stations),
        "fields": ["id", "nom", "banniere", "adresse", "region", "cp", "lat", "lng", "regulier", "super", "diesel"],
        "stations": stations,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"OK : {len(stations)} stations, export du {data['ts']} → {OUT.name}")


if __name__ == "__main__":
    main()
