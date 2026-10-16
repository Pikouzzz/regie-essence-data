"""Données de test synthétiques au format stations.json (v1). Villes réelles, coordonnées approximatives."""
import json, random, sys
random.seed(42)
# (ville, région, lat, lng, rive, nb stations)
V = [
 ("MONTRÉAL","Montréal",45.508,-73.587,"N",260),("LAVAL","Laval",45.570,-73.720,"N",90),
 ("LONGUEUIL","Montérégie",45.531,-73.518,"S",60),("BROSSARD","Montérégie",45.459,-73.465,"S",40),
 ("QUÉBEC","Capitale-Nationale",46.813,-71.208,"N",150),("LÉVIS","Chaudière-Appalaches",46.736,-71.230,"S",50),
 ("DRUMMONDVILLE","Centre-du-Québec",45.883,-72.484,"S",45),("VICTORIAVILLE","Centre-du-Québec",46.057,-71.966,"S",30),
 ("SAINT-HYACINTHE","Montérégie",45.630,-72.957,"S",35),("BELOEIL","Montérégie",45.567,-73.205,"S",15),
 ("TROIS-RIVIÈRES","Mauricie",46.343,-72.543,"N",70),("BÉCANCOUR","Centre-du-Québec",46.340,-72.433,"S",12),
 ("SHERBROOKE","Estrie",45.400,-71.882,"S",80),("GRANBY","Montérégie",45.400,-72.733,"S",35),
 ("GATINEAU","Outaouais",45.477,-75.701,"N",90),("SAINT-JÉRÔME","Laurentides",45.780,-74.003,"N",35),
 ("SAINTE-AGATHE-DES-MONTS","Laurentides",46.050,-74.283,"N",12),("MONT-TREMBLANT","Laurentides",46.118,-74.596,"N",10),
 ("REPENTIGNY","Lanaudière",45.742,-73.450,"N",35),("JOLIETTE","Lanaudière",46.021,-73.440,"N",25),
 ("BERTHIERVILLE","Lanaudière",46.083,-73.183,"N",8),("LOUISEVILLE","Mauricie",46.256,-72.942,"N",8),
 ("SAGUENAY","Saguenay–Lac-Saint-Jean",48.428,-71.068,"N",70),("ALMA","Saguenay–Lac-Saint-Jean",48.550,-71.650,"N",20),
 ("RIMOUSKI","Bas-Saint-Laurent",48.449,-68.524,"S",30),("RIVIÈRE-DU-LOUP","Bas-Saint-Laurent",47.835,-69.536,"S",25),
 ("MONTMAGNY","Chaudière-Appalaches",46.980,-70.555,"S",10),("LA POCATIÈRE","Bas-Saint-Laurent",47.367,-70.033,"S",8),
 ("SAINT-GEORGES","Chaudière-Appalaches",46.117,-70.667,"S",25),("THETFORD MINES","Chaudière-Appalaches",46.093,-71.300,"S",18),
 ("SAINT-JEAN-SUR-RICHELIEU","Montérégie",45.307,-73.262,"S",40),("VALLEYFIELD","Montérégie",45.254,-74.132,"S",25),
 ("VAUDREUIL-DORION","Montérégie",45.400,-74.033,"N",25),("ROUYN-NORANDA","Abitibi-Témiscamingue",48.239,-79.019,"N",25),
 ("VAL-D'OR","Abitibi-Témiscamingue",48.097,-77.783,"N",22),("BAIE-COMEAU","Côte-Nord",49.217,-68.150,"N",15),
 ("SEPT-ÎLES","Côte-Nord",50.217,-66.383,"N",15),("GASPÉ","Gaspésie–Îles-de-la-Madeleine",48.833,-64.483,"S",10),
 ("CAP-AUX-MEULES","Gaspésie–Îles-de-la-Madeleine",47.383,-61.867,"M",5),("SAINT-RAYMOND","Capitale-Nationale",46.900,-71.833,"N",8),
 ("DONNACONA","Capitale-Nationale",46.680,-71.725,"N",8),("SAINTE-FOY","Capitale-Nationale",46.770,-71.290,"N",30),
 ("SAINT-NICOLAS","Chaudière-Appalaches",46.700,-71.390,"S",12),("PLESSISVILLE","Centre-du-Québec",46.218,-71.776,"S",8),
 ("SAINT-EUSTACHE","Laurentides",45.565,-73.905,"N",20),("TERREBONNE","Lanaudière",45.700,-73.633,"N",35),
 ("CHAMBLY","Montérégie",45.450,-73.283,"S",15),("COWANSVILLE","Estrie",45.200,-72.750,"S",10),
 ("MAGOG","Estrie",45.267,-72.150,"S",15),("SAINT-LOUIS-DE-BLANDFORD","Centre-du-Québec",46.250,-71.950,"S",3),
 ("SAINT-APOLLINAIRE","Chaudière-Appalaches",46.610,-71.520,"S",5),("LAURIER-STATION","Chaudière-Appalaches",46.530,-71.630,"S",3),
 ("SAINTE-EULALIE","Centre-du-Québec",46.110,-72.280,"S",3),("SAINT-ALBERT","Centre-du-Québec",46.000,-72.080,"S",2),
]
BAN = ["Shell","Esso","Ultramar","Petro-Canada","Couche-Tard","Irving","Pétro-T","Crevier","Sonic","Aucun","Costco"]
RUES = ["rue Principale","boul. Saint-Joseph","ch. du Roy","rue Notre-Dame","route 116","boul. Laurier","av. de la Gare","rang Saint-Pierre"]
st=[]; seen=set()
for ville,reg,la,ln,rv,n in V:
    base = random.uniform(-6,6)
    for i in range(n):
        lat = la+random.gauss(0,0.03); lng = ln+random.gauss(0,0.045)
        if ville=="MONTRÉAL": lat=la+random.gauss(0,0.05); lng=ln+random.gauss(0,0.07)
        b = random.choice(BAN); 
        reg_p = round(random.gauss(185+base,4),1)
        sup = round(reg_p+random.uniform(18,28),1) if random.random()>0.05 else None
        dsl = round(reg_p+random.uniform(-5,15),1) if random.random()>0.3 else None
        sid = f"t{len(st):04d}"
        adr = f"{random.randint(1,9999)} {random.choice(RUES)}, {ville if random.random()>0.5 else ville.title()}"
        nom = b if b!="Aucun" else f"Dépanneur {random.choice(['Chez Jo','du Coin','Gagnon','Express'])}"
        st.append([sid,nom,b,adr,reg,"J0A 1B0",round(lat,6),round(lng,6),reg_p,sup,dsl,rv])
