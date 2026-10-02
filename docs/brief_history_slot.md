# Historisation comme slot générique

Date : 2 octobre 2026
Base : `@cyanmycelium/mcp-broker` 1.6.0, `@cyanmycelium/mcp-broker-provider` 0.3.0, `@cyanmycelium/mcp-core` 1.4.0
Origine : [architecture SCADA v1](https://github.com/pandaGaume/mcp-scada/blob/main/docs/brief_architecture_mcp_scada_v1.md), en particulier `IScadaValue` et la phase 3 (`subscribe`) ; [contrat du broker](https://github.com/pandaGaume/mcp-broker/blob/main/AGENTS.md) (slots, déclaration d'autorisation, `broker/authorize`, audit)

## Décisions prises

| Sujet | Décision |
|---|---|
| Dépôts | `mcp-history` pour l'historique ; le cache vit dans son propre dépôt, `mcp-cache` |
| Adressage | tout est adressé par **id UNS**, historique comme cache : une seule surface d'autorisation, celle de SCADA |
| Paquets | un paquet cœur `@cyanmycelium/mcp-history` (contrat, slot, store mémoire, conformité en sous-chemin `/conformance`), puis un paquet par backend natif : `mcp-history-sqlite`, `mcp-history-duckdb`, `mcp-history-mysql`, `mcp-history-influxdb` |
| UNS commun | `UnsPath` et le contrôle d'accès par id UNS passent dans un dépôt commun, partagé par mcp-scada, mcp-history et mcp-cache |
| InfluxDB | un backend de plus derrière `IHistoryStore`. Grafana, qui sait lire InfluxDB nativement, en profite sans développement ; ce n'est pas un objectif du projet |
| `delete_range` | en v1 |
| Valeurs non numériques | en v1 : `number`, `boolean`, `string`, `json` ; chaque backend déclare celles qu'il gère |

## Principe

Le contrat `history.v1` existe sous **deux formes qui disent la même chose** :

1. une interface TypeScript, `IHistoryStore` : le point de branchement d'un backend ;
2. un jeu d'outils MCP, `history.*`, produit à partir de **n'importe quelle** implémentation par `HistoryBehavior`.

`HistorySlotStore` fait le chemin inverse : il présente un slot `history.v1` distant comme un `IHistoryStore`. La suite de conformité tourne à l'identique sur un store en direct et sur le même store à travers un slot, ce qui prouve que les deux formes s'accordent.

```
            client MCP (agent, page web, recorder)
                              │  MCP, jeton du broker
                         ┌────▼─────┐
                         │ history  │  HistoryBehavior(store, BrokerAccessGuard)
                         └────┬─────┘  le broker décide chaque id, le slot applique
                              │
                  RoutingHistoryStore (phase 3) : route par racine UNS
             ┌────────────────┼──────────────────┐
     MemoryHistoryStore   HistorySlotStore   HistorySlotStore      stores locaux ou
                          → history-sqlite    → history-influxdb   slots de stockage protégés
```

Le routeur est lui-même un `IHistoryStore`. On compose donc librement : un store local, des slots distants, ou un mélange.

## Contrat `history.v1`

Source de vérité : [`packages/mcp-history/src/contract`](../packages/mcp-history/src/contract). Les règles communes sont fixées par la suite de conformité, pas par la prose.

| Opération | Entrée | Sortie |
|---|---|---|
| `getCapabilities` | | valueTypes, nativeAggregates, operations.delete, retention, durability, limits |
| `append` | échantillons | `{ accepted, duplicates, rejected[{ index, error }] }` |
| `readRaw` | ids, `[start, end)`, limit, continuationPoint, format | séries d'échantillons, continuationPoint |
| `readProcessed` | ids, `[start, end)`, intervalMs, agrégats, format | buckets par id, `computedBy` |
| `readAtTime` | ids, instants, `stepped` ou `interpolated` | valeur, qualité et `basis` par instant |
| `browse` | racine UNS, limit, continuationPoint | ids avec first, last, count |
| `deleteRange` | ids, `[start, end)` | `{ deleted, errors }` |

Règles communes :

- **Échantillon** : un `IScadaValue` aplati (`id`, `value`, `quality`, `sourceTimestamp`, `receivedTimestamp`, `provider`).
- **Axe du temps** : `sourceTimestamp ?? receivedTimestamp`, rendu avec `timeOrigin: "source" | "received"`. Aucun horodatage source n'est synthétisé (Modbus n'en porte pas).
- **Horodatages** : ISO 8601 avec décalage explicite en entrée (une heure locale est refusée), UTC à la milliseconde en sortie.
- **`append`** : idempotent sur `(id, time, receivedTimestamp)`, pour pouvoir rejouer un tampon. Un échantillon invalide est rejeté seul, avec son index.
- **Valeurs `bad`** : historisées et relues par `readRaw`. Elles ne comptent que dans `goodRatio`.
- **Agrégats** : `count`, `min`, `max`, `sum`, `avg`, `first`, `last`, `timeWeightedAvg` (marches, à partir de la dernière valeur antérieure au bucket), `goodRatio`. Un bucket vide vaut `null`. Les booléens comptent 0 ou 1.
- **`readAtTime`** : `exact`, `stepped`, `interpolated` (entre deux nombres utilisables seulement, sans extrapolation) ou `none`.
- **Format** : `rows` par défaut (un objet par échantillon ou bucket, instants ISO) ou `columns` (tableaux parallèles par série, instants en millisecondes epoch). Les mêmes données, plusieurs fois moins lourdes. Un store construit des lignes et appelle `formatRawSeries` ou `formatProcessedSeries` en sortie : aucun backend n'a à écrire les colonnes lui-même.
- **Erreurs par id** : un id refusé ou injoignable revient comme `{ id, error }` dans la liste des séries, et le reste de la requête est servi.
- **Erreurs** : `HistoryError { code, message, decisionId?, detail? }`. Les codes sont en snake_case, comme dans `ScadaError`, et sont reconstruits à l'identique de l'autre côté d'un slot.

