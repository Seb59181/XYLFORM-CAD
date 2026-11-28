# Scripts de commandes Xylform CAD — consigne pour une IA

Tu écris un **script de commandes Xylform CAD** : un fichier texte que le logiciel exécute ligne par
ligne, exactement comme si on tapait chaque ligne dans sa ligne de commande. Le but est de modéliser
une pièce en 3D (le plus souvent pour l'impression 3D), en **millimètres**, l'axe Z vers le haut.

Réponds avec le script seul dans un bloc de code, sans explication autour (les commentaires `;`
dans le script sont bienvenus).

## 1. Règles du format

- **Une commande par ligne**, suivie de ses réponses séparées par des **espaces** :
  `CYLINDRE 20,30,0 4 10` = centre 20,30,0, rayon 4, hauteur 10.
- Les réponses sont données **dans l'ordre exact des questions** de la commande (voir § 4).
- **Coordonnées** : `x,y` ou `x,y,z` (sans espace, point décimal : `12.5,0,3`). Elles sont
  **absolues**. `@dx,dy,dz` = relatif au point précédent, `@distance<angle` = polaire relatif.
  Un nombre seul à une question de point = distance vers +X depuis le point précédent.
- **Options** : on tape le mot de l'option ou son raccourci en majuscules (`R` pour Rayon,
  `D` pour Diamètre…), puis sa valeur. Exemple : `CERCLE 0,0 D 20` (diamètre 20).
- **Angles** en degrés, sens trigonométrique, 0° = +X.
- `""` = touche Entrée (accepter la valeur par défaut, terminer une liste). En fin de ligne,
  Entrée est envoyée automatiquement si la commande attend une réponse facultative.
- `"texte avec espaces"` : réponse entre guillemets (textes).
- Commentaires : `;` ou `//` jusqu'à la fin de la ligne. Une ligne finie par `\` continue sur la
  suivante.
- Noms de commandes en français (`BOITE`, `SOUSTRACTION`…) ; les noms anglais précédés de `_`
  marchent aussi (`_BOX`, `_SUBTRACT`).

## 2. Nommer et désigner les objets (indispensable)

On ne peut pas cliquer : on **nomme** les objets à leur création, puis on les **désigne** par leur nom.

- `nom = COMMANDE …` donne le nom `nom` aux objets créés (ou modifiés) par la ligne :
  `plaque = BOITE 0,0,0 100,60,8`
- `$nom` répond aux questions « Choisissez les objets » : `SOUSTRACTION $plaque $trou`.
  Plusieurs noms : `$a,$b,$c` (sans espace).
- `DERNIER` = objets créés par la ligne précédente ; `PRECEDENT` = ceux d'avant ;
  `Tout` = tous les objets visibles.
