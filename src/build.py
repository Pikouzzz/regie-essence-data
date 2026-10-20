"""Construit le site : index.html autonome (JS + CSS intégrés) avec politique CSP.
Utilisation (depuis la racine du dépôt) : python3 src/build.py <dossier de sortie>   (ex. « . » pour la racine)"""
import subprocess, base64, hashlib, json, shutil, os, sys
RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(RACINE)
OUT = sys.argv[1] if len(sys.argv)>1 else "build"
subprocess.run(["npx","--no-install","esbuild","src/main.jsx","--bundle","--minify","--jsx=automatic",
  "--define:process.env.NODE_ENV=\"production\"","--loader:.png=dataurl","--loader:.svg=dataurl",
  "--outfile=dist-prod/app.js","--log-level=warning"], check=True)
js  = open("dist-prod/app.js",encoding="utf-8").read().replace("</script","<\\/script")
css = open("dist-prod/app.css",encoding="utf-8").read()
script = "\n"+js+"\n"
h = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode()
csp = "; ".join([
  "default-src 'none'",
  f"script-src 'sha256-{h}'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: https://tile.openstreetmap.org https://*.goatcounter.com",
  "connect-src 'self' https://pikouzzz.github.io https://routing.openstreetmap.de",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
])
html = f"""<!doctype html>
<html lang="fr-CA">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Écono Gaz</title>
<meta name="description" content="Prix de l'essence et du diesel au Québec, en temps réel (données de la Régie de l'énergie).">
<meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Écono Gaz">
<link rel="icon" type="image/png" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="manifest" href="manifest.webmanifest">
<style>
:root{{color-scheme:dark;--bg:#0f172a;--bg-grad:linear-gradient(160deg,#0f172a 0%,#1e293b 50%,#0f2027 100%);--surface:#1e293b;--ov:255,255,255;
--t1:#f1f5f9;--t2:#cbd5e1;--t3:#94a3b8;--accent:#22c55e;--low:#22c55e;--mid:#f59e0b;--high:#f87171;--on:#0f172a;
--nav-bg:rgba(15,23,42,.97);--panel-bg:rgba(15,23,42,.92);--warn-t:#fcd34d;--err-t:#fca5a5;--err-t2:#fecaca;--scroll:#334155}}
:root[data-theme=light]{{color-scheme:light;--bg:#f8fafc;--bg-grad:linear-gradient(160deg,#f8fafc 0%,#eef2f7 100%);--surface:#ffffff;--ov:15,23,42;
--t1:#0f172a;--t2:#334155;--t3:#475569;--accent:#15803d;--low:#15803d;--mid:#b45309;--high:#dc2626;--on:#ffffff;
--nav-bg:rgba(255,255,255,.97);--panel-bg:rgba(255,255,255,.95);--warn-t:#92400e;--err-t:#b91c1c;--err-t2:#991b1b;--scroll:#cbd5e1}}
@media (prefers-color-scheme:light){{:root:not([data-theme=dark]){{color-scheme:light;--bg:#f8fafc;--bg-grad:linear-gradient(160deg,#f8fafc 0%,#eef2f7 100%);--surface:#ffffff;--ov:15,23,42;
--t1:#0f172a;--t2:#334155;--t3:#475569;--accent:#15803d;--low:#15803d;--mid:#b45309;--high:#dc2626;--on:#ffffff;
--nav-bg:rgba(255,255,255,.97);--panel-bg:rgba(255,255,255,.95);--warn-t:#92400e;--err-t:#b91c1c;--err-t2:#991b1b;--scroll:#cbd5e1}}}}
:root[data-theme=chats]{{color-scheme:light;--bg:#fff4f6;--bg-grad:linear-gradient(170deg,#fff4f6 0%,#fdeef3 100%);--surface:#ffffff;--ov:120,40,80;
--t1:#3a1f36;--t2:#5e3b58;--t3:#74536e;--accent:#b8325f;--low:#0e7a6b;--mid:#a85a07;--high:#b42323;--on:#ffffff;
--nav-bg:rgba(255,255,255,.97);--panel-bg:rgba(255,255,255,.95);--warn-t:#8a4b06;--err-t:#b42323;--err-t2:#8e1c1c;--scroll:#e7b9c8;
--police:ui-rounded,"SF Pro Rounded","Nunito","Varela Round",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;--police-prix:var(--police);--rayon-carte:22px}}
html,body{{margin:0;background:var(--bg);-webkit-tap-highlight-color:transparent}}
{css}</style>
</head>
<body>
<noscript>Écono Gaz a besoin de JavaScript pour fonctionner.</noscript>
<div id="root"></div>
<script>{script}</script>
</body>
</html>
"""
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT,"index.html"),"w",encoding="utf-8").write(html)
print("index.html", len(html)//1024, "Ko  | CSP script sha256-"+h[:12]+"…")