## Autorisation (broker)

Le broker ne lit jamais les arguments des outils. Le slot pose donc la question, une vérification par id, et applique la réponse.

| Outil | Capability | Ressource vérifiée | Résultat rapporté |
|---|---|---|---|
| `history.capabilities` | aucune | aucune | non |
| `history.browse` | `history.read` | chaque id renvoyé (filtrage, comme si l'id n'avait pas d'historique) | non |
| `history.read_raw`, `read_processed`, `read_at_time` | `history.read` | chaque id demandé | non |
| `history.append` | `history.record` | chaque id écrit | oui |
| `history.delete_range` | `history.admin` | chaque id | oui |

- **Déclaration** (`buildHistoryDeclaration`) : domaine `history`, namespace égal à la racine UNS servie, trois capabilities, `resultsRequired: ["history.record", "history.admin"]`. Les slots de stockage sont listés dans `protects`. Aucun rôle ni aucune assignation : le slot ne peut pas s'autoriser lui-même.
- **Même espace de ressources que SCADA** : `uns://site1/line1/x` est `/site1/line1/x`. Une assignation sur `/site1/line1/**` gouverne la valeur courante et son historique.
- **`IAccessGuard`** : `openGuard()` pour le banc, `BrokerAccessGuard(transport.broker)` en production. Sans référence d'appelant, tout est refusé. Un `allow-with-constraints` qui porte des contraintes est refusé et rapporté `refused`, car l'historique n'a pas de limites d'ingénierie à appliquer.
- **Validé contre un vrai broker** (`tests/broker.test.ts`, `startTestBroker`) : opérateur limité à line1, enregistreur, historien, visiteur. Les décisions et les résultats apparaissent dans l'audit du broker.

## InfluxDB

InfluxDB est une base de séries temporelles : le contrat s'y projette naturellement, avec trois points à trancher dans le paquet `mcp-history-influxdb`.

| Contrat | InfluxDB |
|---|---|
| id UNS | tag `id` (un seul tag : chaque segment en tag ferait exploser la cardinalité) ; measurement unique, `history` |
| valeur | champ `value_num` (nombres et booléens) ou `value_text` (chaînes, JSON) ; `value_type`, `quality`, `provider` en champs |
| axe du temps | timestamp du point ; `source_ts` et `received_ts` en champs |
| agrégats | natifs en SQL (`date_bin`, `GROUP BY`) ; `timeWeightedAvg` et `goodRatio` à vérifier par la conformité |

Points à trancher :

- **Unicité.** InfluxDB identifie un point par série et timestamp : deux échantillons au même instant, reçus à deux moments différents, s'écrasent. Le contrat les garde tous les deux. Il faut soit encoder la réception dans la clé (un tag de plus, au prix de la cardinalité), soit décaler le timestamp à la nanoseconde. Sinon, le backend n'est pas conforme sur ce point, et la suite le dira.
- **Suppression.** Elle est possible en v2 (API delete à prédicat) et limitée selon les éditions v3 : le backend déclare `operations.delete` en conséquence.
- **Version : InfluxDB 3** (décidé). Client `@influxdata/influxdb3-client`, requêtes SQL, `date_bin` pour les buckets. La suppression dépend de l'édition : le backend la déclare dans `operations.delete`.

## Performance du slot

### Mesures (2 octobre 2026)

Banc : vrai broker (`startTestBroker`), slot `history` en `BrokerAccessGuard`, `MemoryHistoryStore`, 4 ids, une semaine à 10 s (241 920 échantillons), appels Streamable HTTP avec session.

| Requête | Résultat |
|---|---|
| `read_processed`, 4 ids × 1008 buckets × 3 agrégats | 44 ms médiane (p90 55 ms), dont 16 ms de calcul dans le store ; **1,3 Mo** de réponse |
| 2, 5, 20 requêtes en parallèle | 62 ms, 152 ms, 623 ms : linéaire, environ 30 ms par requête |
| `read_raw`, 1 id × 60 480 échantillons | 423 ms, **28 Mo**, 491 octets par échantillon |

Ce que ça dit :

- **Le saut par le broker ne coûte presque rien** : quelques millisecondes, aller-retour `broker/authorize` compris.
- **Le coût est dans le format de la réponse.** `McpToolResults.json` envoie le résultat deux fois (`text` et `structuredContent`), et chaque bucket répète ses instants ISO : environ 320 octets par bucket, 490 par échantillon brut. Le temps au-delà du calcul est de la sérialisation JSON.
- **Un client qui affiche une courbe lit des agrégats**, pas du brut : `read_processed` avec un intervalle à la largeur de l'affichage, borné par `maxBucketsPerRead`.

### Après le format colonnes et l'option `payload`

Même banc. `payload: "structured"` est une option de `HistoryBehavior` : le résultat part une seule fois, en `structuredContent`, avec un `text` court. Le défaut reste `both`, pour les clients MCP qui ne lisent que `text`.

| Payload | Format | `read_processed` 4 ids × 1008 buckets × 3 agrégats | `read_raw` 60 480 échantillons |
|---|---|---|---|
| both | rows (avant) | 43,5 ms, 1 286 Kio | 473 ms, 28,4 Mio (491 o par échantillon) |
| both | columns | 30,9 ms, 554 Kio | 217 ms, 7,9 Mio (137 o) |
| structured | rows | 30,9 ms, 612 Kio | 260 ms, 13,4 Mio (232 o) |
| structured | columns | **26,4 ms, 277 Kio** | **131 ms, 3,9 Mio (67 o)** |

Ensemble, les deux divisent la taille par 4,6 (agrégats) et 7,4 (brut). Sur les agrégats, il ne reste presque que le calcul du store (16 ms) : le gain suivant viendra de l'agrégation native des backends (`GROUP BY` par tranche de temps, index `(id, t_ms)`), et le repli calculé par un routeur reste réservé aux petits volumes.

Un broker n'accepte qu'**un propriétaire par domaine** : deux slots ne peuvent pas déclarer `history`. Il y a donc un seul slot `history` par broker, et les slots de stockage restent derrière lui, protégés et sans déclaration.

## Backend SQLite

`@cyanmycelium/mcp-history-sqlite`, sur `better-sqlite3` 12 (Node 20 à 26), avec le schéma commun ci-dessus. Le temps est stocké en millisecondes epoch dans `t_ms`, `received_ms` et `source_ms`, et une table `history_meta` porte la version du schéma : un fichier d'une autre version est refusé.

- `count`, `min`, `max`, `sum`, `avg` et `goodRatio` sont calculés en SQL, en un `GROUP BY` par id. `first`, `last` et `timeWeightedAvg` passent par les fonctions de référence du contrat sur les lignes, seulement quand ils sont demandés. Les deux chemins donnent les mêmes valeurs : la conformité le vérifie.
- Mode WAL sur fichier : les lecteurs n'attendent jamais l'écrivain.

Mesures sur 241 920 échantillons (4 ids, une semaine à 10 s), 1 008 buckets de 10 minutes, format colonnes :

| Store | Ajout | `avg`, `min`, `max` | en plus `timeWeightedAvg` |
|---|---|---|---|
| mémoire | 829 ms | 17 ms | 17 ms |
| SQLite fichier, WAL | 1 806 ms | 116 ms | 185 ms |

SQLite paie la persistance. Au-delà de quelques semaines par requête, la réponse sera la question ouverte des pré-agrégats (rollups horaires), pas un autre moteur.

## Enregistreur (recorder)

C'est un composant séparé, client de `scada` et de `history`, et le seul principal qui reçoit `history.record`.

- **Configuration** : ids ou racines UNS, période, bande morte, historisation sur changement ou périodique.
- **Source** : `scada.read` en `max-age` en attendant que `subscribe` existe (phase 3 de SCADA).
- **Store-and-forward** : un tampon local, rejoué à la reconnexion. L'idempotence d'`append` rend ce rejeu sûr.

## Phasage

1. **Fait** : contrat, `MemoryHistoryStore`, `HistoryBehavior`, `HistorySlotStore`, `IAccessGuard` avec le mode broker, déclaration, suite de conformité. 81 tests, dont 5 contre un vrai broker.
2. **SQLite** : fait. `mcp-history-sqlite` passe la conformité en mémoire, sur fichier et à travers un slot. **Recorder** : `HistoryRecorder` sur le banc `motor01`, à faire.
3. **Routeur** : `RoutingHistoryStore` (routage UNS, agrégats de repli, `computedBy: "router"`), slots de stockage protégés.
4. **Performance** : fait, format colonnes et option `payload: "structured"`.
5. **InfluxDB, DuckDB, MySQL.**

## Questions ouvertes

- **InfluxDB** : comment garder deux échantillons au même instant (tag de réception ou décalage à la nanoseconde) ?
- **Rétention et pré-agrégats horaires** : gérés par le store ou par un job du slot ?