# Le long de l'A-20 entre Drummondville et Lévis : quelques stations de bord de route, dont une très peu chère
for k in range(25):
    t=k/24; lat=45.883+(46.70-45.883)*t+random.gauss(0,0.01); lng=-72.484+(-71.39+72.484)*t+random.gauss(0,0.01)
    st.append([f"a20-{k}","Relais A-20","Ultramar",f"{100+k} route 20, Sainte-Eulalie","Centre-du-Québec","G0Z 1E0",round(lat,6),round(lng,6),round(random.gauss(183,3),1),None,190.9,"S"])
st.append(["pascher","Station Pas Chère","Pétro-T","999 route 20, Saint-Albert","Centre-du-Québec","G0Z 1E0",46.02,-72.06,169.9,189.9,179.9,"S"])
# Station très peu chère mais sur l'autre rive (ne doit pas sortir sur un trajet par l'A-20 rive sud… si elle est loin)
st.append(["autrerive","Rive Nord Pas Chère","Esso","1 ch. du Roy, Champlain","Mauricie","G0X 1C0",46.45,-72.35,159.9,None,None,"N"])
print(json.dumps({"version":1,"ts":sys.argv[1] if len(sys.argv)>1 else "2026-10-15T22:00:00Z","source":"test","count":len(st),
  "fields":["id","nom","banniere","adresse","region","cp","lat","lng","regulier","super","diesel","rive"],"stations":st},ensure_ascii=False))
