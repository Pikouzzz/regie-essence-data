# Écono Gaz

Prix de l'essence et du diesel au Québec : https://pikouzzz.github.io/regie-essence-data/
Source des prix : Régie essence Québec, Régie de l'énergie. Application indépendante, non affiliée à la Régie.

## Comment c'est organisé
| Élément | Rôle |
|---|---|
| `src/` | Code de l'app (`econo-gaz.jsx`, `trajet.js`…) et `build.py` |
| `tests/` | Tests lancés avant chaque publication |
| `index.html` | **Construit automatiquement — ne pas modifier à la main** |
| `stations.json` | Prix, mis à jour toutes les 15 min par le robot |
| `scripts/fetch_regie.py`, `data/` | Robot des prix |
| `.github/workflows/update.yml` | Robot des prix (toutes les 15 min) |
| `.github/workflows/construire.yml` | Robot de construction : tests → `index.html` à chaque changement dans `src/` |

## Mettre à jour l'app
1. Ouvrir le dossier `src/` › Add file › Upload files › glisser les fichiers modifiés › Commit changes
2. Onglet Actions › « Construire l'app » doit finir en vert (2–3 min) ; si un test échoue, le site ne change pas
