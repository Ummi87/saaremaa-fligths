# Saaremaa lennujälgija

Staatiline kaardirakendus, mis näitab Saaremaa ümbruse õhuruumis nähtud lennukeid ning nende kuni 24-tunnist trajektoori. Leht töötab GitHub Pagesis; andmeid kogub GitHub Actions iga viie minuti tagant.

## Käivitamine kohapeal

Rakendus ei vaja paigaldamist. Ava projektikaust lihtsa HTTP-serveriga (näiteks VS Code Live Server) ja mine brauseris `index.html` lehele. Kaart kasutab OpenStreetMap tiile ning Leaflet laaditakse CDN-ist.

## GitHub Pagesi avaldamine

1. Loo GitHubis uus tühi repository ja laadi sellesse projekti failid `main` harule.
2. Repository seadetes ava **Settings → Pages** ning vali **Deploy from a branch**, haruks `main` ja kaustaks `/(root)`.
3. Ava **Settings → Actions → General** ja luba workflow'le repository kirjutamisõigus, kui see ei ole sinu organisatsioonis vaikimisi lubatud.
4. Käivita **Actions → Kogu lennuliikluse andmeid → Run workflow**, et esimene tegelik andmehetk kohe kätte saada.

## OpenSky seadistus

Töövoog töötab ka anonüümselt. Saaremaa vaikimisi bbox on 1,89 ruutkraadi ning OpenSky praeguse tabeli järgi maksab üks `/states/all` päring selles alas 1 krediidi. Iga viie minuti järel on maksimaalselt 288 krediiti päevas, mis jääb anonüümse 400-krediidise päevapiiri sisse.

Töökindlamaks kasutuseks loo OpenSky kontol API client ja lisa GitHub repository secrets'itesse:

- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`

Mõlema olemasolul kasutab skript OAuth2 client-credentials voogu. Saladusi ei lisata koodi ega commiti. OpenSky tokenid aeguvad 30 minuti järel; kuna töövoog käib igas jooksus eraldi, küsitakse iga jooksu alguses uus token.

## Piirangud

- ADS-B kaetus ei ole täielik: kõiki lennukeid ei pruugita näha.
- Päritolu ja sihtkoht ei ole reaalajas olekuandmetes usaldusväärselt saadaval ning kuvatakse MVP-s teadmata väärtusena.
- GitHub Actionsi ajastus võib koormuse ajal hilineda; viieminutiline intervall ei ole täpne garantii.
- Anonüümsed OpenSky päringud võivad GitHub Actionsi jagatud IP-aadressi tõttu ajuti ebaõnnestuda. Sellisel juhul jäetakse üks hetk vahele ning järgmine töövoog jätkub tavapäraselt.

## Allikad

- [OpenSky REST API dokumentatsioon](https://openskynetwork.github.io/opensky-api/rest.html)
- [OpenStreetMapi kasutustingimused](https://www.openstreetmap.org/copyright)
