# Journal des versions de Xylform CAD, by Seb.

Toutes les évolutions du logiciel, de la plus récente à la plus ancienne. Les versions publiées
sont téléchargeables sur <https://github.com/Seb59181/XYLFORM-CAD/releases>.

---

## 1.2.0 — 14 novembre 2026

Xylform CAD 1.2.0 : cotation et mise en plan complètes, construction plus rapide, blocs, plans de coupe et mode Présentation.

- **Styles de cote** (`STYLECOTE`, liste déroulante dans l'onglet Annoter) : type et taille des flèches (pleine, ouverte, oblique, point, aucune), décimales, séparateur décimal, préfixe et suffixe, tolérances (symétrique ±, écarts +/− ou limites). Chaque cote garde son style ; la palette Propriétés le change, avec la tolérance. Les flèches par défaut sont maintenant **pleines**.
- **Repères et étiquettes** (onglet Annoter) : **`REPERE`** ligne de repère avec texte libre ; **`ETIQUETTE`** pose une étiquette qui lit l'objet visé (longueur, rayon, aire, volume, coordonnées, nom, numéro de pièce) et se met à jour quand l'objet change.
- **Cote 3D** (`COT3D`) : cote alignée entre deux points de hauteurs différentes, texte toujours face à l'écran. `COTALI` le fait aussi tout seul quand les points ne sont pas à la même hauteur.
- **Guides de construction** (`GUIDE`, `RAPPORTEUR`, `EFFGUIDES`) : droites infinies horizontales, verticales, inclinées, décalées ou bissectrices, sur un calque à part, ignorées par le zoom étendu et l'impression ; on s'y accroche comme à une ligne.
- **Nouveaux accrochages** : **Extension** (dans le prolongement d'une ligne ou d'un arc survolé), **Parallèle** (parallèle à une ligne survolée), **`DE`** (point de base puis décalage, par exemple `DE` → coin → `@20,10`) et **`M2P`** (milieu entre deux points cliqués).
- **Cotes associatives** : une cote posée sur des objets les suit quand ils sont déplacés, étirés ou modifiés (ligne, polyligne, cercle, arc). Les copies de cotes restent liées aux copies des objets. `COTASSOC` pour les figer.
- **Mise en plan** (onglet Sortie › Vues et nomenclature) :
  - **`VUECOUPE`** vue en coupe hachurée (trait de coupe, flèches et lettres « A-A » sur la vue d'origine) ;
  - **`VUEDETAIL`** vue de détail agrandie dans un cercle (« DÉTAIL B (2:1) ») ;
  - **`BULLE`** numéros de pièce et **`NOMENCLATURE`** tableau repère / désignation / quantité / matière, mis à jour avec les vues ;
  - **`RAPPELTROU`** rappel de perçage lu dans le modèle (« 2× M6 prof. 8 », lamage, fraisure) ;
  - `MAJVUES` régénère aussi les coupes, les détails et la nomenclature, et les cotes posées sur les vues les suivent.
- **Blocs et composants** (onglet Insérer › Blocs) : **`BLOC`** regroupe des objets en un bloc réutilisable, **`INSERER`** en place des copies (échelle, rotation), **`MODIFBLOC`** / **`FERMERBLOC`** modifient le bloc et toutes ses copies, `DECOMPOS` redonne des objets séparés. **`MESCOMPOSANTS`** : votre bibliothèque personnelle de blocs, disponible dans tous vos dessins.
- **Plans de coupe enregistrés** (Outils 3D › menu ▾ de Coupe de section) : **`PLANCOUPE`** crée un plan nommé (X, Y, Z ou parallèle à une face) enregistré dans le dessin et réappliqué à l'ouverture ; **`PLANSCOUPE`** l'active, l'inverse, le renomme ou le supprime ; **`COUPE2D`** pose à plat dans le dessin la section des solides (contours fermés et hachures), pour la coter ou l'exporter en DXF.
- **Scènes et mode Présentation** (onglet Vue › Scènes) : une vue nommée garde désormais aussi les **calques visibles** et le **plan de coupe actif**. **`PRESENTATION`** enchaîne les scènes en plein écran avec des transitions animées de la caméra (← → ou clic pour avancer, P pour la lecture automatique, Échap pour quitter). **`EXPORTPRESENTATION`** enregistre la visite en **vidéo WebM** ou en **GIF animé**.
- **Thème clair ou sombre des barres de menu** : bouton soleil / lune dans la barre de titre, ou commande `THEME`.

---

## 1.1.0 — 14 novembre 2026

Xylform CAD 1.1.0 : saisie plus rapide, nouvelles cotes et un style « dessin technique ».

- **Saisie dynamique à deux cases** : près du curseur, tapez la **longueur**, **Tab**, l'**angle** (ou la **largeur**, **Tab**, la **hauteur** pour un rectangle). La case remplie est verrouillée : l'aperçu suit la valeur tapée et un clic l'utilise.
  - **RECTANGLE** : après le 1er coin, `120 Tab 80` (ou `120,80`) dessine un rectangle de 120 × 80 ; une valeur négative le dessine de l'autre côté. Même chose pour le 2e coin de `BOITE` et de `SURFPLANE`.
  - Les coordonnées tapées après un premier point sont maintenant **relatives** à ce point (le `@` est implicite) ; `#` force l'absolu. Commande **`COORDSDYN`** ou menu ▾ de **DYN** dans la barre d'état pour revenir aux coordonnées absolues.
- **Pas de la grille et de la résolution réglables** : `GRILLE 10` ou `RESOL 5` (ou le menu ▾ de **GRILLE** dans la barre d'état). Jusqu'ici le pas d'accrochage F9 changeait avec le zoom ; il reste fixe une fois réglé. « Adaptatif » revient à l'ancien comportement.
- **Vues nommées** (`VUESNOMMEES`, ruban Vue, ou menu de la vue en haut à gauche) : enregistrez un cadrage avec sa projection et son style visuel, rappelez-le en un clic (scènes). Les vues sont enregistrées dans le dessin.
- **Nouvelles cotes** (onglet Annoter) :
  - **`COTANG`** cote angulaire : entre deux lignes ou deux côtés de polyligne (l'emplacement choisit le secteur), d'un arc, d'un cercle, ou par sommet et deux points ;
  - **`COTARC`** longueur d'arc, avec le symbole ⌒ ;
  - **`COTORD`** cote ordonnée : abscisse ou ordonnée d'un point depuis une origine (option **Origine**, par exemple le coin de la pièce) ;
  - **`COTCONTINUE`** cotes en série et **`COTLIGNEBASE`** cotes empilées depuis la même origine, à la suite de la dernière cote : il suffit de cliquer les points suivants.
  - Elles fonctionnent aussi sur les mises en plan, à l'export PDF, SVG et DXF.
- **Style visuel « Technique »** (Vue › Styles visuels) : dessin au trait sur fond blanc, arêtes noires, **arêtes cachées en tirets** et **contours apparents** des cylindres, sphères et congés. Les objets 2D blancs passent en noir.

---

## 1.0.0 — 10 novembre 2026

Première version distribuée, sous le nom **Xylform CAD** (anciennement SebCad). Elle reprend tout
SebCad 2.0.0 (voir l'historique plus bas) et ajoute :

- **Nouveau nom et nouvelle identité** : logo Xylform CAD sur l'écran de chargement et la page Démarrage, nouvelle icône (fenêtre, barre des tâches, raccourcis, installateur).
- **Nouveau format de dessin `.xcad`** : `ENREG` écrit désormais des `.xcad`. Les dessins `.sebcad` (et `.ncad`) s'ouvrent toujours ; les enregistrer les convertit en `.xcad`. À la première ouverture, les réglages de SebCad (ruban personnalisé, dessins récents, options) sont repris.
- **Mise à jour automatique** (version installée) : au démarrage, Xylform CAD vérifie s'il existe une version plus récente sur GitHub ; vous choisissez de la télécharger, puis de l'installer tout de suite ou à la fermeture. Commande **`MISEAJOUR`** pour vérifier à la main ou couper la vérification automatique. La version portable signale la nouvelle version et ouvre la page de téléchargement.
- **Écran « Quoi de neuf »** affiché une fois après chaque mise à jour, et à tout moment par **`QUOIDENEUF`** ou le lien de la page Démarrage.
- **Chanfrein au bout des vis et des tiges filetées** : vis H, vis CHC, vis du boulon complet (au bout de la tige) et tige filetée (aux deux bouts) ont un chanfrein d'entrée à 45° jusqu'au fond de filet (≈ 0,5 × pas), en filetage Réel comme Aucun. Les vis entrent plus facilement et le premier filet imprimé ne s'écrase plus. L'empreinte à soustraire garde un bout droit.
- **Logiciel libre (licence MIT)**, code source sur GitHub.

---

## Historique avant distribution (SebCad)

### SebCad 2.0.0 — 10 novembre 2026

Nouvelle version majeure : plusieurs dessins ouverts en même temps et une interface réorganisable.

- **Onglets des dessins**, sous le ruban :
  - onglet **Démarrage**, puis un onglet par dessin avec son nom, un **astérisque** s'il est modifié et une **croix** pour le fermer, bouton **+** pour un nouveau dessin, menu **☰** listant les dessins ouverts ;
  - `NOUVEAU` (Ctrl+N) et `OUVRIR` (Ctrl+O) ouvrent un **nouvel onglet** au lieu de remplacer le dessin (le dessin vierge du démarrage est réutilisé) ; un fichier déjà ouvert est simplement affiché ; un dessin déposé sur la fenêtre ou ouvert par double-clic dans l'Explorateur arrive aussi dans son onglet ;
  - fermer : croix, clic milieu, **Ctrl+F4** ou `FERMER` ; un dessin modifié propose **Enregistrer / Ne pas enregistrer / Annuler** ; `FERMERTOUT`, `ENREGTOUT` (aussi dans le clic droit d'un onglet, avec « Fermer tous les autres » et « Copier le chemin complet ») ;
  - **Ctrl+Tab / Ctrl+Maj+Tab** : dessin suivant / précédent ; glisser un onglet pour changer l'ordre ;
  - chaque dessin garde **sa vue, sa sélection, son plan de travail (ELEV) et son historique d'annulation** ; copier / coller passe d'un dessin à l'autre ; la mémoire 3D d'un dessin fermé est libérée.
- **Page Démarrage** (`DEMARRAGE`) : nouveau dessin, ouvrir, dessins ouverts, **dessins récents** (rouverts directement par leur chemin dans la version Windows ; la croix les retire de la liste) et copies de secours à récupérer.
- **Fenêtres de vue multiples** (`FENETRES`, Vue › Interface, ou icône de la barre d'état) : 1, 2 (côte à côte ou l'une sur l'autre), 3 (grande vue à gauche) ou 4 vues du même dessin, par défaut Dessus, Face et Droite. On dessine dans la vue encadrée en bleu ; **un clic dans une autre vue la rend active** (les deux vues s'échangent). Molette : zoom, glisser : orbite, double-clic : zoom étendu, menu **[+]** : choisir la vue.
- **Barre d'état** :
  - onglets **Objet** et un onglet par **mise en plan** : un clic cadre la feuille en vue de dessus, « Objet » revient à la vue de modélisation, **+** lance `MISEENPLAN` ;
  - menu **☰ de personnalisation** : cocher les boutons à afficher (coordonnées, aides au dessin, noyau 3D…), afficher ou masquer les onglets des dessins (`ONGLETSDESSIN`) ;
  - **écran épuré** (Ctrl+0, bouton ⛶ ou `ECRANEPURE`) : ruban et onglets masqués, toute la place au dessin.
- **Visserie : « Usage » mieux expliqué.** L'empreinte n'a pas la même taille que la vis : c'est un outil de perçage, plus gros du jeu (0,2 mm de chaque côté), qu'on soustrait de la plaque et qu'on n'imprime jamais ; la « Pièce » est la vraie vis, aux cotes exactes, celle qu'on imprime. Il faut donc insérer les deux. Le menu le dit maintenant (« Pièce à imprimer » / « Empreinte (perçage) »), l'aide « ? » détaille la méthode, et un rappel s'affiche en permanence sous le menu (en orange pour l'empreinte).
- **Sauvegarde automatique par dessin** : chaque onglet modifié a sa propre copie de secours ; après un plantage, SebCad propose de récupérer tous les dessins, chacun dans son onglet (`RECUPDESSIN` aussi). Quitter avec des dessins non enregistrés demande confirmation.

### SebCad 1.11.0 — 10 novembre 2026

- **Visserie plus claire** (vis H, vis CHC, écrou, boulon, tige filetée, plaquette de calibration) :
  - Filetage : seulement **Aucun** (tige lisse) ou **Réel** (hélice). L'option « Cosmétique » disparaît ; les pièces à filetage réel restent affichées en aperçu rapide pendant le dessin, avec le filet exact calculé à l'export.
  - Un **point d'interrogation** à côté de Filetage, Usage et Jeu d'impression explique chaque réglage (survol ou clic). Pour le jeu : il ne sert qu'à l'empreinte à soustraire et s'ajoute de chaque côté du trou (0,2 mm, soit 0,4 mm de plus sur le diamètre).
  - Le champ **Jeu** est masqué quand Usage est sur « Pièce ».
  - Même principe sur les autres pièces à jeu : charnières (jeu radial, jeu entre charnons), paumelle, raccords PVC (jeu d'emboîture).
- **Contrôle d'imprimabilité avant export** STL / 3MF (case cochée par défaut, réglable), et commande **`IMPRIMABILITE`** (Sortie › Impression 3D) :
  - **solides qui se chevauchent** : signalés avec leur volume commun ; SebCad propose de les fusionner pour l'export (le dessin n'est pas modifié) ;
  - **parois trop fines** (moins de 0,8 mm par défaut) colorées en orange, **porte-à-faux** de plus de 45° colorés en rouge, avec les surfaces concernées ; l'export demande confirmation ;
  - l'**unité proposée** est celle du dessin (mm, cm, m, pouces, pieds) au lieu de toujours mm ; le fichier reste écrit en millimètres.

### SebCad 1.10.0 — 10 novembre 2026

Optimisation pour l'impression 3D et le confort de modélisation :

- **Jeu des filetages enfin efficace.** Le jeu d'impression est maintenant donné **par côté** et appliqué **perpendiculairement aux flancs du filet** (0,2 mm par défaut). Jusqu'à la 1.9.5, le jeu agrandissait seulement le diamètre : sur un filet à 60°, il ne restait que le quart du jeu sur les flancs (0,1 mm pour 0,4 demandé), d'où les vis imprimées qui ne rentraient pas. Concerne l'empreinte de vis H / CHC / tige, l'écrou et `PERCAGE` taraudé. Le jeu est plafonné à 0,2 × pas pour qu'il reste un filet (≈ 0,1 mm en M3, 0,25 mm en M8). Les anciens dessins se reconstruisent à l'identique.
- **Plaquette de calibration** (Pièces › Visserie) : une rangée de trous taraudés à jeux croissants (1 à 8 points gravés, par exemple 0,10 / 0,15 / 0,20 / 0,25 / 0,30 mm) et des trous lisses Ø4 à Ø12. On l'imprime avec une vis « Pièce » : le premier trou où la vis tourne sans forcer donne le bon jeu pour votre imprimante.
- **Compensation des trous imprimés** (`COMPTROU` ou `OPTIONS`) : en FDM les trous sortent trop petits. La valeur réglée (mm sur le Ø, mesurée sur la plaquette) agrandit les nouveaux trous de passage, lamés et fraisés de `PERCAGE` et les trous des pièces (plaque, rondelle, entretoise, charnières). Elle reste modifiable dans Propriétés › Historique.
- **Filetage réel calculé à l'export.** Par défaut, une pièce ou un trou à filetage réel s'affiche en aperçu cosmétique (1 à 2 s au lieu de 10 à 30 s) ; le filet exact est calculé automatiquement à l'export STL, 3MF ou STEP, y compris dans les solides où la vis a été soustraite. `FILETAGEREEL` le calcule tout de suite, `MODEFILETAGE` (ou `OPTIONS`) revient au filet exact permanent.
- **Échap arrête vraiment un calcul 3D** (ou le nouveau bouton **Arrêter** de la barre d'état) : le noyau OpenCascade est relancé en quelques secondes et tous les solides sont rechargés depuis une copie de secours tenue à jour en tâche de fond. Seul l'historique d'annulation (Ctrl+Z) est vidé. Effet secondaire : l'enregistrement est plus rapide, la copie étant déjà prête.

### SebCad 1.9.5 — 9 novembre 2026

- **Trous taraudés imprimables : jeu d'impression.** Une vis soustraite d'un solide laissait l'empreinte exacte de la vis : à l'impression, la vis ne rentrait pas.
  - Vis H, vis CHC et tige filetée ont un nouveau réglage **Usage** : « Pièce » (cotes nominales, à imprimer) ou « **Empreinte à soustraire** », c'est-à-dire la même vis grossie du **Jeu d'impression** (0,4 mm sur le diamètre par défaut, filet compris). Méthode : insérer l'empreinte, la soustraire du solide, puis insérer et imprimer la vis en usage « Pièce ».
  - **PERCAGE** taraudé avec filetage réel : nouvelle option **Jeu** (0,4 mm par défaut), aussi modifiable ensuite dans Propriétés › Historique.
  - Si la vis force encore, augmenter le jeu (0,5 à 0,6 mm) ; pour M3 à M5, le filetage imprimé reste délicat en FDM.

### SebCad 1.9.4 — 9 novembre 2026

- **Correction : un 3MF ou STL importé ne se laissait ni sélectionner, ni déplacer, ni modifier.** Sur un maillage détaillé (des dizaines de milliers d'arêtes, comme un bouton moleté), la surbrillance de sélection faisait déborder la pile (« Maximum call stack size exceeded ») : DEPLACER échouait et la palette Propriétés restait vide. Ces corps se sélectionnent, se déplacent, pivotent, se copient et se mettent en miroir normalement.
- La palette **Propriétés** indique maintenant « Corps maillé fermé (N triangles) » pour un objet importé. Pour les raccords, la coque ou appuyer/tirer, le convertir d'abord avec **CONVSOLIDE**.

### SebCad 1.9.3 — 9 novembre 2026

- **Correction : soustraire une vis à filetage réel d'un solide ne finissait jamais.** Le noyau 3D appliquait une tolérance floue qui, sur les filets hélicoïdaux, tournait plus de 25 minutes. Les solides à surfaces gauches (filetages, balayages, lissages) passent maintenant d'abord en calcul exact : la même soustraction (vis M6 dans une plaque) prend environ 1,5 seconde et laisse un trou taraudé.
- **Échap pendant un calcul 3D** : la commande s'arrête et son résultat est abandonné à l'arrivée, au lieu de modifier le dessin. Le noyau ne peut pas couper un calcul en cours : la ligne de commande le signale.

### SebCad 1.9.2 — 9 novembre 2026

- **Filetage sur le boulon complet** : la pièce « Boulon complet » a maintenant l'option **Filetage**, appliquée à la vis et à l'écrou. Le filet de l'écrou est calé sur celui de la vis, les deux s'emboîtent sans se chevaucher.
- **Nouveau mode « Cosmétique »** pour toute la visserie (vis H, vis CHC, écrou, tige filetée, boulon) : stries au profil ISO, sans hélice. Aspect fileté en 1 à 2 secondes, au lieu de 10 à 30 secondes pour le filetage réel. Les trois choix : Aucun (cylindre lisse), Cosmétique, Réel (hélice, pour l'impression 3D).

### SebCad 1.9.1 — 9 novembre 2026

- **Correction : « Profil non plan ou auto-sécant » à l'extrusion d'une spline.** En vue 3D, un clic proche de la verticale du point précédent accrochait l'axe Z : le point (et tous les suivants) partait en hauteur, et la spline n'était plus plane. Pendant SPLINE et POLYLIGNE, les points restent maintenant à la hauteur du point précédent.
- **Messages clairs** : un profil à peine gauche est aplani automatiquement à l'extrusion ; sinon le message indique le point hors plan (coordonnées et écart) ou l'endroit où la courbe se croise.
- **Nouvelle commande APLANIR** (`APL`) : ramène lignes, polylignes, splines, cercles, arcs et ellipses à plat (Z = élévation courante).

### SebCad 1.9.0 — 9 novembre 2026

- **Ruban sans barre de défilement** : le ruban s'adapte à la largeur de la fenêtre. Quand la place manque, les petits boutons perdent leurs libellés (en commençant par les groupes de droite ; les deux premiers groupes gardent les leurs le plus longtemps), puis les commandes les moins utilisées passent dans un menu ouvert par le petit triangle ▾ sous le groupe, et en dernier recours un groupe se replie en un bouton qui l'ouvre en entier.
- **Groupe Modification** : Déplacer, Copier, Étirer, Rotation, Miroir, Échelle toujours visibles ; boutons à variantes Ajuster ▾ (Prolonger), Raccord ▾ (Chanfrein), Réseau ▾ (rectangulaire, polaire) ; Effacer, Décaler, Décomposer ; Coupure, Joindre et Diviser sous « Modification ▾ ».
- **Groupes réorganisables** dans chaque onglet (Début, Insertion…) : glissez le titre d'un groupe (Modification, Annotation…) à la place voulue. Clic droit sur le titre : déplacer à gauche ou à droite, placer en premier ou en dernier, rétablir l'ordre d'origine. L'ordre est mémorisé.
- **Distance de déplacement au clavier** : pendant DEPLACER (et COPIER, LIGNE…), orientez le curseur puis tapez la distance et Entrée. Correction : sur l'axe bleu (Z) ou vers un point à une autre hauteur, la distance tapée était refusée ou appliquée à plat ; elle suit maintenant la direction réelle en 3D.

### SebCad 1.8.0 — 8 novembre 2026

Contenu (choisi par Sébastien) :

- **Mise en plan depuis la 3D** : vues de face, de dessus, de côté et isométrique générées depuis les solides, cotables, exportables en DXF ou en PDF.
- **Tôlerie** : pièces en tôle avec pliages et mise à plat.
- **Réseaux 3D** : copies d'une pièce en ligne, en cercle ou le long d'un chemin.
- **Rendu réaliste** : matériaux, ombres et capture d'image.
- **Personnalisation** : raccourcis clavier et onglet de ruban sur mesure.

Idées proposées mais pas retenues pour l'instant : aperçu du plateau d'impression, blocs et groupes, nomenclature.

---

### SebCad 1.7.0 — 8 novembre 2026

- **Historique paramétrique** (une chronologie des opérations) : chaque corps garde ses étapes (primitive, extrusion, révolution, congé, chanfrein, coque, appuyer/tirer, perçage, booléens, texte gravé, déplacements). Dans Propriétés › Historique, modifier une cote rejoue tout ; une étape peut être désactivée (●/○) ou retirée (✕). Une cote peut être une expression liée aux paramètres utilisateur (`ep*2`). Le Navigateur affiche les étapes sous chaque corps.
- **Assistant de perçage** (`PERCAGE`) : trous de passage, lamés (ISO 4762), fraisés à 90° (ISO 10642), taraudés (filetage réel en option) ou logements d'inserts à chaud, M3 à M20, borgnes ou débouchants, plusieurs trous à la fois.
- **Sauvegarde automatique** (`TEMPSSAUV`, toutes les 5 minutes par défaut) et **récupération après plantage** : au démarrage, SebCad propose « Récupérer / Ignorer » ; `RECUPDESSIN` rouvre la copie à la main.
- **Écran de démarrage** : nom, version et progression du chargement du noyau 3D.
- Contrôle global : les 154 commandes lancées puis annulées sans erreur ; 141 tests automatiques au vert.

### SebCad 1.6.0 — 8 novembre 2026

Nouveautés 3D :

- **Import STL / 3MF** : ouverture ou glisser-déposer ; le corps maillé se déplace, se coupe et accepte union, soustraction et intersection. `CONVSOLIDE` le convertit en solide B-rep (pour raccords, coque…).
- **Manipulateur 3D** (`GIZMO`) : flèches et anneaux sur la sélection pour déplacer ou tourner à la souris, avec saisie d'une valeur exacte au clic.
- **Repérage 3D** (`REPOBJ`, F11) : axes X/Y/Z colorés, alignements, accrochage « Sur la face » et au centre des arêtes circulaires.
- **Mètre 3D** (`MESUREGEOM`) : distance, angle entre faces, épaisseur de paroi, surface.
- **Texte 3D** (`TEXTE3D`) : posé, gravé ou embossé sur une face, polices avec accents.
- **Assemblages** : liaisons pivot ou glissière (`LIAISON`), pilotage par valeur ou animation (`PILOTER`), curseurs dans le Navigateur, détection d'interférences (`INTERFERENCE`).
- Correction : les tiges filetées longues à filetage réel ne font plus échouer la construction.

### SebCad 1.5.0 — 8 novembre 2026

- **Raccords d'évacuation PVC** dans la bibliothèque de pièces (nouvelle catégorie « Plomberie ») : coudes 22°30, 45°, 67°30 et 90° (femelle/femelle ou mâle/femelle), té 87°30/90° et té 45° (culotte), piquage réduit possible, Ø32 à Ø125, cotes préremplies et modifiables. Vérifié : raccords étanches, tube emboîté jusqu'à la butée sans collision.

### SebCad 1.4.0 — 8 novembre 2026

- **Primitives 3D modifiables** : boîte, cylindre, cône, sphère, pyramide et tore gardent leurs cotes ; rayon, diamètre, hauteur… se changent dans Propriétés et le solide est reconstruit à sa place, même après un déplacement ou une rotation.
- **Fenêtre Propriétés libre** : détachable (bouton ⧉) et déplaçable sur le dessin ; Ctrl+1 l'ouvre ou la ferme.
- **Splines fermées** : clic sur le premier point (accrochage) ou option `C` pour boucler la spline ; une spline fermée s'extrude en solide plein.

### SebCad 1.3.0 — 1er novembre 2026

- **Création 3D plus rapide** : étapes intermédiaires non maillées puis libérées de la mémoire, déplacements sans recopie de la géométrie, contrôles calculés une seule fois. Exemple : vis M8 à filetage réel en ≈ 13 s au lieu de ≈ 20 s.
- **Charnières** dans la bibliothèque : à lames, à piano, imprimable assemblée (print-in-place, jeu réglable), paumelle dégondable, à film (living hinge), flexible à fentes (kerf) ; trous de vis droits ou fraisés, ouverture réglable.
- Correction : une polyligne refermée à la main (clic sur le point de départ) s'extrude désormais en **solide plein**, et non plus en simples parois.

### SebCad 1.2.0 — 26 octobre 2026

- **Textes des plans DWG/DXF** fidèles : MTEXT à leur justification exacte, retour à la ligne, interligne, facteur de largeur, attributs de blocs, multilignes de repère, tableaux.
- **Menu du clic droit long** complet, à sous-menus (répéter, commandes récentes, ordre de tracé, presse-papiers, isoler, zoom, vues…).
- Nouvelles commandes : `ORDRETRACE`, `SELECTSIMILAIRE`, `SELECTRAPIDE`, `RECHERCHER`, `OPTIONS`, `COPIERBASE`, `COLLERORIG`.
- **Palettes détachables** et déplaçables dans la vue.
- **Bibliothèque de pièces** (`PIECES`) : visserie ISO M3 à M20 (vis, écrous, rondelles, boulons, tige filetée), tubes et profilés, coudes, boîtes creuses, plaques percées, entretoises.

### SebCad 1.1.0 — 26 octobre 2026

- **Clic droit** : court = Entrée, maintenu ½ seconde = menu contextuel (`CLICDROIT` pour régler la durée).
- **Espaces de travail 2D et 3D** (sélecteur dans la barre de titre, `ESPACETRAVAIL`) : la 2D est plus légère, le noyau 3D n'est chargé qu'au besoin.
- **Outils 3D** : appuyer/tirer (`APPUYERTIRER`), esquisse sur une face (`ESQUISSE`, `ELEV`), analyse de coupe (`ANALYSECOUPE`), masquer / isoler / tout afficher.
- **Cube de vue**, barre de navigation et palette **Navigateur** (corps, surfaces, esquisses, fonds de plan).

### SebCad 1.0.0 — 26 octobre 2026

- Le logiciel devient **« SebCad, by Seb. »** (format natif `.sebcad` ; les anciens `.ncad` s'ouvrent toujours).
- **Version Windows (.exe)** : installateur et version portable, association des fichiers `.sebcad`, enregistrement direct avec Ctrl+S, boîtes « Enregistrer sous » de Windows. Script `creer-exe.bat` pour la régénérer.
- **Fonds de plan** (références externes) : `ATTACHER` un DWG, DXF, PDF ou une image, affichage estompé, accrochage aux objets du fond, palette « Fonds de plan » (`REFEXT` : charger, recharger, estomper, calques, lier, détacher), `ESTOMPAGE`.

### NovaCAD (version de départ) — 25 octobre 2026

- Dossier d'architecture (stack, arborescence, interface, feuille de route) et socle de code : ligne de commande avec sous-options, scène 3D avec gizmo SCU, soustraction booléenne, export STL binaire et 3MF avec vérification d'étanchéité.
- Première version utilisable dans le navigateur (`lancer-novacad.bat`) :
  - interface sombre : ruban à 9 onglets, ligne de commande (autocomplétion, alias, historique), saisie dynamique, palettes Calques / Propriétés / Paramètres, barre d'état, raccourcis F1–F12 ;
  - dessin 2D complet (lignes, polylignes à arcs, cercles, arcs, ellipses, splines, hachures et dégradés, textes, cotes) et outils de modification (déplacer, copier, étirer, décaler, raccord, chanfrein, ajuster, prolonger, réseaux…) ;
  - contraintes paramétriques et cotes pilotées avec expressions ;
  - noyau 3D OpenCascade : primitives, extrusion avec dépouille, révolution, balayage, lissage, hélice, booléens, congés à rayon variable, chanfreins, coque, surfaces ;
  - fichiers : DWG (lecture), DXF, STEP, STL, 3MF, SVG, PNG ; plus de 140 commandes.