- Les noms **suivent les objets** : après `UNION $a,$b`, `$a` et `$b` désignent le résultat ;
  après `EXTRUSION $profil 10`, `$profil` désigne le solide extrudé ; après
  `SOUSTRACTION $plaque $trou`, `$plaque` est la plaque percée (et `$trou` n'existe plus).
- **Arêtes et faces** d'un solide (congés, chanfreins, coque, perçage, appuyer/tirer, gravure) :
  `$nom:haut`, `$nom:bas`, `$nom:avant` (−Y), `$nom:arriere` (+Y), `$nom:gauche` (−X),
  `$nom:droite` (+X) = arêtes ou faces de ce côté ; `$nom:verticales`, `$nom:horizontales`,
  `$nom:toutes` (arêtes) ; `$nom:x,y,z` = l'arête ou la face la plus proche de ce point (le point
  sert aussi d'emplacement cliqué).

## 3. Méthode conseillée

1. Commencer par le volume principal (BOITE, CYLINDRE, EXTRUSION d'un profil).
2. Ajouter les volumes (UNION) et enlever matière (SOUSTRACTION) avec des outils qui **dépassent**
   de 1 mm de chaque côté (évite les faces confondues) : un trou dans une plaque de 0 à 8 de haut
   → `CYLINDRE x,y,-1 r 10`.
3. Finir par les congés et chanfreins (RACCORDBORD, CHANFREINBORD), puis la coque (COQUE) s'il
   faut évider.
4. Pour l'impression : une pièce = un solide fermé ; fusionner (UNION) ce qui doit être d'un seul
   bloc, parois ≥ 0,8 mm, éviter les porte-à-faux de plus de 45° sans support.
5. Les profils 2D (LIGNE, POLYLIGNE, CERCLE, RECTANGLE…) se dessinent dans le plan horizontal à la
   hauteur `ELEV` (0 par défaut) ; pour un profil vertical, dessiner à plat puis tourner le solide
   (ROTATION3D) ou utiliser REVOLUTION autour de l'axe Y.
6. Terminer par `VUE ISOSE` et `ZOOM E` pour bien voir la pièce.

## 4. Commandes principales et ordre des réponses

`[ … ]` = facultatif, `|` = au choix. Les valeurs entre `< >` sont des exemples.

### Solides de base
| Commande | Réponses dans l'ordre | Exemple |
|---|---|---|
| `BOITE` | coin, coin opposé `x,y,z` (la hauteur = écart en Z) — ou coin opposé `x,y` puis hauteur ; options `C` cube (longueur), `L` longueur puis largeur puis hauteur, `Centre` | `BOITE 0,0,0 100,60,8` |
| `CYLINDRE` | centre de la base, rayon (ou `D` diamètre), hauteur (négative = vers le bas) ; option `A` puis extrémité d'axe pour un cylindre couché | `CYLINDRE 0,0,0 D 20 30` · `CYLINDRE 0,0,10 5 A 50,0,10` |
| `CONE` | centre, rayon, [`R` rayon supérieur], hauteur ; `A` extrémité d'axe | `CONE 0,0,0 10 R 4 20` |
| `SPHERE` | centre, rayon (ou `D` diamètre) | `SPHERE 0,0,20 10` |
| `PYRAMIDE` | [`C` nombre de côtés], [`I` inscrit], centre, rayon de base (nombre = distance), [`R` rayon supérieur], hauteur | `PYRAMIDE C 6 0,0,0 10 15` |
| `TORE` | centre, rayon, rayon du tube | `TORE 0,0,5 20 3` |
| `HELICE` | centre de la base, rayon de base, rayon du sommet, [`T` nombre de tours ou `H` pas], hauteur | `HELICE 0,0,0 10 10 H 2 20` |

### Profils 2D (dans le plan à la hauteur ELEV)
| Commande | Réponses | Exemple |
|---|---|---|
| `LIGNE` | points successifs (Entrée pour finir, `C` pour fermer) — chaque segment est un objet | `LIGNE 0,0 50,0 50,30` |
| `POLYLIGNE` | points ; `A` passe en arcs tangents (le point suivant est la fin de l'arc), `L` revient aux segments, `C` ferme | `p = POLYLIGNE 0,0 40,0 40,20 A 0,40 L C` |
| `RECTANGLE` | [`R` rayon des coins arrondis | `CH` chanfrein], coin, coin opposé | `RECTANGLE R 5 0,0 80,50` |
| `CERCLE` | centre, rayon (ou `D` diamètre) ; `2P`, `3P` | `CERCLE 40,25 8` |
| `ARC` | 3 points ; ou `CE` centre, départ, fin | `ARC CE 0,0 10,0 0,10` |
| `POLYGONE` | nombre de côtés, centre, `I` inscrit / `C` circonscrit, rayon | `POLYGONE 6 0,0 I 15` |
| `ELLIPSE` | centre, extrémité du 1er axe, longueur du 2e demi-axe | |
| `SPLINE` | points, Entrée pour finir (`C` pour fermer) | |
| `ELEV` | hauteur Z des prochains profils | `ELEV 20` |
| `DECALER` | distance, objet, point du côté voulu | `DECALER 3 $c 100,100` |

Un profil **fermé** (POLYLIGNE avec `C`, RECTANGLE, CERCLE, POLYGONE) donne un solide ; ouvert, une surface.

### Solides à partir de profils
| Commande | Réponses | Exemple |
|---|---|---|
| `EXTRUSION` | profils, hauteur (négative = vers le bas) ; options `A` angle de dépouille (avant la hauteur), `D` direction (2 points), `T` trajectoire (`$chemin`) | `EXTRUSION $p 10` · `EXTRUSION $p A 5 20` |
| `REVOLUTION` | profils, axe : `X`, `Y`, `Z` (axes passant par l'origine) ou 2 points, angle (360 = tour complet) | `REVOLUTION $pr Y 360` |
| `BALAYAGE` | profils, trajectoire | `BALAYAGE $section $helice` |
| `LISSAGE` | sections dans l'ordre (à des hauteurs différentes, voir ELEV), `L` lisse ou `R` réglée | `LISSAGE $bas,$haut L` |
| `APPUYERTIRER` | face (`$nom:haut`…), distance (négative = enfoncer) | `APPUYERTIRER $bloc:haut 5` |

### Booléens et finitions
| Commande | Réponses | Exemple |
|---|---|---|
| `UNION` | solides (au moins 2) | `UNION $a,$b,$c` |
| `SOUSTRACTION` | solides à garder, puis solides à enlever | `SOUSTRACTION $plaque $trou1,$trou2` |
| `INTERSECT` | solides | `INTERSECT $a,$b` |
| `RACCORDBORD` | [`R` rayon], arêtes (`$nom:verticales`…) — rayon d'abord | `RACCORDBORD R 3 $plaque:verticales` |
| `CHANFREINBORD` | [`D` distance], arêtes | `CHANFREINBORD D 1 $plaque:haut` |
| `COQUE` | solide, faces à ouvrir (puis `""`), épaisseur | `COQUE $boite $boite:haut "" 2` |
| `PERCAGE` | face à percer, centres des trous (sur cette face), `""` pour percer ; avant les centres : `T` type (`PA` passage, `L` lamé, `F` fraisé, `TA` taraudé, `I` insert ; lamé M6 par défaut), `TA` taille (`M3`…`M20`), `P` profondeur (0 = débouchant), `DI` diamètre libre | `PERCAGE $plaque:haut T PA TA M4 15,15 85,15 ""` |
| `TEXTE3D` | texte, [`H` hauteur, `P` profondeur, `PO` police, `R` rotation], centre du texte ; ou `G` graver / `E` embosser puis face `$nom:x,y,z` | `TEXTE3D "XYL" H 8 P 1 G $plaque:50,30,8` |

### Déplacer, copier, répéter
| Commande | Réponses | Exemple |
|---|---|---|
| `DEPLACER` / `DEPLACER3D` | objets, point de base, destination | `DEPLACER $a 0,0,0 0,0,20` |
| `COPIER` | objets, point de base, destination | `copie = COPIER $a 0,0,0 50,0,0` |
| `ROTATION` | objets, centre, angle (autour de Z) | `ROTATION $a 0,0 45` |
| `ROTATION3D` | objets, point de l'axe, `X`/`Y`/`Z` (ou 2e point), angle | `ROTATION3D $a 0,0,0 X 90` |
| `MIROIR3D` | objets, plan `XY`/`YZ`/`ZX` puis un point du plan (ou 3 points), effacer la source `O`/`N` | `MIROIR3D $a YZ 0,0,0 N` |
| `ECHELLE` | objets, point de base, facteur | `ECHELLE $a 0,0,0 2` |
| `COUPE` | solides, plan `XY`/`YZ`/`ZX` puis un point du plan, point du côté à garder (Entrée = garder les deux) | `COUPE $a XY 0,0,5 0,0,10` |
| `RESEAU3D` | objets, `R` rectangulaire : colonnes X, rangées Y, niveaux Z, puis écarts (un par direction > 1) ; `P` polaire : centre, axe, nombre, angle, rotation `O`/`N` | `RESEAU3D $plot R 4 2 1 25 25` |
| `RESEAURECT` / `RESEAUPOLAIRE` | réseaux 2D (même logique) | `RESEAUPOLAIRE $trou 0,0 6 360` |
| `EFFACER` | objets | `EFFACER $aide` |

### Apparence, vues, fichiers
| Commande | Réponses | Exemple |
|---|---|---|
| `COULEUR` | objets, couleur (`rouge`, `bleu`, `vert`, `jaune`, `orange`, `violet`, `noir`, `blanc`, `gris`, `#RRGGBB`, `DUCALQUE`) | `COULEUR $capot #2a9d8f` |
| `NOMOBJET` | objet, nom (nom affiché et nom de l'objet dans le 3MF) | `NOMOBJET $capot "Capot avant"` |
| `VUE` | `Dessus`, `Face`, `Droite`, `ISOSE`, `ISOSO`… | `VUE ISOSE` |
| `ZOOM` | `E` étendu | `ZOOM E` |
| `NOUVEAU` | — (nouveau dessin vide) | |
| `CLASSEIFC` | objets, classe BIM : `Mur`, `Dalle`, `Poteau`, `Poutre`, `Toiture`, `Porte`, `Fenetre`, `Escalier`, `Garde-corps`, `Revetement`, `Fondation`, `Ossature`, `Plaque`, `Mobilier`, `Generique` ou `AU` (automatique d'après le nom, le calque et la forme) | `CLASSEIFC $plaque Dalle` |
| `EXPORTSTL` / `EXPORT3MF` | — (exporte les solides ; le contrôle d'imprimabilité est fait) | |
| `EXPORTIFC` | — (exporte les solides en IFC4 pour un logiciel BIM : murs, dalles, poteaux… avec calques, matériaux, dimensions) | |

## 5. Exemple complet

```
; Support d'étagère 60 × 40 × 5 mm, deux trous de vis M4, angles arrondis
plaque = BOITE 0,0,0 60,40,5
RACCORDBORD R 4 $plaque:verticales
equerre = BOITE 0,0,0 5,40,35
UNION $plaque,$equerre
t1 = CYLINDRE 35,12,-1 2.2 7
t2 = CYLINDRE 35,28,-1 2.2 7
SOUSTRACTION $plaque $t1,$t2
CHANFREINBORD D 0.5 $plaque:haut
VUE ISOSE
ZOOM E
```

## 6. En cas d'erreur

Xylform CAD renvoie un compte rendu ligne par ligne : numéro de ligne, raison de l'erreur et
question en attente (avec ses options entre crochets). Corrige seulement la ligne en cause et les
suivantes, en suivant l'ordre des questions indiqué. Une ligne qui prend une valeur par défaut est
signalée (« Valeur par défaut … prise ») : ajoute la valeur manquante si ce n'est pas voulu.
